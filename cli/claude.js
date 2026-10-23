import { join } from 'node:path'
import { KHA_MARKETPLACE, MARKETPLACE, PLUGIN, canonical, cliVersion, exists, readJson, runOrThrow, transact } from './util.js'

const OURS = `${PLUGIN}@${MARKETPLACE}`
const KHA = `${PLUGIN}@${KHA_MARKETPLACE}`
const DONE = { install: 'installed', upgrade: 'upgraded', switch: 'switched to the npm copy,' }

/** 'none', 'ours' (a directory marketplace pointing at the staged copy) or 'foreign' (the name is taken by another source). */
function marketplaceOwner(ctx, entry) {
  if (!entry) return 'none'
  const source = entry.source
  return source?.source === 'directory' && source.path && canonical(source.path) === canonical(ctx.stageDir) ? 'ours' : 'foreign'
}

const describeSource = (entry) => {
  const source = entry?.source ?? {}
  return source.path ?? source.repo ?? source.url ?? JSON.stringify(source)
}

export function probe(ctx) {
  const version = cliVersion(ctx, 'claude')
  const plugins = readJson(join(ctx.claudeHome, 'plugins', 'installed_plugins.json'))?.plugins ?? {}
  const known = readJson(join(ctx.claudeHome, 'plugins', 'known_marketplaces.json')) ?? {}
  const marketplace = marketplaceOwner(ctx, known[MARKETPLACE])
  // handoff@handoff only counts as ours when the marketplace it came from is ours.
  const ours = marketplace === 'ours' ? (plugins[OURS]?.[0] ?? null) : null
  const khaEntries = plugins[KHA] ?? []
  const installs = []
  const notes = []
  if (ours) installs.push(`${ours.version} (${MARKETPLACE})`)
  for (const entry of khaEntries) installs.push(`${entry.version} (${KHA_MARKETPLACE}${entry.scope && entry.scope !== 'user' ? `, ${entry.scope} scope` : ''})`)
  if (marketplace === 'foreign') notes.push(`a marketplace named "${MARKETPLACE}" is registered from ${describeSource(known[MARKETPLACE])}, not from handoff; it is left alone`)
  if (ours && khaEntries.length > 0) notes.push('both copies are installed: remove one, they each hold /compact')
  return {
    id: 'claude',
    label: 'Claude Code',
    present: version !== null || exists(ctx.claudeHome),
    version,
    home: ctx.claudeHome,
    installs,
    notes,
    ours: Boolean(ours),
    removable: Boolean(ours) || marketplace === 'ours',
    oursVersion: ours?.version ?? null,
    kha: khaEntries.length > 0,
    khaEntries,
    khaVersion: khaEntries[0]?.version ?? null,
    marketplace,
    foreignSource: marketplace === 'foreign' ? describeSource(known[MARKETPLACE]) : null,
    legacy: [],
  }
}

/** What install would do, for the prompt. */
export function plan(info, { switchKha }) {
  if (info.kha && !switchKha) return { action: 'keep', text: `keep ${KHA} ${info.khaVersion}` }
  if (info.kha) return { action: 'switch', text: `switch from ${KHA}` }
  if (info.ours) return { action: 'upgrade', text: `upgrade ${info.oursVersion}` }
  return { action: 'install', text: 'install' }
}

export function install(ctx, info, { switchKha }) {
  const { action } = plan(info, { switchKha })
  if (action === 'keep') return { status: 'kept', message: `kept ${KHA} ${info.khaVersion}; pass --switch-claude to use the npm copy instead` }
  if (info.marketplace === 'foreign') {
    throw new Error(`a marketplace named "${MARKETPLACE}" is already registered from ${info.foreignSource}, not from handoff. Not touching it. Remove it yourself (claude plugin marketplace remove ${MARKETPLACE}) if you want this install.`)
  }
  transact((undo) => {
    if (info.marketplace === 'ours') runOrThrow(ctx, 'claude', ['plugin', 'marketplace', 'update', MARKETPLACE])
    else {
      runOrThrow(ctx, 'claude', ['plugin', 'marketplace', 'add', ctx.stageDir])
      undo.add(`removed marketplace ${MARKETPLACE}`, () => runOrThrow(ctx, 'claude', ['plugin', 'marketplace', 'remove', MARKETPLACE]))
    }
    if (info.ours) runOrThrow(ctx, 'claude', ['plugin', 'update', OURS])
    else {
      runOrThrow(ctx, 'claude', ['plugin', 'install', OURS])
      undo.add(`uninstalled ${OURS}`, () => runOrThrow(ctx, 'claude', ['plugin', 'uninstall', OURS]))
    }
    // Only once the new copy is in: both would hold /compact. Every scope the old one is installed in.
    for (const entry of info.khaEntries) {
      const scope = entry.scope ?? 'user'
      const opts = entry.projectPath ? { cwd: entry.projectPath } : {}
      runOrThrow(ctx, 'claude', ['plugin', 'uninstall', KHA, '--scope', scope], opts)
      undo.add(`reinstalled ${KHA} (${scope} scope)`, () => runOrThrow(ctx, 'claude', ['plugin', 'install', KHA, '--scope', scope], opts))
    }
  })
  return { status: 'ok', message: `${DONE[action]} ${OURS}. Restart Claude Code to load it.` }
}

export function uninstall(ctx, info) {
  if (info.marketplace === 'foreign') {
    return { status: 'kept', message: `left the marketplace "${MARKETPLACE}" alone: it is registered from ${info.foreignSource}, not from handoff` }
  }
  if (info.ours) runOrThrow(ctx, 'claude', ['plugin', 'uninstall', OURS])
  if (info.marketplace === 'ours') runOrThrow(ctx, 'claude', ['plugin', 'marketplace', 'remove', MARKETPLACE])
  return { status: 'ok', message: info.ours ? `removed ${OURS}` : 'nothing to remove' }
}
