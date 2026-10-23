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
        found = re.search(rb'^\s*model_auto_compact_token_limit\s*=\s*(\d+)\s*(?:#.*)?$', raw, re.M)
        return int(found.group(1)) if found else None
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


def fill(transcript):
    """The newest token_count record: the tokens the last request was answered over, and the window."""
    if not transcript:
        return None
    size = os.path.getsize(transcript)
    with open(transcript, 'rb') as f:
        f.seek(max(0, size - 3_000_000))
        lines = f.read().decode('utf-8', 'ignore').splitlines()
    for line in reversed(lines):
        if '"token_count"' not in line:
            continue
        try:
            info = json.loads(line)['payload']['info']
        except Exception:
            continue
        if not info:
            continue
        return info['last_token_usage']['total_tokens'], info.get('model_context_window')
    return None


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
