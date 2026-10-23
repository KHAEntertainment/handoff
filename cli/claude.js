import { join } from 'node:path'
import { KHA_MARKETPLACE, MARKETPLACE, PLUGIN, cliVersion, exists, readJson, runOrThrow } from './util.js'

const OURS = `${PLUGIN}@${MARKETPLACE}`
const KHA = `${PLUGIN}@${KHA_MARKETPLACE}`
const DONE = { install: 'installed', upgrade: 'upgraded', switch: 'switched to the npm copy,' }

export function probe(ctx) {
  const version = cliVersion(ctx, 'claude')
  const plugins = readJson(join(ctx.claudeHome, 'plugins', 'installed_plugins.json'))?.plugins ?? {}
  const known = readJson(join(ctx.claudeHome, 'plugins', 'known_marketplaces.json')) ?? {}
  const ours = plugins[OURS]?.[0] ?? null
  const kha = plugins[KHA]?.[0] ?? null
  const installs = []
  if (ours) installs.push(`${ours.version} (${MARKETPLACE})`)
  if (kha) installs.push(`${kha.version} (${KHA_MARKETPLACE})`)
  return {
    id: 'claude',
    label: 'Claude Code',
    present: version !== null || exists(ctx.claudeHome),
    version,
    home: ctx.claudeHome,
    installs,
    ours: Boolean(ours),
    oursVersion: ours?.version ?? null,
    kha: Boolean(kha),
    khaVersion: kha?.version ?? null,
    marketplaceKnown: MARKETPLACE in known,
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
  if (info.marketplaceKnown) runOrThrow(ctx, 'claude', ['plugin', 'marketplace', 'update', MARKETPLACE])
  else runOrThrow(ctx, 'claude', ['plugin', 'marketplace', 'add', ctx.stageDir])
  if (info.ours) runOrThrow(ctx, 'claude', ['plugin', 'update', OURS])
  else runOrThrow(ctx, 'claude', ['plugin', 'install', OURS])
  // Only once the new copy is in: both would hold /compact.
  if (info.kha) runOrThrow(ctx, 'claude', ['plugin', 'uninstall', KHA])
  return { status: 'ok', message: `${DONE[action]} ${OURS}. Restart Claude Code to load it.` }
}

export function uninstall(ctx, info) {
  if (info.ours) runOrThrow(ctx, 'claude', ['plugin', 'uninstall', OURS])
  if (info.marketplaceKnown) runOrThrow(ctx, 'claude', ['plugin', 'marketplace', 'remove', MARKETPLACE])
  return { status: 'ok', message: info.ours ? `removed ${OURS}` : 'nothing to remove' }
}
