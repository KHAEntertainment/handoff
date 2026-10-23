import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

export const MARKETPLACE = 'handoff'
export const PLUGIN = 'handoff'
export const KHA_MARKETPLACE = 'kha-marketplace'

/** Everything that depends on the environment, so tests can point it at a temp HOME. */
export function makeContext(env = process.env) {
  const home = env.HOME || homedir()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return {
    env,
    home,
    claudeHome: env.CLAUDE_CONFIG_DIR || join(home, '.claude'),
    codexHome: env.CODEX_HOME || join(home, '.codex'),
    opencodeHome: env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, 'opencode') : join(home, '.config', 'opencode'),
    stageDir: join(home, '.handoff', 'marketplace'),
    statePath: join(home, '.handoff', 'state.json'),
    backupDir: join(home, '.handoff', 'backups', stamp),
  }
}

/** Runs a command on PATH. Never throws: a missing binary is `{ ok: false }`. */
export function run(ctx, cmd, args, { cwd, timeout = 120000 } = {}) {
  const done = spawnSync(cmd, args, { env: ctx.env, cwd, timeout, encoding: 'utf8' })
  const failed = done.error || done.status !== 0
  return {
    ok: !failed,
    stdout: done.stdout ?? '',
    stderr: done.stderr ?? '',
    error: failed ? (done.error?.message ?? ((done.stderr || done.stdout || '').trim() || `exit ${done.status}`)) : null,
  }
}

/** Like run, but a failure throws with the command line in the message. */
export function runOrThrow(ctx, cmd, args, opts) {
  const done = run(ctx, cmd, args, opts)
  if (!done.ok) throw new Error(`${cmd} ${args.join(' ')}: ${done.error}`)
  return done
}

/** The first x.y.z in `<cmd> --version`, or null when the command is not on PATH. */
export function cliVersion(ctx, cmd) {
  const done = run(ctx, cmd, ['--version'], { timeout: 15000 })
  return done.ok ? (done.stdout.match(/\d+\.\d+\.\d+\S*/)?.[0] ?? 'unknown') : null
}

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

export function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** A path with links resolved when it exists, else made absolute: two spellings of one place compare equal. */
export function canonical(path) {
  try {
    return realpathSync(path)
  } catch {
    const parent = dirname(resolve(path))
    return parent === resolve(path) ? parent : join(canonical(parent), basename(path))
  }
}

/**
 * Replaces a file without ever leaving it half written: the new content goes to a temp file in the same
 * directory, then renames over the old one, so a failure leaves the original as it was. With `follow`
 * (the default) a link is resolved first and the file it points at is replaced, link intact; without it
 * the link itself is replaced.
 */
export function atomicWrite(path, data, { follow = true } = {}) {
  const target = follow ? canonical(path) : path
  const tmp = join(dirname(target), `.${basename(target)}.handoff-${process.pid}.tmp`)
  try {
    let mode = 0o644
    try {
      mode = statSync(target).mode & 0o777
    } catch {}
    writeFileSync(tmp, data, { mode })
    renameSync(tmp, target)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

export function writeJson(path, value) {
  atomicWrite(path, JSON.stringify(value, null, 2) + '\n')
}

export const sha256 = (data) => createHash('sha256').update(data).digest('hex')

/** The files this installer wrote, with the hash it wrote: only a file that still matches is ours to replace or remove. */
export function readState(ctx) {
  return readJson(ctx.statePath) ?? { files: {} }
}

export function recordFile(ctx, path, hash) {
  const state = readState(ctx)
  state.files = { ...state.files, [path]: hash }
  mkdirSync(dirname(ctx.statePath), { recursive: true })
  writeJson(ctx.statePath, state)
}

export function forgetFile(ctx, path) {
  const state = readState(ctx)
  if (!(path in (state.files ?? {}))) return
  delete state.files[path]
  writeJson(ctx.statePath, state)
}

/**
 * Runs `fn(undo)`. If it throws, the steps it registered with `undo.add(label, fn)` run newest first and the
 * error is rethrown saying what was rolled back and what could not be.
 */
export function transact(fn) {
  const steps = []
  const undo = { add: (label, step) => steps.push({ label, step }) }
  try {
    return fn(undo)
  } catch (error) {
    const rolledBack = []
    const stuck = []
    for (const { label, step } of steps.reverse()) {
      try {
        step()
        rolledBack.push(label)
      } catch (undoError) {
        stuck.push(`${label} (${undoError.message})`)
      }
    }
    let note = rolledBack.length ? ` Rolled back: ${rolledBack.join('; ')}.` : ''
    if (stuck.length) note += ` Could NOT roll back: ${stuck.join('; ')}. Check by hand.`
    throw new Error(error.message + note)
  }
}

/** lstat that also sees a broken link. Null when nothing is there. */
export function entry(path) {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

export const exists = (path) => existsSync(path)

/** Renames `path` to a sibling that marks it as removed. One atomic step; undo with renameSync(returned, path). */
export function quarantine(path) {
  const moved = `${path}.handoff-removed-${process.pid}-${Date.now()}`
  renameSync(path, moved)
  return moved
}

/** Copies a file's contents (through a link) into this run's backup folder. */
export function backupContents(ctx, path, label = basename(path)) {
  mkdirSync(ctx.backupDir, { recursive: true })
  const dest = join(ctx.backupDir, label)
  copyFileSync(path, dest)
  return dest
}

/**
 * Copies `path` into this run's backup folder before it is edited or removed.
 * A link is saved as a small file naming its target, since the target stays where it is.
 */
export function backup(ctx, path, label = basename(path)) {
  mkdirSync(ctx.backupDir, { recursive: true })
  const dest = join(ctx.backupDir, label)
  const info = lstatSync(path)
  if (info.isSymbolicLink()) writeFileSync(dest + '.symlink', readlinkSync(path) + '\n')
  else if (info.isDirectory()) cpSync(path, dest, { recursive: true })
  else copyFileSync(path, dest)
  return dest
}

export function tilde(ctx, path) {
  return path.startsWith(ctx.home) ? '~' + path.slice(ctx.home.length) : path
}
