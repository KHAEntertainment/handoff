import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const usage = (on: On, tokens: number) =>
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens, window: 1_000_000, percent: Math.round(tokens / 10_000) }, rateLimits: [] } }))

const bash = (on: On) => {
  on('session.id', () => ({ value: 'sess-1' }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok' } }))
}

test('says nothing below the threshold', async ($, on) => {
  mock.env(on, { HOME: '/h' })
  mock.clock(on, { now: 5000 })
  usage(on, 400_000)
  bash(on)
  const ran = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(ran.context).toBeUndefined()
})

test('asks for a handoff once, at a path outside the repo', async ($, on) => {
  mock.env(on, { HOME: '/h' })
  mock.clock(on, { now: 5000 })
  usage(on, 850_000)
  bash(on)
  on('fs.stat', () => ({ deny: 'ENOENT' }))
  const first = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(first.context?.[0]).toMatch(/85% full/)
  expect(first.context?.[0]).toMatch(/\/h\/\.claude\/handoffs\/.+\.md/)
  const second = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(second.context).toBeUndefined()
})

test('under Traycer the handoff is an artifact of the epic', async ($, on) => {
  mock.env(on, { HOME: '/h', TRAYCER_EPIC_ID: 'epic-1', TRAYCER_AGENT_ID: 'abcdef1234567890' })
  mock.clock(on, { now: 5000 })
  usage(on, 850_000)
  bash(on)
  const ran = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(ran.context?.[0]).toMatch(/\/h\/\.traycer\/epics\/epic-1\/artifacts\/session-handoff-abcdef12\/index\.md/)
  expect(ran.context?.[0]).toMatch(/kind: spec/)
})

test('a subagent call is left alone', async ($, on) => {
  mock.env(on, { HOME: '/h' })
  mock.clock(on, { now: 5000 })
  usage(on, 900_000)
  bash(on)
  const ran = await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'sub-1' })
  expect(ran.context).toBeUndefined()
})

test('handoff written, turn ends: compacts, then sends the resume prompt', async ($, on) => {
  mock.env(on, { HOME: '/h' })
  const clock = mock.clock(on, { now: 5000 })
  usage(on, 850_000)
  bash(on)
  let isOnDisk = false
  on('fs.stat', () => {
    if (!isOnDisk) return { deny: 'ENOENT' }
    return { value: { kind: 'file' as const, size: 4000, mtimeMs: 6000, isLink: false } }
  })
  const compactions: (string | undefined)[] = []
  on('session.compact', (_, e) => {
    compactions.push(e.instructions)
    return { messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }] }
  })
  on('turn.complete', () => ({ text: '' }))
  on('ui.log', () => ({ value: undefined }))
  const prompts: string[] = []
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })

  await $.tool.call({ tool: 'Bash', command: 'ls' })
  isOnDisk = true
  const found = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(found.context?.[0]).toMatch(/Handoff found/)

  await $.turn.complete({ answer: 'Handoff written.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(compactions).toHaveLength(0)
  await clock.advance(800)
  expect(compactions).toHaveLength(1)
  expect(compactions[0]).toMatch(/\/h\/\.claude\/handoffs\//)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toMatch(/Read your handoff at \/h\/\.claude\/handoffs\//)
})

test('a compaction with no handoff gets a record of the tool work', async ($, on) => {
  mock.env(on, { HOME: '/h' })
  mock.clock(on, { now: 5000 })
  usage(on, 100_000)
  const summary = { role: 'user' as const, text: 'summary', toolUses: [], handle: 's' }
  on('session.compact', () => ({ messages: [summary] }))
  const done = await $.session.compact({
    trigger: 'auto',
    messages: [
      {
        role: 'assistant',
        text: '',
        toolUses: [
          { tool_use_id: 'a', tool: 'Edit', input: { file_path: '/repo/src/a.ts' } },
          { tool_use_id: 'b', tool: 'Bash', input: { command: 'npm test' } },
        ],
      },
    ],
  })
  expect(done.messages).toHaveLength(2)
  expect(done.messages?.[0]).toEqual(summary)
  expect(done.messages?.[1]?.text).toMatch(/\/repo\/src\/a\.ts/)
  expect(done.messages?.[1]?.text).toMatch(/npm test/)
})

test('a threshold compaction after the handoff points at it', async ($, on) => {
  mock.env(on, { HOME: '/h' })
  mock.clock(on, { now: 5000 })
  usage(on, 850_000)
  bash(on)
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 4000, mtimeMs: 6000, isLink: false } }))
  on('session.compact', () => ({ messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }] }))
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  const done = await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'go', toolUses: [] }] })
  expect(done.messages?.[1]?.text).toMatch(/resume handoff is at \/h\/\.claude\/handoffs\//)
})

