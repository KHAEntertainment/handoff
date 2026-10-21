import type { CommandRunResult, EngineInterface, Register, SessionMessage } from 'claude-code'

// armed: watching the fill. nudged: handoff asked for. ready: handoff on disk.
// cooling: just compacted, waiting for the fill to drop before watching again.
type Phase = 'armed' | 'nudged' | 'ready' | 'cooling'

const REMIND_AFTER_STEPS = 30
const END_TURN_EVERY_STEPS = 10
const COMPACT_RETRIES = 5
const DIGEST_FILES = 25
const DIGEST_COMMANDS = 8
// Marks a compaction this mod started, so its own hook lets it through.
const OWN_COMPACT = 'A resume handoff was just written to'

let threshold = 80
let isAuto = true

let phase: Phase = 'armed'
let nudgedAt = 0
let stepsSinceNudge = 0
let hasChased = false
// Tool calls made after the handoff was found: work the handoff does not cover.
let stepsSinceReady = 0
let handoff = ''
let isTraycer = false
let isCompacting = false
// Set while a compaction this mod queued through the command is still to arrive.
let isOwnPending = false
// Set while a /compact the command.run hook already decided is running, so session.compact does not decide it again.
let isRouted = false
// Set when session.compact reached this mod inside a routed /compact and the compaction was installed.
let isRoutedInstalled = false
// The compaction window can be smaller than the model's, so measure against it.
let limit: { window: number; tokens: number } | undefined
// When the last compaction finished, for ignoring a stray /compact right after it.
let lastCompactAt = 0
const RECENT_COMPACT_MS = 15 * 60 * 1000
const MAX_LOGGED = 50
const compactLog: unknown[] = []

async function fill($: EngineInterface) {
  const { context } = await $.session.usage()
  if (context.tokens === undefined) return undefined
  if (limit?.window !== context.window) {
    limit = { window: context.window, tokens: context.window }
    const full = await $.session.usage({ breakdown: 'summary' }).catch(() => undefined)
    const raw = full?.context.breakdown?.rawMaxTokens
    if (raw !== undefined && raw > 0 && raw < context.window) limit.tokens = raw
  }
  return { tokens: context.tokens, of: limit.tokens, percent: Math.round((context.tokens / limit.tokens) * 100) }
}

async function locate($: EngineInterface) {
  const home = (await $.env.get('HOME')) ?? '~'
  const epic = await $.env.get('TRAYCER_EPIC_ID')
  const session = await $.session.id().catch(() => 'session')
  isTraycer = epic !== undefined && epic !== ''
  if (isTraycer) {
    const agent = (await $.env.get('TRAYCER_AGENT_ID')) ?? session
    handoff = `${home}/.traycer/epics/${epic}/artifacts/session-handoff-${agent.slice(0, 8)}/index.md`
  } else {
    handoff = `${home}/.claude/handoffs/${session}.md`
  }
}

async function isWritten($: EngineInterface) {
  if (handoff === '') return false
  const stat = await $.fs.stat(handoff).catch(() => undefined)
  return stat !== undefined && stat.kind === 'file' && stat.size > 200 && stat.mtimeMs >= nudgedAt - 1000
}

const fullness = (percent: number, tokens: number, of: number) =>
  `This session's context window is ${percent}% full (${tokens.toLocaleString('en-US')} of ${of.toLocaleString('en-US')} tokens) and will be compacted soon.`

const ask = (lead: string) =>
  [
    `[context-handoff] ${lead} Compaction keeps the conversation text only in part and drops tool inputs and outputs entirely.`,
    '',
    `Pause at the next safe point (no half-applied edit, no command still running), then write yourself a resume handoff at exactly this path, replacing any earlier one:`,
    `  ${handoff}`,
    isTraycer
      ? 'That is a Traycer artifact: start it with frontmatter `kind: spec` and `title: "Session handoff: <task>"`.'
      : 'Create the folder if it is missing.',
    '',
    'Write it for a reader who has none of this conversation:',
    '1. Goal: the end state, who asked for it, and any reply you still owe (agent id, responseId).',
    '2. State now: what is done and verified, what is half-done, and the exact step you paused at.',
    '3. In play: files, branch or worktree, uncommitted changes, PRs, tickets, artifacts, with paths.',
    '4. Tried and ruled out: each approach that failed, and why.',
    '5. Next steps: ordered and concrete, with paths and commands, so step 1 can start at once.',
    '6. Must survive: instructions and constraints from the user or orchestrator, things not to do, steps only the owner may take, waits or timers in progress.',
    'Point to what git or a file already records rather than copying it.',
    '',
    isAuto
      ? 'When it is written, end your turn with the single line "Handoff written." Do not continue the task and do not message anyone about this pause: the session is compacted automatically and you are told to resume straight after.'
      : 'When it is written, tell the user it is ready so they can compact, then wait.',
  ].join('\n')

