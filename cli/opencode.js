import { mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { PACKAGE_ROOT } from './stage.js'
import { atomicWrite, backup, backupContents, cliVersion, entry, exists, forgetFile, readState, recordFile, sha256, tilde, transact } from './util.js'

const DONE = { install: 'installed', upgrade: 'upgraded', replace: 'installed' }
const FILE = 'handoff.js'
const OLD_FILE = 'context-handoff.js'

const sourceOf = (ctx) => join(ctx.stageDir, 'opencode', 'context-handoff.js')
const targetOf = (ctx) => join(ctx.opencodeHome, 'plugins', FILE)

/**
 * Whose file plugins/handoff.js is: 'none' (absent), 'ours' (a regular file, not a link, whose content is what
 * this installer recorded writing or what this package version ships) or 'foreign' (anything else: unrelated,
 * edited since, or a link). Only an 'ours' file is replaced or removed without being asked.
 */
function ownership(ctx) {
  const path = targetOf(ctx)
  const stat = entry(path)
  if (!stat) return 'none'
  if (stat.isSymbolicLink() || !stat.isFile()) return 'foreign'
  let hash
  try {
    hash = sha256(readFileSync(path))
  } catch {
    return 'foreign'
  }
  const shipped = sha256(readFileSync(join(PACKAGE_ROOT, 'opencode', 'context-handoff.js')))
  return hash === readState(ctx).files?.[path] || hash === shipped ? 'ours' : 'foreign'
}

export function probe(ctx) {
  const version = cliVersion(ctx, 'opencode')
  const plugins = join(ctx.opencodeHome, 'plugins')
  const owner = ownership(ctx)
  const old = join(plugins, OLD_FILE)
  const kind = entry(old)
  const legacy = kind ? [{ kind: 'file', path: old, text: `plugins/${OLD_FILE} (${kind.isSymbolicLink() ? 'link' : 'file'})` }] : []
  const installs = []
  if (owner === 'ours') installs.push(`plugins/${FILE}`)
  if (owner === 'foreign') installs.push(`plugins/${FILE} (not installed by handoff, or edited since: left alone unless --force)`)
  for (const item of legacy) installs.push(`manual: ${item.text}`)
  return {
    id: 'opencode',
    label: 'OpenCode',
    present: version !== null || exists(ctx.opencodeHome),
    version,
    home: ctx.opencodeHome,
    installs,
    notes: [],
    ours: owner === 'ours',
    removable: owner === 'ours',
    foreignFile: owner === 'foreign',
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
    return readFileSync(targetOf(ctx), 'utf8') === readFileSync(join(PACKAGE_ROOT, 'opencode', 'context-handoff.js'), 'utf8')
  } catch {
    return false
  }
}

/** Puts a file or link back as it was: from the bytes read before, or the link target. */
function restore(path, before) {
  rmSync(path, { force: true })
  if (before.link !== null) symlinkSync(before.link, path)
  else if (before.bytes !== null) atomicWrite(path, before.bytes, { follow: false })
}

function snapshot(path) {
  const stat = entry(path)
  if (!stat) return { link: null, bytes: null }
  if (stat.isSymbolicLink()) return { link: readlinkSync(path), bytes: null }
  return { link: null, bytes: readFileSync(path) }
}

export function install(ctx, info, { replaceLegacy, force }) {
  const target = targetOf(ctx)
  if (info.foreignFile && !force) {
    throw new Error(`plugins/${FILE} exists and was not installed by handoff, or was edited since. Not replacing it. Run with --force to back it up and replace it.`)
  }
  mkdirSync(join(ctx.opencodeHome, 'plugins'), { recursive: true })
  const content = readFileSync(sourceOf(ctx))
  // Backups first, so nothing is changed before everything that will be replaced is saved.
  const replacing = entry(target) !== null
  if (replacing) info.foreignFile ? backup(ctx, target, 'opencode-handoff.js') : backupContents(ctx, target, 'opencode-handoff.js')
  const legacy = replaceLegacy ? info.legacy : []
  for (const item of legacy) backup(ctx, item.path, 'opencode-context-handoff.js')
  const before = snapshot(target)
  const legacyBefore = legacy.map((item) => snapshot(item.path))

  transact((undo) => {
    atomicWrite(target, content, { follow: false })
    undo.add(replacing ? `restored plugins/${FILE}` : `removed plugins/${FILE}`, () => restore(target, before))
    legacy.forEach((item, index) => {
      rmSync(item.path, { force: true })
      undo.add(`restored plugins/${OLD_FILE}`, () => restore(item.path, legacyBefore[index]))
    })
    recordFile(ctx, target, sha256(content))
  })
  let message = `${DONE[plan(info).action]} ${tilde(ctx, target)}. Restart OpenCode to load it.`
  if (replacing) message += ` The previous plugins/${FILE} is saved in ${tilde(ctx, ctx.backupDir)}.`
  if (legacy.length > 0) message += ` Replaced ${OLD_FILE} (backup in ${tilde(ctx, ctx.backupDir)}).`
  return { status: 'ok', message }
}

export function uninstall(ctx, info) {
  // Only a file this installer wrote and nobody edited. Anything else is not ours to delete.
  if (!info.ours) {
    return info.foreignFile
      ? { status: 'kept', message: `left plugins/${FILE} alone: not installed by handoff, or edited since` }
      : { status: 'ok', message: 'nothing to remove' }
  }
  rmSync(targetOf(ctx), { force: true })
  forgetFile(ctx, targetOf(ctx))
  return { status: 'ok', message: `removed plugins/${FILE}` }
}