test('turn ends with the handoff missing: asks once more as a prompt', async ($, on) => {
  mock.env(on, { HOME: '/h' })
  const clock = mock.clock(on, { now: 5000 })
  usage(on, 850_000)
  bash(on)
  on('fs.stat', () => ({ deny: 'ENOENT' }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.log', () => ({ value: undefined }))
  const prompts: string[] = []
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  const ended = { answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' as const }
  await $.turn.complete(ended)
  await clock.advance(800)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toMatch(/still missing/)
  await $.turn.complete({ ...ended, turnId: 't2' })
  await clock.advance(800)
  expect(prompts).toHaveLength(1)
})

test('work after the handoff: told every ten calls to update it and end the turn', async ($, on) => {
  mock.env(on, { HOME: '/h' })
  mock.clock(on, { now: 5000 })
  usage(on, 850_000)
  bash(on)
  on('ui.log', () => ({ value: undefined }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 4000, mtimeMs: 6000, isLink: false } }))
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  const found = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(found.context?.[0]).toMatch(/Handoff found/)
  for (let i = 1; i < 10; i += 1) expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).context).toBeUndefined()
  const tenth = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(tenth.context?.[0]).toMatch(/10 tool calls since writing the handoff/)
})

test('a threshold compaction after later work says the handoff is stale and lists that work', async ($, on) => {
  mock.env(on, { HOME: '/h' })
  mock.clock(on, { now: 5000 })
  usage(on, 850_000)
  bash(on)
  on('ui.log', () => ({ value: undefined }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 4000, mtimeMs: 6000, isLink: false } }))
  on('session.compact', () => ({ messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }] }))
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Bash', command: 'npm run build' })
  const done = await $.session.compact({
    trigger: 'auto',
    messages: [
      {
        role: 'assistant',
        text: '',
        toolUses: [
          { tool_use_id: 'a', tool: 'Bash', input: { command: 'old command' } },
          { tool_use_id: 'b', tool: 'Bash', input: { command: 'npm run build' } },
        ],
      },
    ],
  })
  const note = done.messages?.[1]?.text ?? ''
  expect(note).toMatch(/predates your last 1 tool calls/)
  expect(note).toMatch(/npm run build/)
  expect(note.includes('old command')).toBe(false)
})

const summary = { role: 'user' as const, text: 'summary', toolUses: [] }
const work = [{ role: 'user' as const, text: 'go', toolUses: [] }]