// The i-have-adhd plugin's always-on marker. While it exists, a compaction ends with a reminder to follow
// the rules: its full ruleset is injected at session start, then buried under other injections.
const ADHD_REMINDER =
  'ADHD mode is active: follow the i-have-adhd rules (start with the next action, number the steps, end with one next action).'

async function adhdReminder($: EngineInterface): Promise<string | undefined> {
  try {
    const home = (await $.env.get('HOME')) ?? '~'
    await $.fs.stat(`${home}/.claude/.i-have-adhd-always`)
    return ADHD_REMINDER
  } catch {
    return undefined
  }
}

const pointer = () =>
  `[context-handoff] The context was just compacted. Your resume handoff is at ${handoff}. Read it in full before doing anything else.`

// A compaction finished lately and the window is well under the threshold: nothing worth a handoff.
async function justCompacted($: EngineInterface) {
  if (lastCompactAt === 0 || (await $.clock.now()) - lastCompactAt > RECENT_COMPACT_MS) return false
  const now = await fill($).catch(() => undefined)
  return now !== undefined && now.percent < threshold - 5
}

// Every compact event the mod sees, kept in ~/.claude/handoffs/.compact-events-<session>.json, so a
// compaction nobody asked for can be traced to its source. Best effort: never fails the compaction.
async function logCompact($: EngineInterface, e: { trigger?: string; instructions?: string }, outcome: string) {
  try {
    const home = (await $.env.get('HOME')) ?? '~'
    const session = await $.session.id().catch(() => 'session')
    const now = await fill($).catch(() => undefined)
    compactLog.push({
      at: await $.clock.now(),
      outcome,
      trigger: e.trigger,
      instructionChars: (e.instructions ?? '').length,
      eventKeys: Object.keys(e),
      phase,
      isCompacting,
      isOwnPending,
      fillPercent: now?.percent,
      sinceLastCompactMs: lastCompactAt === 0 ? null : (await $.clock.now()) - lastCompactAt,
    })
    if (compactLog.length > MAX_LOGGED) compactLog.shift()
    await $.fs.write(`${home}/.claude/handoffs/.compact-events-${session.slice(0, 8)}.json`, JSON.stringify(compactLog, null, 1))
  } catch {
    // diagnostics only
  }
}

async function check($: EngineInterface) {
  if (phase !== 'armed' && phase !== 'cooling') return undefined
  const now = await fill($)
  if (now === undefined) return undefined
  if (phase === 'cooling') {
    if (now.percent < threshold - 5) phase = 'armed'
    return undefined
  }
  if (now.percent < threshold) return undefined
  await locate($)
  phase = 'nudged'
  nudgedAt = await $.clock.now()
  stepsSinceNudge = 0
  hasChased = false
  stepsSinceReady = 0
  $.ui.log(`context ${now.percent}% full: asked for a handoff at ${handoff}`)
  return ask(fullness(now.percent, now.tokens, now.of))
}

async function afterStep($: EngineInterface) {
  if (phase === 'ready') {
    stepsSinceReady += 1
    return isAuto && stepsSinceReady % END_TURN_EVERY_STEPS === 0
      ? `[context-handoff] You have made ${stepsSinceReady} tool calls since writing the handoff at ${handoff}, and it does not cover them. Add what changed to it, then end your turn with the single line "Handoff written." so the session can compact.`
      : undefined
  }
  if (phase !== 'nudged') return check($)
  if (await isWritten($)) {
    phase = 'ready'
    stepsSinceReady = 0
    return isAuto
      ? `[context-handoff] Handoff found at ${handoff}. End your turn now with the single line "Handoff written."`
      : `[context-handoff] Handoff found at ${handoff}. Tell the user it is ready to compact.`
  }
  stepsSinceNudge += 1
  return stepsSinceNudge === REMIND_AFTER_STEPS
    ? `[context-handoff] Reminder: the handoff asked for earlier is still missing at ${handoff}. Pause at the next safe point and write it.`
    : undefined
}

