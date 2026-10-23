import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { MARKETPLACE, PLUGIN, backup, cliVersion, entry, exists, readJson, readText, run, runOrThrow, tilde, writeJson } from './util.js'

const OURS = `${PLUGIN}@${MARKETPLACE}`
const DONE = { install: 'installed', upgrade: 'upgraded', replace: 'installed' }
const OLD_SCRIPT = 'context_handoff.py'

const isOldHook = (hook) => typeof hook?.command === 'string' && hook.command.includes(OLD_SCRIPT)

/** hooks.json with the earlier hand-added handoff entries removed, other tools' hooks untouched. */
function withoutOldHooks(config) {
  const hooks = {}
  for (const [event, groups] of Object.entries(config.hooks ?? {})) {
    const kept = (groups ?? [])
      .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((hook) => !isOldHook(hook)) }))
      .filter((group) => group.hooks.length > 0)
    if (kept.length > 0) hooks[event] = kept
  }
  return { ...config, hooks }
}

function legacyInstalls(ctx) {
  const found = []
  const hooksPath = join(ctx.codexHome, 'hooks.json')
  const config = readJson(hooksPath)
  const count = Object.values(config?.hooks ?? {}).flat().flatMap((group) => group?.hooks ?? []).filter(isOldHook).length
  if (count > 0) found.push({ kind: 'hooks', path: hooksPath, text: `${count} hooks in ${tilde(ctx, hooksPath)}` })
  const linkPath = join(ctx.codexHome, 'hooks', 'context-handoff')
  if (entry(linkPath)) found.push({ kind: 'link', path: linkPath, text: tilde(ctx, linkPath) })
  return found
}

function pluginVersion(ctx) {
  try {
    return readdirSync(join(ctx.codexHome, 'plugins', 'cache', MARKETPLACE, PLUGIN)).sort().pop() ?? null
  } catch {
    return null
  }
}

export function probe(ctx) {
  const version = cliVersion(ctx, 'codex')
  const config = readText(join(ctx.codexHome, 'config.toml'))
  const ours = config.includes(`[plugins."${OURS}"]`)
  const legacy = legacyInstalls(ctx)
  const installs = []
  if (ours) installs.push(`${pluginVersion(ctx) ?? 'unknown version'} (plugin ${OURS})`)
  for (const item of legacy) installs.push(`manual: ${item.text}`)
  return {
    id: 'codex',
    label: 'Codex',
    present: version !== null || exists(ctx.codexHome),
    version,
    home: ctx.codexHome,
    installs,
    ours,
    marketplaceKnown: config.includes(`[marketplaces.${MARKETPLACE}]`),
    legacy,
  }
}

export function plan(info) {
  if (info.legacy.length > 0) return { action: 'replace', text: 'replace manual install' }
  if (info.ours) return { action: 'upgrade', text: 'upgrade' }
  return { action: 'install', text: 'install' }
}

/** Edits and removes the earlier manual install, with a copy of everything first. */
export function removeLegacy(ctx, info) {
  const saved = []
  for (const item of info.legacy) {
    saved.push(backup(ctx, item.path, item.kind === 'hooks' ? 'codex-hooks.json' : 'codex-hooks-context-handoff'))
    if (item.kind === 'hooks') writeJson(item.path, withoutOldHooks(readJson(item.path)))
    else rmSync(item.path, { recursive: true, force: true })
  }
  return saved
}

export function install(ctx, info, { replaceLegacy }) {
  const warnings = []
  if (!run(ctx, 'python3', ['--version'], { timeout: 15000 }).ok) {
    warnings.push('python3 is not on PATH. The hooks run `python3`, so install it or they will not do anything.')
  }
  if (!info.marketplaceKnown) runOrThrow(ctx, 'codex', ['plugin', 'marketplace', 'add', ctx.stageDir])
  runOrThrow(ctx, 'codex', ['plugin', 'add', OURS])
  let message = `${DONE[plan(info).action]} ${OURS}. Approve its 5 hooks in Codex's /hooks screen; Codex runs none of them until then.`
  if (replaceLegacy && info.legacy.length > 0) {
    const saved = removeLegacy(ctx, info)
    message += ` Replaced the manual install (backups in ${tilde(ctx, ctx.backupDir)}; ${saved.length} saved).`
  }
  return { status: 'ok', message, warnings }
}

export function uninstall(ctx, info) {
  if (info.ours) runOrThrow(ctx, 'codex', ['plugin', 'remove', OURS])
  if (info.marketplaceKnown) runOrThrow(ctx, 'codex', ['plugin', 'marketplace', 'remove', MARKETPLACE])
  return { status: 'ok', message: info.ours ? `removed ${OURS}` : 'nothing to remove' }
}
