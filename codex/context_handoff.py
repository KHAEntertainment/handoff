#!/usr/bin/env python3
"""context-handoff for Codex: the same idea as the Claude Code plugin in this repo.

Codex hooks cannot start a compaction, so this version asks for the handoff close to Codex's own
auto-compact limit, has the agent keep working and keep the handoff current, and points the agent
at it once Codex compacts. A manual /compact with no handoff on disk is held once, and the next
prompt asks for the handoff; running /compact again lets it through.

  post-tool      PostToolUse: watch the context fill, ask for the handoff, keep it current
  stop           Stop: ask once more if the turn ends with the handoff still missing
  pre-compact    PreCompact: hold a manual /compact once while no handoff exists
  prompt         UserPromptSubmit: after a hold, ask for the handoff
  session-start  SessionStart (compact): point the agent at the handoff
"""
import glob, json, os, re, sys, time

THRESHOLD = float(os.environ.get('CONTEXT_HANDOFF_CODEX_THRESHOLD', 90))
REMIND_AFTER_STEPS = 30
REFRESH_EVERY_STEPS = 15
HOME = os.path.expanduser('~')
CODEX_HOME = os.environ.get('CODEX_HOME') or os.path.join(HOME, '.codex')
STATE_DIR = os.path.join(HOME, '.codex', 'context-handoff')
EPIC = os.environ.get('TRAYCER_EPIC_ID') or ''
AGENT = os.environ.get('TRAYCER_AGENT_ID') or ''


def emit(event, context):
    print(json.dumps({'hookSpecificOutput': {'hookEventName': event, 'additionalContext': context}}))


def load(sid):
    try:
        with open(os.path.join(STATE_DIR, f'{sid}.json')) as f:
            return json.load(f)
    except Exception:
        return {'phase': 'armed', 'handoff': '', 'nudged_at': 0, 'steps': 0, 'since_ready': 0, 'chased': False, 'held': False, 'asked': False}


def save(sid, st):
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = os.path.join(STATE_DIR, f'.{sid}.tmp')
    with open(tmp, 'w') as f:
        json.dump(st, f)
    os.replace(tmp, os.path.join(STATE_DIR, f'{sid}.json'))


def config_limit():
    """model_auto_compact_token_limit from $CODEX_HOME/config.toml. tomllib is 3.11+, so 3.9 reads it with a regex."""
    try:
        with open(os.path.join(CODEX_HOME, 'config.toml'), 'rb') as f:
            raw = f.read()
    except OSError:
        return None
    try:
        import tomllib
    except ImportError:
        # Top-level assignments only: a key under [profiles.x] or any other table is not the one Codex reads.
        for line in raw.decode(errors='replace').splitlines():
            if line.lstrip().startswith('['):
                return None
            found = re.match(r'\s*model_auto_compact_token_limit\s*=\s*(\d+(?:_\d+)*)\s*(?:#.*)?$', line)
            if found:
                return int(found.group(1).replace('_', ''))
        return None
    try:
        return tomllib.loads(raw.decode()).get('model_auto_compact_token_limit')
    except Exception:
        return None


def compact_limit(window):
    """Codex compacts at model_auto_compact_token_limit, capped by the model's own window."""
    limit = config_limit()
    candidates = [v for v in (limit, int(window * 0.9) if window else None) if v]
    return min(candidates) if candidates else None


def rollout(transcript, sid):
    """The session's rollout file. Codex passes it as transcript_path, but may send null."""
    if transcript and os.path.exists(transcript):
        return transcript
    found = glob.glob(os.path.join(CODEX_HOME, 'sessions', '*', '*', '*', f'rollout-*-{sid}.jsonl'))
    return max(found, key=os.path.getmtime) if found else None


def since_compaction(raw):
    """The rollout from its newest compacted record on, or all of it. Inside a JSON string the marker is escaped, so it cannot match."""
    end = len(raw)
    while True:
        at = raw.rfind(b'"compacted"', 0, end)
        if at < 0:
            return raw
        start = raw.rfind(b'\n', 0, at) + 1
        stop = raw.find(b'\n', at)
        try:
            if json.loads(raw[start:stop if stop >= 0 else len(raw)])['type'] == 'compacted':
                return raw[start:]
        except Exception:
            pass
        end = start


# Context Codex injects as user messages (codex-rs core/src/context, 0.163.0), by start and end marker.
CONTEXT_MARKERS = (
    ('# AGENTS.md instructions', '</INSTRUCTIONS>'),
    ('<environment_context>', '</environment_context>'),
    ('<skill>', '</skill>'),
    ('<hook_prompt', '</hook_prompt>'),
    ('<user_shell_command>', '</user_shell_command>'),
    ('<turn_aborted>', '</turn_aborted>'),
    ('<subagent_notification>', '</subagent_notification>'),
    ('<agent_message_board_notification>', '</agent_message_board_notification>'),
    ('<codex_internal_context', '</codex_internal_context>'),
    ('<goal_context>', '</goal_context>'),
)