test('a typed /compact with no handoff asks for one, then compacts once it is written', async ($, on) => {
  mock.env(on, { HOME: '/h' })
  const clock = mock.clock(on, { now: 5000 })
  usage(on, 300_000)
  bash(on)
  on('ui.log', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  let isOnDisk = false
  on('fs.stat', () => (isOnDisk ? { value: { kind: 'file' as const, size: 4000, mtimeMs: 6000, isLink: false } } : { deny: 'ENOENT' }))
  const compactions: (string | undefined)[] = []
  on('session.compact', (_, e) => {
    compactions.push(e.instructions)
    return { messages: [summary] }
  })
  const prompts: string[] = []
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })

  const held = await $.session.compact({ trigger: 'manual', messages: work })
  expect(held.skip).toMatch(/\/compact now/)
  expect(compactions).toHaveLength(0)
  await clock.advance(600)
  expect(prompts[0]).toMatch(/A \/compact command arrived for this session\./)
  expect(prompts[0]).toMatch(/cannot tell whether the user typed it/)
  expect(prompts[0]).toMatch(/\/h\/\.claude\/handoffs\/sess-1\.md/)

  isOnDisk = true
  await $.turn.complete({ answer: 'Handoff written.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(800)
  expect(compactions).toHaveLength(1)
  expect(compactions[0]).toMatch(/A resume handoff was just written to/)
  expect(prompts[1]).toMatch(/Read your handoff/)
})

test('/compact now compacts at once and keeps what follows as the instructions', async ($, on) => {
  mock.env(on, { HOME: '/h' })
  mock.clock(on, { now: 5000 })
  usage(on, 300_000)
  bash(on)
  const compactions: (string | undefined)[] = []
  on('session.compact', (_, e) => {
    compactions.push(e.instructions)
    return { messages: [summary] }
  })
  const done = await $.session.compact({ trigger: 'manual', instructions: 'now keep the API notes', messages: work })
  expect(done.messages).toBeDefined()
  expect(compactions).toEqual(['keep the API notes'])
  await $.session.compact({ trigger: 'manual', instructions: 'now', messages: work })
  expect(compactions[1]).toBeUndefined()
})

test('a typed /compact after the handoff was written compacts and points at it', async ($, on) => {
  mock.env(on, { HOME: '/h' })
  mock.clock(on, { now: 5000 })
  usage(on, 850_000)
  bash(on)
  on('ui.log', () => ({ value: undefined }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 4000, mtimeMs: 6000, isLink: false } }))
  on('session.compact', () => ({ messages: [summary] }))
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  const done = await $.session.compact({ trigger: 'manual', messages: work })
  expect(done.messages?.[1]?.text).toMatch(/resume handoff is at/)
})

// A threshold compaction, then the fill drops to 6%: the setup for a stray /compact right after it.
const afterCompaction = async ($: any, on: On) => {
  mock.env(on, { HOME: '/h' })
  const clock = mock.clock(on, { now: 5000 })
  let tokens = 850_000
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens, window: 1_000_000, percent: Math.round(tokens / 10_000) }, rateLimits: [] } }))
  bash(on)
  on('ui.log', () => ({ value: undefined }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 4000, mtimeMs: 6000, isLink: false } }))
  const compactions: (string | undefined)[] = []
  on('session.compact', (_, e) => {
    compactions.push(e.instructions)
    return { messages: [summary] }
  })
  const prompts: string[] = []
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.session.compact({ trigger: 'manual', messages: work })
  tokens = 60_000
  return { clock, compactions, prompts }
}

test('a bare /compact right after a compaction, with the context nearly empty, is ignored', async ($, on) => {
  const { compactions, prompts } = await afterCompaction($, on)
  const stray = await $.session.compact({ trigger: 'manual', messages: work })
  expect(stray.skip).toMatch(/ignored a \/compact right after a compaction/)
  expect(compactions).toHaveLength(1)
  expect(prompts).toHaveLength(0)
})

test('a bare /compact long after a compaction still asks for a handoff', async ($, on) => {
  const { clock, prompts } = await afterCompaction($, on)
  await clock.advance(16 * 60 * 1000)
  const typed = await $.session.compact({ trigger: 'manual', messages: work })
  expect(typed.skip).toMatch(/Compaction postponed until the handoff is written/)
  await clock.advance(600)
  expect(prompts.some(p => /A \/compact command arrived/.test(p))).toBe(true)
})

test('a /compact with instructions right after a compaction asks for a handoff, without saying the user typed it', async ($, on) => {
  const { clock, prompts } = await afterCompaction($, on)
  const typed = await $.session.compact({ trigger: 'manual', instructions: 'keep the API notes', messages: work })
  expect(typed.skip).toMatch(/Compaction postponed until the handoff is written/)
  await clock.advance(600)
  expect(prompts.some(p => /A \/compact command arrived for this session, with these instructions for it: "keep the API notes"\. The mod cannot tell/.test(p))).toBe(true)
  expect(prompts.some(p => /The user asked/.test(p))).toBe(false)
})

test('/compact now still compacts right after a compaction', async ($, on) => {
  const { compactions } = await afterCompaction($, on)
  const done = await $.session.compact({ trigger: 'manual', instructions: 'now', messages: work })
  expect(done.messages).toBeDefined()
  expect(compactions).toHaveLength(2)
})