async function compactAndResume($: EngineInterface, attempt: number): Promise<void> {
  if (phase !== 'ready' || isCompacting) return
  const instructions = `${OWN_COMPACT} ${handoff}. Keep that path in the summary.`
  isCompacting = true
  let failure: string | undefined
  let skipped: string | undefined
  try {
    skipped = (await $.session.compact({ instructions })).skip
  } catch (error) {
    failure = String(error)
  }
  // A headless session (the SDK, a Traycer agent) compacts only through the command.
  if (failure !== undefined && /headless/.test(failure)) {
    isOwnPending = true
    failure = await $.command.run({ command: 'compact', args: instructions }).then(
      () => undefined,
      (error: unknown) => String(error),
    )
  }
  isCompacting = false
  if (failure !== undefined) {
    // Usually a turn is running: someone prompted first. Try again once it may have ended.
    isOwnPending = false
    if (attempt < COMPACT_RETRIES) $.clock.after(3000, () => void compactAndResume($, attempt + 1))
    else $.ui.log(`could not compact (${failure}); the handoff stays at ${handoff}`)
    return
  }
  if (skipped !== undefined) {
    $.ui.log(`compaction did not run (${skipped}); the handoff stays at ${handoff}`)
    return
  }
  phase = 'cooling'
  lastCompactAt = await $.clock.now()
  const reminder = await adhdReminder($)
  await $.prompt.submit({
    text: `The context was compacted. Read your handoff at ${handoff} in full, then carry on from its next steps. If it says the task is finished or you are waiting on someone, do nothing more. Nobody is waiting for a reply to this message.${reminder === undefined ? '' : ` ${reminder}`}`,
  })
}

// What the tool calls before a compaction touched: all of them, or only the last few.
const digest = (messages: readonly SessionMessage[], last?: number) => {
  const all = messages.flatMap(message => message.toolUses)
  const uses = last === undefined ? all : all.slice(-last)
  const files: string[] = []
  const commands: string[] = []
  for (const use of uses) {
    const path = use.input.file_path ?? use.input.notebook_path
    if (typeof path === 'string' && /^(Edit|Write|NotebookEdit)$/.test(use.tool)) {
      const at = files.indexOf(path)
      if (at >= 0) files.splice(at, 1)
      files.push(path)
    }
    if (use.tool === 'Bash' && typeof use.input.command === 'string') commands.push(use.input.command)
  }
  if (files.length === 0 && commands.length === 0) return undefined
  return [
    ...(files.length > 0 ? ['Files written or edited (most recent last):', ...files.slice(-DIGEST_FILES).map(f => `  ${f}`)] : []),
    ...(commands.length > 0
      ? ['Last shell commands:', ...commands.slice(-DIGEST_COMMANDS).map(c => `  ${c.replace(/\s+/g, ' ').slice(0, 240)}`)]
      : []),
  ].join('\n')
}

// Command output is shown under the names of the plugins hooking the command, so these carry no name of their own.
// With autoCompact off nothing compacts by itself: the agent tells the user and the user types /compact again.
const held = () =>
  isAuto
    ? 'Compaction postponed until the handoff is written; it compacts by itself after that. Type /compact now to compact at once.'
    : 'Compaction postponed until the handoff is written; type /compact again once it is ready. Type /compact now to compact at once.'
const IGNORED = 'Ignored a /compact right after a compaction (the context is nearly empty). Type /compact now to force one.'

// Only the person's Enter is stamped `composer`. From anywhere else it may not be the user, so the prompt does not say it was.
const leadFor = (typed: string, isPerson: boolean) => {
  if (typed === '')
    return isPerson
      ? 'The user asked to compact this session.'
      : 'A /compact command arrived for this session. The mod cannot tell whether the user typed it. If it looks spurious (for example right after a compaction, with little context used), say so and carry on instead of writing a handoff.'
  return isPerson
    ? `The user asked to compact this session, with these instructions for it: "${typed}".`
    : `A /compact command arrived for this session, with these instructions for it: "${typed}". The mod cannot tell whether the user typed it.`
}