def injected(text):
    text = text.strip().lower()
    return any(text.startswith(start.lower()) and text.endswith(end.lower()) for start, end in CONTEXT_MARKERS)


def instruction(payload):
    """An instruction boundary as Codex's is_user_turn_boundary sees it: an agent message, a user
    message that is not injected context, or an inter-agent instruction from the assistant.

    Each boundary adds the reasoning before it to the count, so a missed one undercounts. Any user
    message is a boundary unless one of its parts carries a known context marker pair: a context
    fragment missing from CONTEXT_MARKERS only makes the count higher."""
    if payload.get('type') == 'agent_message':
        return True
    if payload.get('type') != 'message':
        return False
    parts = [part for part in payload.get('content') or [] if isinstance(part, dict)]
    if payload.get('role') == 'user':
        return not any(injected(part.get('text') or '') for part in parts if part.get('type') == 'input_text')
    if payload.get('role') == 'assistant' and len(parts) == 1:
        try:
            sent = json.loads(parts[0].get('text') or '')
        except Exception:
            return False
        return isinstance(sent, dict) and {'author', 'recipient', 'content', 'trigger_turn'} <= sent.keys()
    return False


def fill(transcript):
    """The tokens Codex counts toward its auto-compact limit, and the window.

    The newest token_count record gives the tokens the last request was billed for. Codex's own count
    (get_total_token_usage in codex-rs context_manager/history.rs) also takes in the reasoning from
    before the newest instruction since the last compaction, which the API no longer bills, so that
    is added from its encrypted size at 4 bytes a token. On session 01a16a09 this ran about 50% over
    Codex's figure, which only makes the ask come early.
    """
    if not transcript:
        return None
    with open(transcript, 'rb') as f:
        raw = f.read()
    usage = window = None
    reasoning = earlier = 0
    for line in since_compaction(raw).splitlines():
        if not any(key in line for key in (b'"token_count"', b'"reasoning"', b'"message"', b'"agent_message"')):
            continue
        try:
            payload = json.loads(line)['payload']
        except Exception:
            continue
        kind = payload.get('type')
        if kind == 'reasoning':
            reasoning += len(payload.get('encrypted_content') or '')
        elif kind == 'token_count' and payload.get('info'):
            usage = payload['info']['last_token_usage']['total_tokens']
            window = payload['info'].get('model_context_window')
        elif instruction(payload):
            # Reasoning after the newest instruction is still sent back, so the last request billed it.
            earlier = reasoning
    if usage is None:
        return None
    return usage + earlier // 4, window


def locate(st, sid):
    if EPIC:
        st['handoff'] = f'{HOME}/.traycer/epics/{EPIC}/artifacts/session-handoff-{(AGENT or sid)[:8]}/index.md'
    else:
        os.makedirs(os.path.join(HOME, '.claude', 'handoffs'), exist_ok=True)
        st['handoff'] = f'{HOME}/.claude/handoffs/codex-{sid}.md'


def written(st):
    try:
        info = os.stat(st['handoff'])
    except Exception:
        return False
    return info.st_size > 200 and info.st_mtime >= st['nudged_at'] - 1


def ask(st, lead, held=False):
    then = ('Then stop and tell the user the handoff is written, so they can run /compact again. Do not message anyone else about this.'
            if held else
            'Then carry on with your task. Codex compacts this session on its own soon; until then, keep sections 2 and 5 of the handoff current as you work. Do not message anyone about this.')
    return '\n'.join([
        f'[context-handoff] {lead} Compaction keeps only part of the conversation and drops tool output detail.',
        '',
        'At the next safe point (no half-applied edit, no command still running), write yourself a resume handoff at exactly this path, replacing any earlier one:',
        f'  {st["handoff"]}',
        'That is a Traycer artifact: start it with frontmatter `kind: spec` and `title: "Session handoff: <task>"`.' if EPIC else 'Create the folder if it is missing.',
        '',
        'Write it for a reader who has none of this conversation:',
        '1. Goal: the end state, who asked for it, and any reply you still owe (agent id, responseId).',
        '2. State now: what is done and verified, what is half-done, and the exact step you are on.',
        '3. In play: files, branch or worktree, uncommitted changes, PRs, tickets, artifacts, with paths.',
        '4. Tried and ruled out: each approach that failed, and why.',
        '5. Next steps: ordered and concrete, with paths and commands, so step 1 can start at once.',
        '6. Must survive: instructions and constraints from the user or orchestrator, things not to do, steps only the owner may take, waits or timers in progress.',
        'Point to what git or a file already records rather than copying it.',
        '',
        then,
    ])


