// context-handoff for OpenCode: the same loop as the Claude Code plugin in this repo.
// At THRESHOLD% of the compaction window the agent is asked for a resume handoff; once it is written and
// the turn ends, the session is compacted and told to resume from it.
import { stat, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const THRESHOLD = Number(process.env.CONTEXT_HANDOFF_THRESHOLD ?? 80)
// The window a session may fill before compacting, as Claude Code's autoCompactWindow: 600k unless smaller.
const WINDOW_CAP = Number(process.env.CONTEXT_HANDOFF_WINDOW ?? 600000)
// Past this share of the window, compact even without a handoff, once the agent has been asked twice.
const HARD_PERCENT = 95
const REMIND_AFTER_STEPS = 30
const END_TURN_EVERY_STEPS = 10
const OUTPUT_TOKEN_MAX = 32000
// OpenCode's own background agents: their requests must not become the session's agent or model.
const INTERNAL_AGENTS = new Set(['compaction', 'title', 'summary'])

export const ContextHandoff = async ({ client }) => {
  const sessions = new Map()
  const home = process.env.HOME ?? '~'
  const epic = process.env.TRAYCER_EPIC_ID
  const agentId = process.env.TRAYCER_AGENT_ID
  const isTraycer = typeof epic === 'string' && epic !== ''

  const log = message =>
    client.app.log({ body: { service: 'context-handoff', level: 'info', message } }).catch(() => undefined)

  log(`loaded: threshold ${THRESHOLD}%, window cap ${WINDOW_CAP}, ${isTraycer ? `Traycer agent ${agentId}` : 'no Traycer epic'}`)

  const state = id => {
    let st = sessions.get(id)
    if (st === undefined) {
      st = { phase: 'armed', handoff: '', nudgedAt: 0, steps: 0, stepsSinceReady: 0, hasChased: false, tokens: 0, isChild: false }
      sessions.set(id, st)
    }
    return st
  }

  const windowOf = st => {
    if (st.context === undefined) return undefined
    const usable = st.input !== undefined ? st.input - 20000 : st.context - Math.min(st.output ?? OUTPUT_TOKEN_MAX, OUTPUT_TOKEN_MAX)
    return Math.min(usable, WINDOW_CAP)
  }
  const percentOf = st => {
    const window = windowOf(st)
    return window === undefined || st.tokens === 0 ? undefined : Math.round((st.tokens / window) * 100)
  }

  const locate = (st, id) => {
    st.handoff = isTraycer
      ? `${home}/.traycer/epics/${epic}/artifacts/session-handoff-${(agentId || id).slice(0, 8)}/index.md`
      : `${home}/.claude/handoffs/opencode-${id}.md`
  }

  const isWritten = async st => {
    if (st.handoff === '') return false
    const info = await stat(st.handoff).catch(() => undefined)
    return info !== undefined && info.isFile() && info.size > 200 && info.mtimeMs >= st.nudgedAt - 1000
  }

  const ask = (st, lead) =>
    [
      `[context-handoff] ${lead} Compaction keeps only part of the conversation and loses tool output detail.`,
      '',
      'Pause at the next safe point (no half-applied edit, no command still running), then write yourself a resume handoff at exactly this path, replacing any earlier one:',
      `  ${st.handoff}`,
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
      'When it is written, end your turn with the single line "Handoff written." Do not continue the task and do not message anyone about this pause: the session is compacted automatically and you are told to resume straight after.',
    ].join('\n')

  const resumeText = st =>
    `The context was compacted. Read your handoff at ${st.handoff} in full, then carry on from its next steps. If it says the task is finished or you are waiting on someone, do nothing more. Nobody is waiting for a reply to this message.`

  const prompt = (id, st, text) =>
    client.session
      .promptAsync({
        path: { id },
        body: { ...(st.agent ? { agent: st.agent } : {}), ...(st.model ? { model: st.model } : {}), parts: [{ type: 'text', text }] },
      })
      .catch(error => log(`prompt failed for ${id}: ${error}`))

  // At or past the threshold: returns the handoff request, once.
  const check = async (st, id) => {
    const percent = percentOf(st)
    if (percent === undefined) return undefined
    if (st.phase === 'cooling') {
      if (percent < THRESHOLD - 5) st.phase = 'armed'
      return undefined
    }
    if (st.phase !== 'armed' || percent < THRESHOLD) return undefined
    locate(st, id)
    if (!isTraycer) await mkdir(`${home}/.claude/handoffs`, { recursive: true }).catch(() => undefined)
    st.phase = 'nudged'
    st.nudgedAt = Date.now()
    st.steps = 0
    st.stepsSinceReady = 0
    st.hasChased = false
    log(`session ${id} at ${percent}% of ${windowOf(st)}: asked for a handoff at ${st.handoff}`)
    return ask(st, `This session's context is ${percent}% of its compaction window (${st.tokens.toLocaleString('en-US')} of ${windowOf(st).toLocaleString('en-US')} tokens) and will be compacted soon.`)
  }

  const afterStep = async (st, id) => {
    if (st.phase === 'ready') {
      st.stepsSinceReady += 1
      return st.stepsSinceReady % END_TURN_EVERY_STEPS === 0
        ? `[context-handoff] You have made ${st.stepsSinceReady} tool calls since writing the handoff at ${st.handoff}, and it does not cover them. Add what changed to it, then end your turn with the single line "Handoff written." so the session can compact.`
        : undefined
    }
    if (st.phase !== 'nudged') return check(st, id)
    if (await isWritten(st)) {
      st.phase = 'ready'
      st.stepsSinceReady = 0
      return `[context-handoff] Handoff found at ${st.handoff}. End your turn now with the single line "Handoff written."`
    }
    st.steps += 1
    return st.steps === REMIND_AFTER_STEPS
      ? `[context-handoff] Reminder: the handoff asked for earlier is still missing at ${st.handoff}. Pause at the next safe point and write it.`
      : undefined
  }

  const compact = async (st, id) => {
    if (st.phase === 'compacting' || st.model === undefined) return
    const before = st.phase
    st.phase = 'compacting'
    st.isOwn = true
    log(`compacting session ${id}`)
    const ran = await client.session
      .summarize({ path: { id }, body: { providerID: st.model.providerID, modelID: st.model.modelID } })
      .then(r => (r.error ? `${JSON.stringify(r.error)}` : undefined), error => String(error))
    if (ran !== undefined) {
      st.phase = before
      st.isOwn = false
      log(`compaction of ${id} failed: ${ran}`)
    }
  }

  const onIdle = async id => {
    const st = state(id)
    if (st.isChild || st.phase === 'compacting') return
    const now = Date.now()
    if (now - (st.lastIdle ?? 0) < 1500) return
    st.lastIdle = now
    if (st.phase === 'nudged' && (await isWritten(st))) st.phase = 'ready'
    if (st.phase === 'ready') return compact(st, id)
    if (st.phase === 'nudged') {
      if (!st.hasChased) {
        st.hasChased = true
        return prompt(id, st, `[context-handoff] The resume handoff asked for earlier is still missing. Write it now at ${st.handoff}, following the outline you were given, then end your turn with the single line "Handoff written." The session is compacted and resumed automatically after that.`)
      }
      // Asked twice and still nothing: past the hard limit, compact without it.
      if ((percentOf(st) ?? 0) >= HARD_PERCENT) return compact(st, id)
      return
    }
    const note = await check(st, id)
    if (note !== undefined) return prompt(id, st, note)
  }

  const onCompacted = async id => {
    const st = state(id)
    const hasHandoff = st.handoff !== '' && (await isWritten(st))
    const wasOwn = st.isOwn === true
    st.isOwn = false
    st.phase = 'cooling'
    st.tokens = 0
    if (wasOwn || hasHandoff) {
      log(`session ${id} compacted; sending the resume prompt`)
      setTimeout(() => void prompt(id, st, hasHandoff ? resumeText(st) : '[context-handoff] The context was compacted before a handoff was written. Re-read the files you were working on before editing them, then carry on.'), 500)
    }
  }

  // The agent has to read and write its own handoff, which sits outside the worktree. Some hosts answer
  // those permission asks with a rule that overrides user config, and nobody is there to approve, so the
  // plugin approves them itself. Narrow on purpose: only for a session this plugin is tracking, only for the
  // exact handoff file it assigned to that session (or that file's folder, as `external_directory` asks
  // for), and never when any path in the ask is unresolved or points elsewhere (relative paths are resolved against the session's own directory). (OpenCode 1.18
  // does not call the `permission.ask` plugin hook; it does emit `permission.asked`, so the reply goes
  // through the client.)
  const approveHandoffAsk = async ask => {
    const type = ask.permission ?? ask.type
    if (type !== 'external_directory' && type !== 'edit' && type !== 'read') return
    const st = sessions.get(ask.sessionID)
    if (st === undefined || st.isChild || st.handoff === '') return
    const file = st.handoff
    const folder = file.slice(0, file.lastIndexOf('/'))
    // An `edit` ask names its target relative to the session's directory; resolve it there, never guess.
    const toAbsolute = async path => {
      if (typeof path !== 'string') return undefined
      if (path.startsWith('/')) return resolve(path)
      st.directory ??= await client.session.get({ path: { id: ask.sessionID } }).then(r => r?.data?.directory, () => undefined)
      return typeof st.directory === 'string' && st.directory.startsWith('/') ? resolve(st.directory, path) : undefined
    }
    const asked = [ask.metadata?.filepath, ask.metadata?.parentDir, ...[].concat(ask.patterns ?? ask.pattern ?? [])].filter(path => path !== undefined)
    if (asked.length === 0) return
    const paths = await Promise.all(asked.map(toAbsolute))
    const allowed = path => path === file || path === folder || path === `${folder}/*`
    if (!paths.every(path => path !== undefined && allowed(path))) return
    if (!paths.some(path => path === file)) return
    const result = await client.postSessionIdPermissionsPermissionId({ path: { id: ask.sessionID, permissionID: ask.id }, body: { response: 'once' } })
      .then(r => (r?.error ? JSON.stringify(r.error) : undefined), error => String(error))
    log(result === undefined ? `approved ${type} ask for the handoff file ${file}` : `could not approve ${type} ask for ${file}: ${result}`)
  }

  return {
    'chat.message': async input => {
      const st = state(input.sessionID)
      if (INTERNAL_AGENTS.has(input.agent ?? '')) return
      if (input.agent) st.agent = input.agent
      if (input.model) st.model = { providerID: input.model.providerID, modelID: input.model.modelID }
    },
    'chat.params': async input => {
      const st = state(input.sessionID)
      if (INTERNAL_AGENTS.has(input.agent ?? '')) return
      const limit = input.model?.limit
      if (limit) {
        st.context = limit.context
        st.output = limit.output
        st.input = limit.input
      }
      if (input.agent) st.agent = input.agent
      if (input.model?.id) st.model = { providerID: input.model.providerID ?? input.provider?.info?.id, modelID: input.model.id }
    },
    'tool.execute.after': async (input, output) => {
      const st = state(input.sessionID)
      if (st.isChild) return
      const note = await afterStep(st, input.sessionID).catch(() => undefined)
      if (note !== undefined) output.output = `${output.output ?? ''}\n\n${note}`
    },
    'experimental.session.compacting': async (input, output) => {
      const st = state(input.sessionID)
      if (st.handoff !== '' && (await isWritten(st))) output.context.push(`A resume handoff was written to ${st.handoff}. Keep that path in the summary.`)
    },
    'experimental.compaction.autocontinue': async (input, output) => {
      const st = state(input.sessionID)
      // The resume prompt replaces OpenCode's own "continue" when there is a handoff to resume from.
      if (st.isOwn === true || (st.handoff !== '' && (await isWritten(st)))) output.enabled = false
    },
    event: async ({ event }) => {
      const p = event.properties ?? {}
      if (event.type === 'permission.asked' || event.type === 'permission.updated') {
        await approveHandoffAsk(p).catch(error => log(`permission handling failed: ${error}`))
        return
      }
      if (event.type === 'session.created' || event.type === 'session.updated') {
        if (p.info?.parentID) state(p.info.id).isChild = true
      } else if (event.type === 'message.updated') {
        const info = p.info
        if (info?.role === 'assistant' && info.tokens && info.time?.completed && !info.summary) {
          const t = info.tokens
          const total = (t.input ?? 0) + (t.output ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
          if (total > 0) state(info.sessionID).tokens = total
          if (info.providerID && info.modelID) state(info.sessionID).model ??= { providerID: info.providerID, modelID: info.modelID }
        }
      } else if (event.type === 'session.idle' || (event.type === 'session.status' && p.status?.type === 'idle')) {
        // Newer OpenCode reports the end of a turn as a status change; older releases as session.idle.
        await onIdle(p.sessionID).catch(error => log(`idle handling failed: ${error}`))
      } else if (event.type === 'session.compacted') {
        await onCompacted(p.sessionID).catch(error => log(`compacted handling failed: ${error}`))
      } else if (event.type === 'session.deleted') {
        sessions.delete(p.info?.id)
      }
    },
  }
}