// A compaction held for a handoff: the request goes out as a prompt of its own, once the skip reply has landed.
async function askFirst($: EngineInterface, lead: string) {
  await locate($)
  phase = 'nudged'
  nudgedAt = await $.clock.now()
  stepsSinceNudge = 0
  stepsSinceReady = 0
  hasChased = false
  $.clock.after(500, () => void $.prompt.submit({ text: ask(lead) }))
}

async function routed<T>(run: () => Promise<T>) {
  isRouted = true
  isRoutedInstalled = false
  try {
    return await run()
  } finally {
    isRouted = false
  }
}

// What a compaction this mod did not start leaves for the agent to read afterwards.
const noteFor = (hasHandoff: boolean, messages: readonly SessionMessage[]) => {
  if (!hasHandoff) {
    const record = digest(messages)
    return record === undefined
      ? undefined
      : `[context-handoff] The context was compacted before a handoff was written. This is a mechanical record of the tool work before it, not a summary of intent:\n${record}\nRead a file again before you edit it.`
  }
  if (stepsSinceReady === 0) return pointer()
  const since = digest(messages, stepsSinceReady)
  return [
    pointer(),
    `It predates your last ${stepsSinceReady} tool calls, so it does not cover them.`,
    ...(since === undefined ? [] : ['A mechanical record of that later work:', since]),
    'Read a file again before you edit it.',
  ].join('\n')
}

// After a compaction this mod did not start: wait for the fill to drop, send the ADHD reminder, return the note.
async function afterOther($: EngineInterface, hasHandoff: boolean, messages: readonly SessionMessage[]) {
  const note = noteFor(hasHandoff, messages)
  phase = 'cooling'
  lastCompactAt = await $.clock.now()
  // The compaction gets no resume prompt, so the reminder is sent on its own, after the session-start
  // injections. It is a prompt of its own, so the agent answers it.
  const reminder = await adhdReminder($)
  if (reminder !== undefined) {
    const text = `[context-handoff] The context was compacted. ${reminder} Nobody is waiting for a reply to this message: if you were mid-task, carry on; otherwise answer in one line.`
    $.clock.after(750, () => void $.prompt.submit({ text }))
  }
  return note
}

// A typed /compact let through: run it, then leave the note as the command's context, read after the summary.
async function compactTyped($: EngineInterface, run: () => Promise<CommandRunResult>, hasHandoff: boolean) {
  const before = await $.session.messages().catch(() => [] as SessionMessage[])
  const done = await routed(run)
  // Only the engine's own word says it compacted: session.compact installing messages where it still reaches this
  // mod, else the command's output ("Compacted · 418,794 → 33,070 tokens"; a skip reads "Not compacted · ...").
  if (!isRoutedInstalled && !/^Compacted\b/.test(done.text ?? '')) return done
  const note = await afterOther($, hasHandoff, before)
  return note === undefined ? done : { ...done, context: [...(done.context ?? []), note] }
}