// The i-have-adhd marker: present or absent, other paths stat as a handoff on disk.
const withMarker = (on: On, isPresent: boolean) =>
  on('fs.stat', (_, e) =>
    e.path.endsWith('.i-have-adhd-always') && !isPresent
      ? { deny: 'ENOENT' }
      : { value: { kind: 'file' as const, size: 4000, mtimeMs: 6000, isLink: false } },
  )

const compactWith = async ($: any, on: On, isPresent: boolean, args: Record<string, unknown>) => {
  mock.env(on, { HOME: '/h' })
  const clock = mock.clock(on, { now: 5000 })
  usage(on, 850_000)
  bash(on)
  on('ui.log', () => ({ value: undefined }))
  withMarker(on, isPresent)
  on('session.compact', () => ({ messages: [summary] }))
  const prompts: string[] = []
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.session.compact({ messages: work, ...args })
  await clock.advance(800)
  return prompts
}

test('a compaction the mod did not start sends the ADHD reminder as its own prompt', async ($, on) => {
  const prompts = await compactWith($, on, true, { trigger: 'manual', instructions: 'now' })
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toMatch(/ADHD mode is active/)
  expect(prompts[0]).toMatch(/Nobody is waiting for a reply/)
})

test('without the ADHD marker no reminder prompt is sent', async ($, on) => {
  const prompts = await compactWith($, on, false, { trigger: 'manual', instructions: 'now' })
  expect(prompts).toHaveLength(0)
})

test('the mod\'s own resume prompt carries the ADHD reminder, once', async ($, on) => {
  mock.env(on, { HOME: '/h' })
  const clock = mock.clock(on, { now: 5000 })
  usage(on, 850_000)
  bash(on)
  on('ui.log', () => ({ value: undefined }))
  withMarker(on, true)
  on('session.compact', () => ({ messages: [summary] }))
  on('turn.complete', () => ({ text: '' }))
  const prompts: string[] = []
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.turn.complete({ answer: 'Handoff written.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(800)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toMatch(/Read your handoff at/)
  expect(prompts[0]).toMatch(/ADHD mode is active/)
})

// A typed /compact arrives as command.run. Since Claude Code 2.1.301 that is the only event the mod sees for it:
// the built-in cc-plugin-sec-default hands session.compact past user plugins.
const person = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } }
const sdk = { ...person, origin: { kind: 'sdk' as const } }
const toolWork = [
  { role: 'user' as const, text: 'go', toolUses: [] },
  {
    role: 'assistant' as const,
    text: '',
    toolUses: [
      { tool_use_id: 'a', tool: 'Edit', input: { file_path: '/repo/src/a.ts' } },
      { tool_use_id: 'b', tool: 'Bash', input: { command: 'npm test' } },
    ],
  },
]

// The engine's /compact, as the real one runs it: through session.compact (or past it, as the built-in
// cc-plugin-sec-default makes it in interactive sessions), reporting "Compacted · ..." or "Not compacted · ...".
type TypedOptions = {
  tokens?: number
  isOnDisk?: boolean
  isAdhd?: boolean
  isRefused?: boolean
  isBypassed?: boolean
  isSkippedBelow?: boolean
  coreContext?: string[]
  coreText?: string
  isUnreadable?: boolean
}
const typedSession = ($: any, on: On, opts: TypedOptions = {}) => {
  mock.env(on, { HOME: '/h' })
  const clock = mock.clock(on, { now: 5000 })
  const s = { tokens: opts.tokens ?? 300_000, isOnDisk: opts.isOnDisk ?? false, ran: [] as string[], inner: [] as any[], prompts: [] as string[], messages: toolWork as any[] }
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: s.tokens, window: 1_000_000, percent: Math.round(s.tokens / 10_000) }, rateLimits: [] } }))
  bash(on)
  on('ui.log', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  const file = { value: { kind: 'file' as const, size: 4000, mtimeMs: 6000, isLink: false } }
  on('fs.stat', (_, e) => (e.path.endsWith('.i-have-adhd-always') ? (opts.isAdhd ? file : { deny: 'ENOENT' }) : s.isOnDisk ? file : { deny: 'ENOENT' }))
  on('session.messages', () => (opts.isUnreadable ? { deny: 'unreadable' } : { value: s.messages }))
  on('session.compact', () => (opts.isSkippedBelow ? { skip: 'a PreCompact hook blocked it' } : { messages: [summary] }))
  const compacted = () => ({ text: opts.coreText ?? 'Compacted · 1,000 → 100 tokens', ...(opts.coreContext === undefined ? {} : { context: opts.coreContext }) })
  on('command.run', { command: 'compact' }, async (_, e) => {
    s.ran.push(e.args)
    if (opts.isRefused) return { text: 'Not compacted · not enough messages to compact' }
    if (opts.isBypassed) {
      // No session.compact reaches the mod, and the summary is as many rows as before.
      s.messages = [summary, { role: 'user' as const, text: 'kept', toolUses: [] }]
      return compacted()
    }
    const inner = await $.session.compact({ trigger: 'manual', instructions: e.args === '' ? undefined : e.args, messages: s.messages })
    s.inner.push(inner)
    if (inner.skip !== undefined) return { text: `Not compacted · ${inner.skip}` }
    s.messages = inner.messages
    return compacted()
  })
  on('prompt.submit', (_, e) => {
    s.prompts.push(e.text)
    return { text: e.text }
  })
  return { clock, s }
}

