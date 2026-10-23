import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { PACKAGE_ROOT } from './stage.js'
import { backup, cliVersion, entry, exists, tilde } from './util.js'

const DONE = { install: 'installed', upgrade: 'upgraded', replace: 'installed' }
const FILE = 'handoff.js'
const OLD_FILE = 'context-handoff.js'

const sourceOf = (ctx) => join(ctx.stageDir, 'opencode', 'context-handoff.js')

export function probe(ctx) {
  const version = cliVersion(ctx, 'opencode')
  const plugins = join(ctx.opencodeHome, 'plugins')
  const ours = Boolean(entry(join(plugins, FILE)))
  const old = join(plugins, OLD_FILE)
  const kind = entry(old)
  const legacy = kind ? [{ kind: 'file', path: old, text: `plugins/${OLD_FILE} (${kind.isSymbolicLink() ? 'link' : 'file'})` }] : []
  const installs = []
  if (ours) installs.push(`plugins/${FILE}`)
  for (const item of legacy) installs.push(`manual: ${item.text}`)
  return {
    id: 'opencode',
    label: 'OpenCode',
    present: version !== null || exists(ctx.opencodeHome),
    version,
    home: ctx.opencodeHome,
    installs,
    ours,
    legacy,
  }
}

export function plan(info) {
  if (info.legacy.length > 0) return { action: 'replace', text: 'replace manual install' }
  if (info.ours) return { action: 'upgrade', text: 'upgrade' }
  return { action: 'install', text: 'install' }
}

/** True when the installed plugin file is the one this package version ships. */
export function isCurrent(ctx) {
  try {
    return readFileSync(join(ctx.opencodeHome, 'plugins', FILE), 'utf8') === readFileSync(join(PACKAGE_ROOT, 'opencode', 'context-handoff.js'), 'utf8')
  } catch {
    return false
  }
}

export function install(ctx, info, { replaceLegacy }) {
  const dir = join(ctx.opencodeHome, 'plugins')
  mkdirSync(dir, { recursive: true })
  const target = join(dir, FILE)
  // A previous install of ours may be a link someone made by hand; replace the link, not what it points at.
  rmSync(target, { force: true })
  copyFileSync(sourceOf(ctx), target)
  let message = `${DONE[plan(info).action]} ${tilde(ctx, target)}. Restart OpenCode to load it.`
  if (replaceLegacy) {
    for (const item of info.legacy) {
      backup(ctx, item.path, 'opencode-context-handoff.js')
      rmSync(item.path, { force: true })
    }
    if (info.legacy.length > 0) message += ` Replaced ${OLD_FILE} (backup in ${tilde(ctx, ctx.backupDir)}).`
  }
  return { status: 'ok', message }
}

export function uninstall(ctx, info) {
  if (info.ours) rmSync(join(ctx.opencodeHome, 'plugins', FILE), { force: true })
  return { status: 'ok', message: info.ours ? `removed plugins/${FILE}` : 'nothing to remove' }
}