export const register: Register = (on, options) => {
  threshold = typeof options.thresholdPercent === 'number' ? options.thresholdPercent : 80
  isAuto = options.autoCompact !== false

  // One small file naming the last session that loaded the mod: the only sign outside the debug log.
  on('session.start', async ($, e, next) => {
    const home = (await $.env.get('HOME')) ?? '~'
    const loaded = { session: await $.session.id(), agent: await $.env.get('TRAYCER_AGENT_ID'), at: await $.clock.now(), threshold, isAuto }
    await $.fs.write(`${home}/.claude/handoffs/.last-loaded.json`, JSON.stringify(loaded)).catch(() => undefined)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined || ran.deny !== undefined) return ran
    const note = await afterStep($).catch(() => undefined)
    return note === undefined ? ran : { ...ran, context: [...(ran.context ?? []), note] }
  })

  on('prompt.submit', async ($, e, next) => {
    const note = await check($).catch(() => undefined)
    return note === undefined ? next(e) : next({ ...e, context: [...(e.context ?? []), note] })
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer') return done
    if (phase === 'nudged' && (await isWritten($))) phase = 'ready'
    if (phase === 'ready' && isAuto) $.clock.after(750, () => void compactAndResume($, 1))
    // The turn ended with the handoff still missing: ask once more, as a prompt of its own.
    if (phase === 'nudged' && isAuto && !hasChased) {
      hasChased = true
      const text = `The resume handoff asked for earlier is still missing. Write it now at ${handoff}, following the outline you were given, then end your turn with the single line "Handoff written." The session is compacted and resumed automatically after that.`
      $.clock.after(750, () => void $.prompt.submit({ text }))
    }
    return done
  })

  // A typed /compact. Since Claude Code 2.1.301 the built-in cc-plugin-sec-default hands session.compact past
  // user plugins, so this is where the command is held; session.compact below covers the rest where it still fires.
  on('command.run', { command: 'compact' }, async ($, e, next) => {
    const typed = e.args.trim()
    // A build that leaves origin out fails open: the command is treated as from an unknown source.
    const origin: string | undefined = e.origin?.kind
    const seen = { trigger: `command:${origin ?? 'unknown'}`, instructions: e.args }
    if (origin === 'plugin' && typed.includes(OWN_COMPACT)) {
      // This mod's own headless fallback, maybe queued until now: the one place it is cleared on success.
      await logCompact($, seen, 'own')
      isOwnPending = false
      return routed(() => next(e))
    }
    const hasHandoff = (phase === 'nudged' || phase === 'ready') && (await isWritten($))
    if (/^now\b/i.test(typed)) {
      // `/compact now` skips waiting for a handoff, but one already on disk is still pointed at.
      await logCompact($, seen, 'now')
      const args = typed.replace(/^now\b[\s:,-]*/i, '')
      return compactTyped($, () => next({ ...e, args }), hasHandoff)
    }
    if (hasHandoff) {
      await logCompact($, seen, 'handoff on disk')
      return compactTyped($, () => next(e), true)
    }
    if (typed === '' && (await justCompacted($))) {
      // See session.compact below: a stray bare /compact right after a compaction is not worth a handoff.
      await logCompact($, seen, 'ignored: just compacted')
      $.ui.log('ignored a bare /compact right after a compaction; the context is well under the threshold')
      return { text: IGNORED }
    }
    await logCompact($, seen, 'asked for a handoff')
    await askFirst($, leadFor(typed, origin === 'composer'))
    return { text: held() }
  })

  // Any compaction this mod did not start: the threshold's, or a typed /compact.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)
    if (isRouted) {
      await logCompact($, e, 'routed')
      const done = await next(e)
      if (done.messages !== undefined) isRoutedInstalled = true
      return done
    }
    if (isCompacting || isOwnPending || (e.instructions ?? '').includes(OWN_COMPACT)) {
      await logCompact($, e, 'own')
      isOwnPending = false
      return next(e)
    }
    const hasHandoff = (phase === 'nudged' || phase === 'ready') && (await isWritten($))
    let pass = e
    if (e.trigger === 'manual') {
      const typed = (e.instructions ?? '').trim()
      if (/^now\b/i.test(typed)) {
        await logCompact($, e, 'now')
        // `/compact now`: compact at once, whatever follows "now" kept as the instructions.
        const { instructions: _, ...rest } = e
        const kept = typed.replace(/^now\b[\s:,-]*/i, '')
        pass = kept === '' ? rest : { ...rest, instructions: kept }
      } else if (!hasHandoff && typed === '' && (await justCompacted($))) {
        // A bare /compact right after a compaction, with the context nearly empty: one arrived 2s after our
        // own compaction, source unexplained. It is not worth a handoff.
        await logCompact($, e, 'ignored: just compacted')
        $.ui.log('ignored a bare /compact right after a compaction; the context is well under the threshold')
        return { skip: 'context-handoff: ignored a /compact right after a compaction (the context is nearly empty). Type /compact now to force one.' }
      } else if (!hasHandoff) {
        await logCompact($, e, 'asked for a handoff')
        // This event carries no origin, so the prompt never says the user asked: only command.run can tell.
        await askFirst($, leadFor(typed, false))
        return { skip: `context-handoff: ${held()}` }
      }
    }
    const done = await next(pass)
    if (done.messages === undefined) return done
    const note = await afterOther($, hasHandoff, e.messages)
    if (note === undefined) return done
    const added: SessionMessage = { role: 'user', text: note, toolUses: [] }
    const first = done.messages[0]
    const at = first !== undefined && first.role === 'user' && first.toolUses.length === 0 ? 1 : 0
    return { ...done, messages: [...done.messages.slice(0, at), added, ...done.messages.slice(at)] }
  })
}
