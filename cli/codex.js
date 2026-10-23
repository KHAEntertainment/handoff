import { cpSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { MARKETPLACE, PLUGIN, atomicWrite, backup, backupContents, canonical, cliVersion, entry, exists, readJson, readText, run, runOrThrow, tilde, transact } from './util.js'

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

/** The body of `[marketplaces.<name>]` in config.toml, or null when the table is absent. */
function marketplaceTable(config, name) {
  const header = new RegExp(`^\\[marketplaces\\.("?)${name}\\1\\]\\s*$`, 'm').exec(config)
  if (!header) return null
  const rest = config.slice(header.index + header[0].length)
  const next = rest.search(/^\[/m)
  return next < 0 ? rest : rest.slice(0, next)
}

/** 'none', 'ours' (a local marketplace at the staged copy) or 'foreign' (the name belongs to another source). */
function marketplaceOwner(ctx, config) {
  const body = marketplaceTable(config, MARKETPLACE)
  if (body === null) return { owner: 'none', source: null }
  const source = /^\s*source\s*=\s*"([^"]*)"/m.exec(body)?.[1] ?? null
  const type = /^\s*source_type\s*=\s*"([^"]*)"/m.exec(body)?.[1]
  const ours = type === 'local' && source !== null && canonical(source) === canonical(ctx.stageDir)
  return { owner: ours ? 'ours' : 'foreign', source }
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
  const { owner: marketplace, source: foreignSource } = marketplaceOwner(ctx, config)
  // handoff@handoff only counts as ours when the marketplace it came from is ours.
  const ours = marketplace === 'ours' && config.includes(`[plugins."${OURS}"]`)
  const legacy = legacyInstalls(ctx)
  const installs = []
  const notes = []
  if (marketplace === 'foreign') notes.push(`a marketplace named "${MARKETPLACE}" is registered from ${foreignSource ?? 'an unknown source'}, not from handoff; it is left alone`)
  if (ours) installs.push(`${pluginVersion(ctx) ?? 'unknown version'} (plugin ${OURS})`)
  for (const item of legacy) installs.push(`manual: ${item.text}`)
  return {
    id: 'codex',
    label: 'Codex',
    present: version !== null || exists(ctx.codexHome),
    version,
    home: ctx.codexHome,
    installs,
    notes,
    ours,
    removable: ours || marketplace === 'ours',
    marketplace,
    foreignSource,
    legacy,
  }
}

export function plan(info) {
  if (info.legacy.length > 0) return { action: 'replace', text: 'replace manual install' }
  if (info.ours) return { action: 'upgrade', text: 'upgrade' }
  return { action: 'install', text: 'install' }
}

/** Copies what the manual install is made of, before anything is installed or changed. */
function backUpLegacy(ctx, info) {
  return info.legacy.map((item) =>
    item.kind === 'hooks' ? backupContents(ctx, item.path, 'codex-hooks.json') : backup(ctx, item.path, 'codex-hooks-context-handoff'))
}

/** Removes the manual install. Each step registers how to put it back if a later one fails. */
function removeLegacy(info, saved, undo) {
  info.legacy.forEach((item, index) => {
    if (item.kind === 'hooks') {
      const original = readFileSync(item.path)
      atomicWrite(item.path, JSON.stringify(withoutOldHooks(JSON.parse(original)), null, 2) + '\n')
      undo.add(`restored ${item.path}`, () => atomicWrite(item.path, original))
    } else {
      const stat = entry(item.path)
      const target = stat.isSymbolicLink() ? readlinkSync(item.path) : null
      rmSync(item.path, { recursive: true, force: true })
      undo.add(`restored ${item.path}`, () => (target !== null ? symlinkSync(target, item.path) : cpSync(saved[index], item.path, { recursive: true })))
    }
  })
}

export function install(ctx, info, { replaceLegacy }) {
  if (info.marketplace === 'foreign') {
    throw new Error(`a marketplace named "${MARKETPLACE}" is already registered from ${info.foreignSource ?? 'another source'}, not from handoff. Not touching it. Remove it yourself (codex plugin marketplace remove ${MARKETPLACE}) if you want this install.`)
  }
  const warnings = []
  if (!run(ctx, 'python3', ['--version'], { timeout: 15000 }).ok) {
    warnings.push('python3 is not on PATH. The hooks run `python3`, so install it or they will not do anything.')
  }
  const replacing = replaceLegacy && info.legacy.length > 0
  const saved = replacing ? backUpLegacy(ctx, info) : []
  transact((undo) => {
    if (info.marketplace === 'none') {
      runOrThrow(ctx, 'codex', ['plugin', 'marketplace', 'add', ctx.stageDir])
      undo.add(`removed marketplace ${MARKETPLACE}`, () => runOrThrow(ctx, 'codex', ['plugin', 'marketplace', 'remove', MARKETPLACE]))
    }
    runOrThrow(ctx, 'codex', ['plugin', 'add', OURS])
    if (!info.ours) undo.add(`removed ${OURS}`, () => runOrThrow(ctx, 'codex', ['plugin', 'remove', OURS]))
    if (replacing) removeLegacy(info, saved, undo)
  })
  let message = `${DONE[plan(info).action]} ${OURS}. Approve its 5 hooks in Codex's /hooks screen; Codex runs none of them until then.`
  if (replacing) message += ` Replaced the manual install (backups in ${tilde(ctx, ctx.backupDir)}; ${saved.length} saved).`
  return { status: 'ok', message, warnings }
}

export function uninstall(ctx, info) {
  if (info.marketplace === 'foreign') {
    return { status: 'kept', message: `left the marketplace "${MARKETPLACE}" alone: it is registered from ${info.foreignSource ?? 'another source'}, not from handoff` }
  }
  if (info.ours) runOrThrow(ctx, 'codex', ['plugin', 'remove', OURS])
  if (info.marketplace === 'ours') runOrThrow(ctx, 'codex', ['plugin', 'marketplace', 'remove', MARKETPLACE])
  return { status: 'ok', message: info.ours ? `removed ${OURS}` : 'nothing to remove' }
}
