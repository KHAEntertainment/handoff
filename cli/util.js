import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

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

export function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
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
