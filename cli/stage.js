import { cpSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MARKETPLACE, PLUGIN, readJson, writeJson } from './util.js'

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const packageInfo = () => readJson(join(PACKAGE_ROOT, 'package.json'))

const DESCRIPTION = 'Write a resume handoff before compaction, compact, then resume from it.'

/**
 * Copies this package version's plugin files into ~/.handoff/marketplace, a local marketplace that both
 * Claude Code (.claude-plugin/marketplace.json) and Codex (.agents/plugins/marketplace.json) can install from.
 * Builds beside the old copy and swaps, so a failed copy leaves the previous staging in place.
 */
export function stage(ctx) {
  const { version } = packageInfo()
  const tmp = `${ctx.stageDir}.tmp-${process.pid}`
  rmSync(tmp, { recursive: true, force: true })
  const copy = (from, to) => {
    mkdirSync(dirname(join(tmp, to)), { recursive: true })
    cpSync(join(PACKAGE_ROOT, from), join(tmp, to))
  }
  copy('.claude-plugin/plugin.json', 'claude/.claude-plugin/plugin.json')
  copy('hooks/hooks.json', 'claude/hooks/hooks.json')
  copy('hooks/register.ts', 'claude/hooks/register.ts')
  copy('codex/.codex-plugin/plugin.json', 'codex/.codex-plugin/plugin.json')
  copy('codex/hooks.json', 'codex/hooks.json')
  copy('codex/context_handoff.py', 'codex/context_handoff.py')
  copy('opencode/context-handoff.js', 'opencode/context-handoff.js')

  // The plugin manifests carry the package version, so every harness reports the version it was installed from.
  for (const manifest of ['claude/.claude-plugin/plugin.json', 'codex/.codex-plugin/plugin.json']) {
    const path = join(tmp, manifest)
    writeJson(path, { ...readJson(path), version })
  }
  mkdirSync(join(tmp, '.claude-plugin'), { recursive: true })
  writeJson(join(tmp, '.claude-plugin', 'marketplace.json'), {
    name: MARKETPLACE,
    owner: { name: 'KHA Entertainment' },
    metadata: { description: 'handoff, staged by @khaentertainment/handoff' },
    plugins: [{ name: PLUGIN, version, source: './claude', description: DESCRIPTION }],
  })
  mkdirSync(join(tmp, '.agents', 'plugins'), { recursive: true })
  writeJson(join(tmp, '.agents', 'plugins', 'marketplace.json'), {
    name: MARKETPLACE,
    interface: { displayName: 'handoff' },
    plugins: [{
      name: PLUGIN,
      source: { source: 'local', path: './codex' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Productivity',
    }],
  })

  rmSync(ctx.stageDir, { recursive: true, force: true })
  renameSync(tmp, ctx.stageDir)
  return { dir: ctx.stageDir, version }
}

export function unstage(ctx) {
  rmSync(ctx.stageDir, { recursive: true, force: true })
}
