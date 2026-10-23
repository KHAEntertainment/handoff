import { spawn } from 'node:child_process'

/**
 * Asks `codex app-server` (read-only, over stdio) which hooks Codex knows and whether each is approved.
 * Resolves `{ hooks }` with the handoff hooks (trustStatus: trusted | modified | untrusted), or `{ error }`.
 */
export function handoffHookTrust(ctx, { cwd = process.cwd(), timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('codex', ['app-server'], { env: ctx.env, cwd, stdio: ['pipe', 'pipe', 'ignore'] })
    let buffer = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      resolve(result)
    }
    const timer = setTimeout(() => finish({ error: 'timed out waiting for codex app-server' }), timeoutMs)
    const send = (message) => child.stdin.write(JSON.stringify(message) + '\n')
    child.on('error', (error) => finish({ error: error.message }))
    child.on('exit', () => finish({ error: 'codex app-server exited early' }))
    child.stdin.on('error', () => {})
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let at
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        let message
        try { message = JSON.parse(line) } catch { continue }
        if (message.id !== 2) continue
        if (message.error) return finish({ error: message.error.message ?? 'hooks/list failed' })
        const hooks = (message.result?.data ?? []).flatMap((entry) => entry.hooks ?? [])
        finish({ hooks: hooks.filter((hook) => String(hook.command ?? '').includes('context_handoff.py')) })
      }
    })
    child.stdout.setEncoding('utf8')
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'handoff', version: '0' } } })
    send({ method: 'initialized' })
    send({ id: 2, method: 'hooks/list', params: { cwds: [cwd] } })
  })
}

/** A plugin hook's key starts with its plugin id (`handoff@handoff:hooks.json:...`); a manual one with the hooks.json path. */
export const isPluginHook = (hook) => String(hook.key ?? '').startsWith('handoff@')

/** Status lines for the Codex hooks: the plugin's approval, and any older manual entries. */
export function trustLines(hooks) {
  const plugin = hooks.filter(isPluginHook)
  const manual = hooks.filter((hook) => !isPluginHook(hook))
  const lines = []
  if (plugin.length > 0) {
    const count = (status) => plugin.filter((hook) => hook.trustStatus === status).length
    const trusted = count('trusted')
    const rest = ['untrusted', 'modified'].map((status) => [count(status), status]).filter(([n]) => n > 0).map(([n, s]) => `${n} ${s}`)
    lines.push(`plugin: ${trusted} of ${plugin.length} approved${trusted === plugin.length ? '' : ` (${rest.join(', ')}); approve them in Codex's /hooks screen`}`)
  }
  if (manual.length > 0) lines.push(`manual hooks.json entries: ${manual.length} (older install; rerun install to replace)`)
  return lines
}