test('a /compact typed at the prompt with no handoff is postponed, asked for, then compacted', async ($, on) => {
  const { clock, s } = typedSession($, on)
  const held = await $.command.run({ command: 'compact', args: '', ...person })
  expect(held.text).toMatch(/Compaction postponed until the handoff is written/)
  expect(held.text).toMatch(/\/compact now/)
  expect(s.ran).toHaveLength(0)
  await clock.advance(600)
  expect(s.prompts[0]).toMatch(/The user asked to compact this session\./)
  expect(/cannot tell/.test(s.prompts[0] ?? '')).toBe(false)
  expect(s.prompts[0]).toMatch(/\/h\/\.claude\/handoffs\/sess-1\.md/)

  s.isOnDisk = true
  await $.turn.complete({ answer: 'Handoff written.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(800)
  expect(s.prompts[1]).toMatch(/Read your handoff/)
})

test('a bare /compact from the SDK is postponed too, without saying the user typed it', async ($, on) => {
  const { clock, s } = typedSession($, on)
  const held = await $.command.run({ command: 'compact', args: '', ...sdk })
  expect(held.text).toMatch(/postponed/)
  expect(s.ran).toHaveLength(0)
  await clock.advance(600)
  expect(s.prompts[0]).toMatch(/A \/compact command arrived for this session\./)
  expect(s.prompts[0]).toMatch(/cannot tell whether the user typed it/)
  expect(s.prompts[0]).toMatch(/looks spurious/)
})

test('a typed /compact with instructions is postponed and the instructions passed on as the user\'s', async ($, on) => {
  const { clock, s } = typedSession($, on)
  const held = await $.command.run({ command: 'compact', args: 'keep the API notes', ...person })
  expect(held.text).toMatch(/postponed/)
  expect(s.ran).toHaveLength(0)
  await clock.advance(600)
  expect(s.prompts[0]).toMatch(/The user asked to compact this session, with these instructions for it: "keep the API notes"/)
})

test('a /compact with instructions from the SDK passes them on, hedged', async ($, on) => {
  const { clock, s } = typedSession($, on)
  await $.command.run({ command: 'compact', args: 'keep the API notes', ...sdk })
  await clock.advance(600)
  expect(s.prompts[0]).toMatch(/A \/compact command arrived for this session, with these instructions for it: "keep the API notes"\. The mod cannot tell/)
  expect(/looks spurious/.test(s.prompts[0] ?? '')).toBe(false)
})

test('a typed /compact now compacts once, with what follows "now" as the instructions and a record of the tool work', async ($, on) => {
  const { s } = typedSession($, on)
  const done = await $.command.run({ command: 'compact', args: 'now keep the API notes', ...person })
  expect(s.ran).toEqual(['keep the API notes'])
  // session.compact fires inside the command: it must not decide the same compaction again.
  expect(s.inner[0]?.skip).toBeUndefined()
  expect(s.inner[0]?.messages).toEqual([summary])
  expect(done.text).toMatch(/^Compacted/)
  expect(done.context).toHaveLength(1)
  expect(done.context?.[0]).toMatch(/before a handoff was written/)
  expect(done.context?.[0]).toMatch(/\/repo\/src\/a\.ts/)
  expect(done.context?.[0]).toMatch(/npm test/)
})

test('a bare typed /compact now passes no instructions', async ($, on) => {
  const { s } = typedSession($, on)
  await $.command.run({ command: 'compact', args: 'now', ...person })
  expect(s.ran).toEqual([''])
})

test('a typed /compact with the handoff on disk compacts and points at it', async ($, on) => {
  const { s } = typedSession($, on, { tokens: 850_000, isOnDisk: true })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  const done = await $.command.run({ command: 'compact', args: '', ...person })
  expect(s.ran).toEqual([''])
  expect(s.inner[0]?.skip).toBeUndefined()
  expect(done.context?.[0]).toMatch(/resume handoff is at \/h\/\.claude\/handoffs\//)
})

// A typed compaction with the handoff on disk, then the fill drops to 6%: the setup for a stray /compact.
const afterTyped = async ($: any, on: On) => {
  const session = typedSession($, on, { tokens: 850_000, isOnDisk: true })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.command.run({ command: 'compact', args: '', ...person })
  session.s.tokens = 60_000
  session.s.isOnDisk = false
  return session
}

test('a bare typed /compact right after a compaction, with the context nearly empty, is ignored', async ($, on) => {
  const { clock, s } = await afterTyped($, on)
  const stray = await $.command.run({ command: 'compact', args: '', ...person })
  expect(stray.text).toMatch(/Ignored a \/compact right after a compaction/)
  expect(s.ran).toHaveLength(1)
  await clock.advance(600)
  expect(s.prompts).toHaveLength(0)
})

test('a bare typed /compact long after a compaction is postponed again', async ($, on) => {
  const { clock, s } = await afterTyped($, on)
  await clock.advance(16 * 60 * 1000)
  const typed = await $.command.run({ command: 'compact', args: '', ...person })
  expect(typed.text).toMatch(/postponed/)
  expect(s.ran).toHaveLength(1)
})

test('right after a compaction, a typed /compact with instructions is postponed and /compact now compacts', async ($, on) => {
  const { s } = await afterTyped($, on)
  const typed = await $.command.run({ command: 'compact', args: 'keep the API notes', ...person })
  expect(typed.text).toMatch(/postponed/)
  await $.command.run({ command: 'compact', args: 'now', ...person })
  expect(s.ran).toHaveLength(2)
})

// What compactAndResume sends through the command in a headless seat (the mocks cannot make $.session.compact
// reject, so the fallback itself is checked in a real session).
test('the mod\'s own /compact, as its headless fallback sends it, goes straight through', async ($, on) => {
  const { s } = typedSession($, on, { tokens: 850_000, isOnDisk: true })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  const args = 'A resume handoff was just written to /h/.claude/handoffs/sess-1.md. Keep that path in the summary.'
  const done = await $.command.run({ command: 'compact', args, ...person, origin: { kind: 'plugin' as const, name: 'handoff' } })
  expect(s.ran).toEqual([args])
  expect(s.inner[0]?.skip).toBeUndefined()
  expect(s.inner[0]?.messages).toEqual([summary])
  expect(done.context).toBeUndefined()
})

test('a typed /compact now that does not compact leaves no note', async ($, on) => {
  const { s } = typedSession($, on, { isRefused: true })
  const done = await $.command.run({ command: 'compact', args: 'now', ...person })
  expect(s.ran).toEqual([''])
  expect(done.context).toBeUndefined()
})

test('a typed /compact now sends the ADHD reminder as its own prompt', async ($, on) => {
  const { clock, s } = typedSession($, on, { isAdhd: true })
  await $.command.run({ command: 'compact', args: 'now', ...person })
  await clock.advance(800)
  expect(s.prompts).toHaveLength(1)
  expect(s.prompts[0]).toMatch(/ADHD mode is active/)
})

test('a typed /compact now with the handoff on disk still points at it, and says what it does not cover', async ($, on) => {
  const { s } = typedSession($, on, { tokens: 850_000, isOnDisk: true })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  const done = await $.command.run({ command: 'compact', args: 'now', ...person })
  expect(s.ran).toEqual([''])
  expect(done.context?.[0]).toMatch(/resume handoff is at \/h\/\.claude\/handoffs\//)
  expect(done.context?.[0]).toMatch(/predates your last 1 tool calls/)
})

test('a compaction past session.compact, with as many rows as before, still leaves the note and arms the stray guard', async ($, on) => {
  const { s } = typedSession($, on, { isBypassed: true })
  const done = await $.command.run({ command: 'compact', args: 'now', ...person })
  expect(done.context?.[0]).toMatch(/before a handoff was written/)
  s.tokens = 60_000
  const stray = await $.command.run({ command: 'compact', args: '', ...person })
  expect(stray.text).toMatch(/Ignored a \/compact right after a compaction/)
})

test('a typed /compact now that a hook further down skips leaves no note', async ($, on) => {
  const { s } = typedSession($, on, { isSkippedBelow: true })
  const done = await $.command.run({ command: 'compact', args: 'now', ...person })
  expect(s.inner[0]?.skip).toMatch(/PreCompact/)
  expect(done.text).toMatch(/^Not compacted/)
  expect(done.context).toBeUndefined()
})

test('the command\'s own context is kept ahead of the note', async ($, on) => {
  typedSession($, on, { coreContext: ['core note'] })
  const done = await $.command.run({ command: 'compact', args: 'now', ...person })
  expect(done.context).toHaveLength(2)
  expect(done.context?.[0]).toBe('core note')
  expect(done.context?.[1]).toMatch(/before a handoff was written/)
})

test('after the mod\'s own /compact, a typed one is the person\'s again, and the marker typed by hand is not the mod\'s', async ($, on) => {
  const { s } = typedSession($, on)
  const args = 'A resume handoff was just written to /h/.claude/handoffs/sess-1.md. Keep that path in the summary.'
  await $.command.run({ command: 'compact', args, ...person, origin: { kind: 'plugin' as const, name: 'handoff' } })
  expect(s.ran).toHaveLength(1)
  const typed = await $.command.run({ command: 'compact', args: '', ...person })
  expect(typed.text).toMatch(/postponed/)
  const forged = await $.command.run({ command: 'compact', args, ...person })
  expect(forged.text).toMatch(/postponed/)
  expect(s.ran).toHaveLength(1)
})

test('a subagent\'s or a precompute compaction passes through untouched', async ($, on) => {
  const { clock, s } = typedSession($, on, { tokens: 850_000 })
  const pre = await $.session.compact({ trigger: 'precompute', messages: work })
  expect(pre.messages).toEqual([summary])
  const sub = await $.session.compact({ trigger: 'manual', agentId: 'sub-1', messages: work })
  expect(sub.messages).toEqual([summary])
  await clock.advance(800)
  expect(s.prompts).toHaveLength(0)
})

test('a routed compaction counts by session.compact\'s result alone, and the next refused one does not', async ($, on) => {
  const opts: TypedOptions = { coreText: '' }
  const { s } = typedSession($, on, opts)
  const done = await $.command.run({ command: 'compact', args: 'now', ...person })
  expect(done.context?.[0]).toMatch(/before a handoff was written/)
  opts.isRefused = true
  s.tokens = 60_000
  const refused = await $.command.run({ command: 'compact', args: 'now', ...person })
  expect(refused.context).toBeUndefined()
})

test('a typed /compact now whose transcript cannot be read still compacts and arms the stray guard', async ($, on) => {
  const { s } = typedSession($, on, { isUnreadable: true, isBypassed: true })
  const done = await $.command.run({ command: 'compact', args: 'now', ...person })
  expect(done.text).toMatch(/^Compacted/)
  expect(done.context).toBeUndefined()
  s.tokens = 60_000
  const stray = await $.command.run({ command: 'compact', args: '', ...person })
  expect(stray.text).toMatch(/Ignored a \/compact right after a compaction/)
})

test('with autoCompact off, a held /compact tells the user to type it again', { options: { autoCompact: false } }, async ($, on) => {
  const { clock, s } = typedSession($, on)
  const held = await $.command.run({ command: 'compact', args: '', ...person })
  expect(held.text).toMatch(/type \/compact again once it is ready/)
  expect(/by itself/.test(held.text ?? '')).toBe(false)
  await clock.advance(600)
  expect(s.prompts[0]).toMatch(/tell the user it is ready so they can compact, then wait/)
})