def post_tool(data):
    sid = data['session_id']
    if data.get('agent_id'):
        return
    st = load(sid)
    note = None
    if st['phase'] == 'ready':
        st['since_ready'] += 1
        if st['since_ready'] % REFRESH_EVERY_STEPS == 0:
            note = f'[context-handoff] {st["since_ready"]} tool calls since the handoff at {st["handoff"]} was last written. Update its "State now" and "Next steps" sections, then carry on.'
    elif st['phase'] == 'nudged':
        if written(st):
            st['phase'] = 'ready'
            st['since_ready'] = 0
            note = (f'[context-handoff] Handoff found at {st["handoff"]}. Tell the user it is written, so they can run /compact again.'
                    if st.get('held') else
                    f'[context-handoff] Handoff found at {st["handoff"]}. Carry on with your task and keep it current.')
        else:
            st['steps'] += 1
            if st['steps'] == REMIND_AFTER_STEPS:
                note = f'[context-handoff] Reminder: the handoff asked for earlier is still missing at {st["handoff"]}. Write it at the next safe point.'
    else:
        got = fill(rollout(data.get('transcript_path'), sid))
        if got:
            tokens, window = got
            limit = compact_limit(window)
            if limit:
                percent = round(tokens / limit * 100)
                if st['phase'] == 'cooling' and percent < THRESHOLD - 10:
                    st['phase'] = 'armed'
                elif st['phase'] == 'armed' and percent >= THRESHOLD:
                    locate(st, sid)
                    st.update(phase='nudged', nudged_at=time.time(), steps=0, since_ready=0, chased=False)
                    note = ask(st, f"This session's context is {percent}% of Codex's auto-compact limit ({tokens:,} of {limit:,} tokens).")
    save(sid, st)
    if note:
        emit('PostToolUse', note)


def stop(data):
    sid = data['session_id']
    st = load(sid)
    if data.get('agent_id') or st['phase'] != 'nudged' or st['chased'] or written(st):
        print('{}')
        return
    st['chased'] = True
    save(sid, st)
    then = 'then stop and tell the user it is written, so they can run /compact again' if st.get('held') else 'then finish what you were doing'
    print(json.dumps({'decision': 'block', 'reason': f'[context-handoff] The resume handoff asked for earlier is still missing. Write it now at {st["handoff"]}, following the outline you were given, {then}.'}))


def pre_compact(data):
    # Only a manual /compact is held: blocking an automatic one would abort the agent's working turn.
    if data.get('agent_id') or data.get('trigger') != 'manual':
        return
    sid = data['session_id']
    st = load(sid)
    if st.get('held') or (st['handoff'] and written(st)):
        # A handoff is on disk, or this /compact was already held once: let it through.
        return
    locate(st, sid)
    st.update(phase='nudged', nudged_at=time.time(), steps=0, since_ready=0, chased=False, held=True, asked=False)
    save(sid, st)
    print(json.dumps({'continue': False, 'stopReason': '[context-handoff] Compaction postponed: there is no resume handoff yet. Send any message and the agent writes one first, then run /compact again. Run /compact again now to compact without it.'}))


def prompt(data):
    sid = data['session_id']
    if data.get('agent_id'):
        return
    st = load(sid)
    if not st.get('held') or st.get('asked') or st['phase'] != 'nudged' or written(st):
        return
    st['asked'] = True
    save(sid, st)
    emit('UserPromptSubmit', ask(st, 'The user ran /compact. It is postponed until a resume handoff exists.', held=True))


def session_start(data):
    sid = data['session_id']
    if data.get('source') != 'compact':
        return
    st = load(sid)
    has = st['handoff'] and written(st)
    since = st.get('since_ready', 0)
    st.update(phase='cooling', steps=0, since_ready=0, chased=False, held=False, asked=False)
    save(sid, st)
    if has:
        tail = f' It was last updated about {since} tool calls before the compaction; anything after that is not in it.' if since else ''
        emit('SessionStart', f'[context-handoff] The context was just compacted. Your resume handoff is at {st["handoff"]}. Read it in full before doing anything else.{tail} Re-read any file before you edit it.')


def main():
    try:
        data = json.load(sys.stdin)
        {'post-tool': post_tool, 'stop': stop, 'pre-compact': pre_compact, 'prompt': prompt, 'session-start': session_start}[sys.argv[1]](data)
    except Exception as error:
        # A failing hook must never break the session: say why on stderr and pass.
        print(f'context-handoff: {error}', file=sys.stderr)
        if sys.argv[1:] == ['stop']:
            print('{}')


main()
