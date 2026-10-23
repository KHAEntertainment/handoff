// Runs the real CLI against a throwaway HOME with fake `claude`, `codex` and `opencode` on PATH that record
// their arguments. Nothing here touches the real ~/.claude, ~/.codex or ~/.config/opencode.
//
//   node --test cli/installer.test.js
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { isUnattended } from './args.js'

const BIN = join(dirname(fileURLToPath(import.meta.url)), 'bin.js')
const FAKE = `#!${process.execPath}
const fs = require('node:fs')
const name = require('node:path').basename(process.argv[1])
const args = process.argv.slice(2)
fs.appendFileSync(process.env.HOME + '/calls.jsonl', JSON.stringify({ cmd: name, args }) + '\\n')
if (args[0] === '--version') { console.log(name + ' 9.9.9'); process.exit(0) }
if (name === 'codex' && args[0] === 'app-server') {
  require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line)
    if (message.id === 2) console.log(JSON.stringify({ id: 2, result: { data: [{ hooks: JSON.parse(process.env.FAKE_HOOKS || '[]') }] } }))
  })
  return
}
if (process.env.FAKE_FAIL === name || (process.env.FAKE_FAIL_ON && (name + ' ' + args.join(' ')).startsWith(process.env.FAKE_FAIL_ON))) { console.error('boom'); process.exit(1) }
`

const sandboxes = []
after(() => sandboxes.forEach((dir) => {
  spawnSync('chmod', ['-R', 'u+rwx', dir]) // a test may leave a locked folder behind, and so may its backup copy
  rmSync(dir, { recursive: true, force: true })
}))

function sandbox({ binaries = ['claude', 'codex', 'opencode'] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'handoff-test-'))
  sandboxes.push(root)
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  mkdirSync(home)
  mkdirSync(bin)
  for (const name of binaries) {
    writeFileSync(join(bin, name), FAKE)
    chmodSync(join(bin, name), 0o755)
  }
  const sb = {
    home,
    path: (...parts) => join(home, ...parts),
    write(file, content) {
      mkdirSync(dirname(sb.path(file)), { recursive: true })
      writeFileSync(sb.path(file), typeof content === 'string' ? content : JSON.stringify(content, null, 2))
    },
    /** The recorded harness calls, `--version` probes left out. */
    calls() {
      const log = sb.path('calls.jsonl')
      if (!existsSync(log)) return []
      return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
        .filter((call) => call.args[0] !== '--version' && call.args[0] !== 'app-server')
        .map((call) => `${call.cmd} ${call.args.join(' ')}`)
    },
    run(args, env = {}) {
      const done = spawnSync(process.execPath, [BIN, ...args], {
        env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, ...env },
        encoding: 'utf8',
        timeout: 60000,
      })
      return { code: done.status, out: done.stdout + done.stderr }
    },
  }
  return sb
}

const stage = (sb) => sb.path('.handoff', 'marketplace')
/** The registrations of the staged marketplace, as Claude Code and Codex record them. */
const claudeMarketplaces = (sb) => ({ handoff: { source: { source: 'directory', path: stage(sb) } } })
const codexConfig = (sb) => `[marketplaces.handoff]\nsource_type = "local"\nsource = "${stage(sb)}"\n\n[plugins."handoff@handoff"]\nenabled = true\n`
const unlessRoot = process.getuid?.() === 0 ? { skip: 'root ignores directory permissions' } : {}
const json = (path) => JSON.parse(readFileSync(path, 'utf8'))
const oldHook = (mode) => ({ type: 'command', command: `/opt/homebrew/bin/python3 "/x/context-handoff/context_handoff.py" ${mode}`, timeout: 10 })
const FRESH = [
  'claude plugin marketplace add STAGE',
  'claude plugin install handoff@handoff',
  'codex plugin marketplace add STAGE',
  'codex plugin add handoff@handoff',
]

describe('arguments and environment', () => {
  test('--harness that names no harness is an error', () => {
    const sb = sandbox()
    for (const args of [['--harness=,,'], ['--harness', ','], ['--harness=']]) {
      const { code, out } = sb.run(args)
      assert.equal(code, 2, args.join(' '))
      assert.match(out, /--harness|names no harness/)
    }
    assert.deepEqual(sb.calls(), [])
    assert.equal(existsSync(stage(sb)), false)
  })

  test('explicit false values of an agent or CI variable do not make a run unattended', () => {
    for (const value of ['', '0', 'false', 'FALSE', 'no', 'Off', ' false ']) {
      assert.equal(isUnattended({ CI: value, CLAUDECODE: value }, true), false, JSON.stringify(value))
    }
    for (const value of ['1', 'true', 'yes', 'claude-code']) assert.equal(isUnattended({ CI: value }, true), true, value)
    assert.equal(isUnattended({}, false), true, 'no terminal')
    assert.equal(isUnattended({ CI: 'false' }, false), true, 'no terminal')
  })
})

describe('detection', () => {
  test('status lists the version and home of each harness found', () => {
    const sb = sandbox()
    const { code, out } = sb.run(['status'])
    assert.equal(code, 0)
    for (const name of ['Claude Code 9.9.9', 'Codex 9.9.9', 'OpenCode 9.9.9']) assert.match(out, new RegExp(name))
    assert.match(out, /~\/\.config\/opencode/)
  })

  test('a harness counts as present when only its home exists', () => {
    const sb = sandbox({ binaries: [] })
    sb.write('.codex/config.toml', '')
    const { out } = sb.run(['status'])
    assert.match(out, /Codex \(not on PATH\)\s+~\/\.codex/)
    assert.match(out, /Claude Code\s+not found/)
  })

  test('install with nothing found fails and changes nothing', () => {
    const sb = sandbox({ binaries: [] })
    const { code, out } = sb.run(['-y'])
    assert.equal(code, 1)
    assert.match(out, /No Claude Code, Codex or OpenCode found/)
    assert.equal(existsSync(stage(sb)), false)
  })

  test('shows what is installed already, including the kha-marketplace copy', () => {
    const sb = sandbox()
    sb.write('.claude/plugins/installed_plugins.json', { version: 2, plugins: { 'handoff@kha-marketplace': [{ scope: 'user', version: '0.1.2' }] } })
    assert.match(sb.run(['status']).out, /installed: 0\.1\.2 \(kha-marketplace\)/)
  })
})

describe('install', () => {
  test('stages both marketplaces with the package version and the five Codex hooks', () => {
    const sb = sandbox()
    assert.equal(sb.run(['-y']).code, 0)
    const dir = stage(sb)
    const claudeMarketplace = json(join(dir, '.claude-plugin', 'marketplace.json'))
    assert.equal(claudeMarketplace.name, 'handoff')
    assert.deepEqual(claudeMarketplace.plugins.map((p) => [p.name, p.source]), [['handoff', './claude']])
    const codexMarketplace = json(join(dir, '.agents', 'plugins', 'marketplace.json'))
    assert.equal(codexMarketplace.name, 'handoff')
    assert.deepEqual(codexMarketplace.plugins[0].source, { source: 'local', path: './codex' })
    assert.equal(json(join(dir, 'claude', '.claude-plugin', 'plugin.json')).version, json(join(dirname(BIN), '..', 'package.json')).version)
    for (const file of ['claude/hooks/hooks.json', 'claude/hooks/register.ts', 'codex/context_handoff.py', 'opencode/context-handoff.js']) {
      assert.ok(existsSync(join(dir, file)), file)
    }
    const codexPlugin = json(join(dir, 'codex', '.codex-plugin', 'plugin.json'))
    assert.equal(codexPlugin.hooks, './hooks.json')
    const hooks = json(join(dir, 'codex', 'hooks.json')).hooks
    assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUse', 'PreCompact', 'SessionStart', 'Stop', 'UserPromptSubmit'])
    assert.equal(hooks.PreCompact[0].matcher, 'manual')
    assert.equal(hooks.SessionStart[0].matcher, 'compact')
    assert.equal(hooks.Stop[0].hooks[0].command, 'python3 "$PLUGIN_ROOT/context_handoff.py" stop')
  })

  test('the plugin manifests in the repo carry the package version', () => {
    const root = join(dirname(BIN), '..')
    const { version } = json(join(root, 'package.json'))
    assert.equal(json(join(root, '.claude-plugin', 'plugin.json')).version, version)
    assert.equal(json(join(root, 'codex', '.codex-plugin', 'plugin.json')).version, version)
  })

  test('runs the exact commands each harness needs and copies the OpenCode plugin', () => {
    const sb = sandbox()
    const { code, out } = sb.run(['-y'])
    assert.equal(code, 0, out)
    assert.deepEqual(sb.calls(), FRESH.map((c) => c.replace('STAGE', stage(sb))))
    assert.equal(readFileSync(sb.path('.config/opencode/plugins/handoff.js'), 'utf8'), readFileSync(join(dirname(BIN), '..', 'opencode', 'context-handoff.js'), 'utf8'))
    assert.match(out, /Approve its 5 hooks in Codex's \/hooks screen/)
  })

  test('--harness limits the install, and an unknown name is an error', () => {
    const sb = sandbox()
    assert.equal(sb.run(['--harness', 'codex']).code, 0)
    assert.deepEqual(sb.calls(), [`codex plugin marketplace add ${stage(sb)}`, 'codex plugin add handoff@handoff'])
    assert.equal(existsSync(sb.path('.config/opencode/plugins/handoff.js')), false)
    const bad = sb.run(['--harness', 'codex,vim'])
    assert.equal(bad.code, 2)
    assert.match(bad.out, /Unknown harness "vim"/)
  })

  test('a harness asked for by name but missing fails the run', () => {
    const sb = sandbox({ binaries: ['codex'] })
    const { code, out } = sb.run(['--harness', 'claude,codex', '-y'])
    assert.equal(code, 1)
    assert.match(out, /Claude Code: Claude Code not found/)
    assert.deepEqual(sb.calls(), [`codex plugin marketplace add ${stage(sb)}`, 'codex plugin add handoff@handoff'])
  })

  test('upgrades from the staged marketplace when ours is already installed', () => {
    const sb = sandbox()
    sb.write('.claude/plugins/installed_plugins.json', { version: 2, plugins: { 'handoff@handoff': [{ scope: 'user', version: '0.2.0' }] } })
    sb.write('.claude/plugins/known_marketplaces.json', claudeMarketplaces(sb))
    sb.run(['--harness', 'claude', '-y'])
    assert.deepEqual(sb.calls(), ['claude plugin marketplace update handoff', 'claude plugin update handoff@handoff'])
  })
})

describe('kha-marketplace', () => {
  const seed = (sb) => sb.write('.claude/plugins/installed_plugins.json', { version: 2, plugins: { 'handoff@kha-marketplace': [{ scope: 'user', version: '0.1.2' }] } })

  test('is kept by default: Claude is skipped, the others install', () => {
    const sb = sandbox()
    seed(sb)
    const { code, out } = sb.run(['-y'])
    assert.equal(code, 0)
    assert.match(out, /kept handoff@kha-marketplace 0\.1\.2/)
    assert.deepEqual(sb.calls(), FRESH.slice(2).map((c) => c.replace('STAGE', stage(sb))))
  })

  test('--switch-claude installs the npm copy first and only then removes the old one', () => {
    const sb = sandbox()
    seed(sb)
    sb.run(['--harness', 'claude', '--switch-claude', '-y'])
    assert.deepEqual(sb.calls(), [
      `claude plugin marketplace add ${stage(sb)}`,
      'claude plugin install handoff@handoff',
      'claude plugin uninstall handoff@kha-marketplace --scope user',
    ])
  })

  test('a failed install does not remove the kha-marketplace copy', () => {
    const sb = sandbox()
    seed(sb)
    const { code } = sb.run(['--harness', 'claude', '--switch-claude', '-y'], { FAKE_FAIL: 'claude' })
    assert.equal(code, 1)
    assert.equal(sb.calls().some((c) => c.includes('uninstall')), false)
  })
})

describe('older installs', () => {
  const seedCodex = (sb, home = '.codex') => {
    sb.write(`${home}/hooks.json`, {
      hooks: {
        Stop: [{ hooks: [oldHook('stop')] }, { hooks: [{ type: 'command', command: 'node graft.cjs stop' }] }],
        PreCompact: [{ matcher: 'manual', hooks: [oldHook('pre-compact')] }],
      },
    })
    mkdirSync(sb.path(home, 'hooks'), { recursive: true })
    symlinkSync('/somewhere/handoff/codex', sb.path(home, 'hooks', 'context-handoff'))
  }

  test('Codex: replaces the hooks.json entries and the link, keeps other hooks, backs up first', () => {
    const sb = sandbox()
    seedCodex(sb)
    const before = readFileSync(sb.path('.codex/hooks.json'), 'utf8')
    const { code, out } = sb.run(['--harness', 'codex', '-y'])
    assert.equal(code, 0, out)
    assert.deepEqual(json(sb.path('.codex/hooks.json')), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node graft.cjs stop' }] }] } })
    assert.equal(existsSync(sb.path('.codex/hooks/context-handoff')) || lstatExists(sb.path('.codex/hooks/context-handoff')), false)
    const [run] = readdirSync(sb.path('.handoff/backups'))
    const saved = join(sb.path('.handoff/backups'), run)
    assert.equal(readFileSync(join(saved, 'codex-hooks.json'), 'utf8'), before)
    assert.equal(readFileSync(join(saved, 'codex-hooks-context-handoff.symlink'), 'utf8').trim(), '/somewhere/handoff/codex')
  })

  test('Codex: leaves the old install alone when the new one fails', () => {
    const sb = sandbox()
    seedCodex(sb)
    const before = readFileSync(sb.path('.codex/hooks.json'), 'utf8')
    const { code } = sb.run(['--harness', 'codex', '-y'], { FAKE_FAIL: 'codex' })
    assert.equal(code, 1)
    assert.equal(readFileSync(sb.path('.codex/hooks.json'), 'utf8'), before)
    assert.ok(lstatExists(sb.path('.codex/hooks/context-handoff')))
  })

  test('Codex: follows $CODEX_HOME', () => {
    const sb = sandbox()
    seedCodex(sb, 'elsewhere')
    sb.run(['--harness', 'codex', '-y'], { CODEX_HOME: sb.path('elsewhere') })
    assert.deepEqual(json(sb.path('elsewhere/hooks.json')).hooks.Stop.length, 1)
    assert.equal(lstatExists(sb.path('elsewhere/hooks/context-handoff')), false)
  })

  test('OpenCode: replaces a context-handoff.js link with plugins/handoff.js', () => {
    const sb = sandbox()
    mkdirSync(sb.path('.config/opencode/plugins'), { recursive: true })
    symlinkSync('/somewhere/handoff/opencode/context-handoff.js', sb.path('.config/opencode/plugins/context-handoff.js'))
    const { code, out } = sb.run(['--harness', 'opencode', '-y'])
    assert.equal(code, 0, out)
    assert.equal(lstatExists(sb.path('.config/opencode/plugins/context-handoff.js')), false)
    assert.ok(existsSync(sb.path('.config/opencode/plugins/handoff.js')))
    const [run] = readdirSync(sb.path('.handoff/backups'))
    assert.equal(readFileSync(join(sb.path('.handoff/backups'), run, 'opencode-context-handoff.js.symlink'), 'utf8').trim(), '/somewhere/handoff/opencode/context-handoff.js')
  })
})

describe('OpenCode plugin ownership', () => {
  const plugin = (sb) => sb.path('.config/opencode/plugins/handoff.js')
  const backups = (sb) => (existsSync(sb.path('.handoff/backups')) ? readdirSync(sb.path('.handoff/backups')) : [])

  test('uninstall leaves a handoff.js it did not install', () => {
    const sb = sandbox()
    sb.write('.config/opencode/plugins/handoff.js', 'export const Mine = () => ({})\n')
    const { code, out } = sb.run(['uninstall', '-y'])
    assert.equal(code, 0)
    assert.match(out, /No handoff install of this installer found/)
    assert.equal(readFileSync(plugin(sb), 'utf8'), 'export const Mine = () => ({})\n')
  })

  test('uninstall leaves a copy that was edited after install, and status says so', () => {
    const sb = sandbox()
    sb.run(['--harness', 'opencode'])
    writeFileSync(plugin(sb), readFileSync(plugin(sb), 'utf8') + '// my tweak\n')
    assert.match(sb.run(['status']).out, /not installed by handoff, or edited since/)
    sb.run(['uninstall', '--harness', 'opencode', '-y'])
    assert.match(readFileSync(plugin(sb), 'utf8'), /my tweak/)
  })

  test('install records the file, and uninstall removes the record with the file', () => {
    const sb = sandbox()
    sb.run(['--harness', 'opencode'])
    assert.ok(plugin(sb) in json(sb.path('.handoff/state.json')).files)
    sb.run(['uninstall', '--harness', 'opencode', '-y'])
    assert.equal(existsSync(plugin(sb)), false)
    assert.deepEqual(json(sb.path('.handoff/state.json')).files, {})
  })

  test('install will not replace an unknown handoff.js without --force, then backs it up and replaces it', () => {
    const sb = sandbox()
    sb.write('.config/opencode/plugins/handoff.js', 'mine\n')
    const refused = sb.run(['--harness', 'opencode', '-y'])
    assert.equal(refused.code, 1)
    assert.match(refused.out, /Run with --force/)
    assert.equal(readFileSync(plugin(sb), 'utf8'), 'mine\n')
    assert.deepEqual(backups(sb), [])
    const forced = sb.run(['--harness', 'opencode', '-y', '--force'])
    assert.equal(forced.code, 0, forced.out)
    assert.notEqual(readFileSync(plugin(sb), 'utf8'), 'mine\n')
    const [run] = backups(sb)
    assert.equal(readFileSync(join(sb.path('.handoff/backups'), run, 'opencode-handoff.js'), 'utf8'), 'mine\n')
  })

  test('a handoff.js link is foreign: --force replaces the link, not its target', () => {
    const sb = sandbox()
    sb.write('elsewhere/mine.js', 'mine\n')
    mkdirSync(sb.path('.config/opencode/plugins'), { recursive: true })
    symlinkSync(sb.path('elsewhere/mine.js'), plugin(sb))
    assert.equal(sb.run(['--harness', 'opencode', '-y']).code, 1)
    assert.equal(sb.run(['--harness', 'opencode', '-y', '--force']).code, 0)
    assert.equal(lstatSync(plugin(sb)).isSymbolicLink(), false)
    assert.equal(readFileSync(sb.path('elsewhere/mine.js'), 'utf8'), 'mine\n')
  })

  test('a failed write leaves the installed plugin as it was', unlessRoot, () => {
    const sb = sandbox()
    sb.run(['--harness', 'opencode'])
    const before = readFileSync(plugin(sb), 'utf8')
    const dir = sb.path('.config/opencode/plugins')
    chmodSync(dir, 0o555)
    try {
      const { code } = sb.run(['--harness', 'opencode', '-y'])
      assert.equal(code, 1)
    } finally {
      chmodSync(dir, 0o755)
    }
    assert.equal(readFileSync(plugin(sb), 'utf8'), before)
    assert.deepEqual(readdirSync(dir), ['handoff.js'])
  })
})

describe('config file writes', () => {
  const legacyHooks = { hooks: { Stop: [{ hooks: [oldHook('stop')] }, { hooks: [{ type: 'command', command: 'node graft.cjs stop' }] }] } }

  test('a hooks.json that is a link: the real file is rewritten and backed up, the link stays', () => {
    const sb = sandbox()
    sb.write('dotfiles/codex-hooks.json', legacyHooks)
    const original = readFileSync(sb.path('dotfiles/codex-hooks.json'), 'utf8')
    mkdirSync(sb.path('.codex'), { recursive: true })
    symlinkSync(sb.path('dotfiles/codex-hooks.json'), sb.path('.codex/hooks.json'))
    const { code, out } = sb.run(['--harness', 'codex', '-y'])
    assert.equal(code, 0, out)
    assert.equal(lstatSync(sb.path('.codex/hooks.json')).isSymbolicLink(), true)
    assert.equal(readlinkSync(sb.path('.codex/hooks.json')), sb.path('dotfiles/codex-hooks.json'))
    assert.deepEqual(json(sb.path('dotfiles/codex-hooks.json')), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node graft.cjs stop' }] }] } })
    const [run] = readdirSync(sb.path('.handoff/backups'))
    assert.equal(readFileSync(join(sb.path('.handoff/backups'), run, 'codex-hooks.json'), 'utf8'), original)
    assert.deepEqual(readdirSync(sb.path('dotfiles')), ['codex-hooks.json'])
  })

  test('a write that fails leaves hooks.json untouched and rolls the Codex install back', unlessRoot, () => {
    const sb = sandbox()
    sb.write('.codex/hooks.json', legacyHooks)
    mkdirSync(sb.path('.codex/hooks'), { recursive: true })
    symlinkSync('/somewhere/handoff/codex', sb.path('.codex/hooks/context-handoff'))
    const before = readFileSync(sb.path('.codex/hooks.json'), 'utf8')
    chmodSync(sb.path('.codex'), 0o555)
    let result
    try {
      result = sb.run(['--harness', 'codex', '-y'])
    } finally {
      chmodSync(sb.path('.codex'), 0o755)
    }
    assert.equal(result.code, 1)
    assert.match(result.out, /Rolled back: .*removed handoff@handoff.*removed marketplace handoff/)
    assert.equal(readFileSync(sb.path('.codex/hooks.json'), 'utf8'), before)
    assert.equal(readlinkSync(sb.path('.codex/hooks/context-handoff')), '/somewhere/handoff/codex')
    assert.deepEqual(readdirSync(sb.path('.codex')).filter((name) => name.endsWith('.tmp')), [])
    assert.deepEqual(sb.calls(), [
      `codex plugin marketplace add ${stage(sb)}`,
      'codex plugin add handoff@handoff',
      'codex plugin remove handoff@handoff',
      'codex plugin marketplace remove handoff',
    ])
  })
})

describe('rollback when cleanup of the old copy fails', () => {
  const khaScopes = (sb, ...entries) => sb.write('.claude/plugins/installed_plugins.json', { version: 2, plugins: { 'handoff@kha-marketplace': entries } })

  test('Claude: a failed kha-marketplace uninstall removes the new copy again', () => {
    const sb = sandbox()
    khaScopes(sb, { scope: 'user', version: '0.1.2' })
    const { code, out } = sb.run(['--harness', 'claude', '--switch-claude', '-y'], { FAKE_FAIL_ON: 'claude plugin uninstall handoff@kha-marketplace' })
    assert.equal(code, 1)
    assert.match(out, /Rolled back: uninstalled handoff@handoff; removed marketplace handoff/)
    assert.deepEqual(sb.calls(), [
      `claude plugin marketplace add ${stage(sb)}`,
      'claude plugin install handoff@handoff',
      'claude plugin uninstall handoff@kha-marketplace --scope user',
      'claude plugin uninstall handoff@handoff',
      'claude plugin marketplace remove handoff',
    ])
  })

  test('Claude: every scope of the old copy is uninstalled, and a later failure reinstalls the earlier ones', () => {
    const sb = sandbox()
    mkdirSync(sb.path('work/app'), { recursive: true })
    khaScopes(sb, { scope: 'user', version: '0.1.2' }, { scope: 'project', version: '0.1.2', projectPath: sb.path('work/app') })
    const ok = sb.run(['--harness', 'claude', '--switch-claude', '-y'])
    assert.equal(ok.code, 0, ok.out)
    assert.deepEqual(sb.calls().slice(2), [
      'claude plugin uninstall handoff@kha-marketplace --scope user',
      'claude plugin uninstall handoff@kha-marketplace --scope project',
    ])

    const failing = sandbox()
    mkdirSync(failing.path('work/app'), { recursive: true })
    khaScopes(failing, { scope: 'user', version: '0.1.2' }, { scope: 'project', version: '0.1.2', projectPath: failing.path('work/app') })
    const { code, out } = failing.run(['--harness', 'claude', '--switch-claude', '-y'], { FAKE_FAIL_ON: 'claude plugin uninstall handoff@kha-marketplace --scope project' })
    assert.equal(code, 1)
    assert.match(out, /reinstalled handoff@kha-marketplace \(user scope\)/)
    assert.deepEqual(failing.calls().slice(-4), [
      'claude plugin uninstall handoff@kha-marketplace --scope project',
      'claude plugin install handoff@kha-marketplace --scope user',
      'claude plugin uninstall handoff@handoff',
      'claude plugin marketplace remove handoff',
    ])
  })

  test('Claude: an old copy whose project folder is gone is reported before anything is installed', () => {
    const sb = sandbox()
    khaScopes(sb, { scope: 'user', version: '0.1.2' }, { scope: 'project', version: '0.1.2', projectPath: sb.path('work/gone') })
    const { code, out } = sb.run(['--harness', 'claude', '--switch-claude', '-y'])
    assert.equal(code, 1)
    assert.match(out, /installed in project scope for .*work\/gone, but that folder does not exist/)
    assert.deepEqual(sb.calls(), [])
  })

  test('Claude: an upgrade that fails later does not uninstall the copy that was already there', () => {
    const sb = sandbox()
    sb.write('.claude/plugins/installed_plugins.json', { version: 2, plugins: { 'handoff@handoff': [{ scope: 'user', version: '0.2.0' }], 'handoff@kha-marketplace': [{ scope: 'user', version: '0.1.2' }] } })
    sb.write('.claude/plugins/known_marketplaces.json', claudeMarketplaces(sb))
    sb.run(['--harness', 'claude', '--switch-claude', '-y'], { FAKE_FAIL_ON: 'claude plugin uninstall handoff@kha-marketplace' })
    assert.equal(sb.calls().some((c) => c === 'claude plugin uninstall handoff@handoff' || c.includes('marketplace remove')), false)
  })
})

describe('a real legacy hooks folder', () => {
  const dir = (sb) => sb.path('.codex/hooks/context-handoff')
  /** A folder with a script and a locked subfolder: deleting it in place fails halfway. */
  const seed = (sb) => {
    sb.write('.codex/hooks/context-handoff/context_handoff.py', '# old hook\n')
    sb.write('.codex/hooks/context-handoff/zz-locked/keep.txt', 'keep\n')
    chmodSync(sb.path('.codex/hooks/context-handoff/zz-locked'), 0o555)
  }
  const unlock = (sb) => {
    for (const name of readdirSync(sb.path('.codex/hooks'))) {
      const locked = join(sb.path('.codex/hooks'), name, 'zz-locked')
      if (existsSync(locked)) chmodSync(locked, 0o755)
    }
  }

  test('a failure after the removal step restores the whole folder and removes the new copy', unlessRoot, () => {
    const sb = sandbox()
    seed(sb)
    sb.write('.codex/hooks.json', { hooks: { Stop: [{ hooks: [oldHook('stop')] }] } })
    chmodSync(sb.path('.codex'), 0o555) // the hooks.json edit, which comes after the folder is moved aside, fails
    let result
    try {
      result = sb.run(['--harness', 'codex', '-y'])
    } finally {
      chmodSync(sb.path('.codex'), 0o755)
    }
    try {
      assert.equal(result.code, 1)
      assert.match(result.out, /Rolled back: .*restored .*context-handoff.*removed handoff@handoff/)
      assert.equal(readFileSync(join(dir(sb), 'context_handoff.py'), 'utf8'), '# old hook\n')
      assert.equal(readFileSync(join(dir(sb), 'zz-locked', 'keep.txt'), 'utf8'), 'keep\n')
      assert.deepEqual(readdirSync(sb.path('.codex/hooks')), ['context-handoff'])
      assert.deepEqual(sb.calls().slice(-2), ['codex plugin remove handoff@handoff', 'codex plugin marketplace remove handoff'])
    } finally {
      unlock(sb)
    }
  })

  test('on success the old folder is gone from its place; if its copy cannot be deleted that is a warning with the path', unlessRoot, () => {
    const sb = sandbox()
    seed(sb)
    let result
    try {
      result = sb.run(['--harness', 'codex', '-y'])
      assert.equal(result.code, 0, result.out)
      assert.equal(existsSync(dir(sb)), false)
      assert.match(result.out, /could not be deleted .* Delete .*context-handoff\.handoff-removed-/)
      const [left] = readdirSync(sb.path('.codex/hooks'))
      assert.match(left, /^context-handoff\.handoff-removed-/)
      // The delete got as far as the locked subfolder; what is left is named in the warning, not in the old place.
      assert.equal(readFileSync(join(sb.path('.codex/hooks'), left, 'zz-locked', 'keep.txt'), 'utf8'), 'keep\n')
      // The backup taken before the install holds the whole folder.
      const [run] = readdirSync(sb.path('.handoff/backups'))
      assert.equal(readFileSync(join(sb.path('.handoff/backups'), run, 'codex-hooks-context-handoff', 'context_handoff.py'), 'utf8'), '# old hook\n')
    } finally {
      unlock(sb)
    }
  })

  test('on success with nothing locked, the moved-aside copy is deleted', () => {
    const sb = sandbox()
    sb.write('.codex/hooks/context-handoff/context_handoff.py', '# old hook\n')
    assert.equal(sb.run(['--harness', 'codex', '-y']).code, 0)
    assert.deepEqual(readdirSync(sb.path('.codex/hooks')), [])
  })
})

describe('marketplace named handoff that is not ours', () => {
  test('Claude: refuses without calling anything, and uninstall leaves it alone', () => {
    const sb = sandbox()
    sb.write('.claude/plugins/known_marketplaces.json', { handoff: { source: { source: 'github', repo: 'someone/else' } } })
    sb.write('.claude/plugins/installed_plugins.json', { version: 2, plugins: { 'handoff@handoff': [{ scope: 'user', version: '9.9.9' }] } })
    const { code, out } = sb.run(['--harness', 'claude', '-y'])
    assert.equal(code, 1)
    assert.match(out, /already registered from someone\/else/)
    assert.deepEqual(sb.calls(), [])
    assert.match(sb.run(['status']).out, /registered from someone\/else, not from handoff/)
    assert.match(sb.run(['uninstall', '-y']).out, /No handoff install of this installer found/)
    assert.deepEqual(sb.calls(), [])
  })

  test('Claude: a directory marketplace pointing somewhere else is foreign too', () => {
    const sb = sandbox()
    sb.write('.claude/plugins/known_marketplaces.json', { handoff: { source: { source: 'directory', path: sb.path('other') } } })
    assert.equal(sb.run(['--harness', 'claude', '-y']).code, 1)
    assert.deepEqual(sb.calls(), [])
  })

  test('Claude: a marketplace of ours is recognised through a different spelling of the path', () => {
    const sb = sandbox()
    mkdirSync(stage(sb), { recursive: true })
    symlinkSync(stage(sb), sb.path('stage-link'))
    sb.write('.claude/plugins/known_marketplaces.json', { handoff: { source: { source: 'directory', path: sb.path('stage-link') } } })
    sb.run(['--harness', 'claude', '-y'])
    assert.equal(sb.calls()[0], 'claude plugin marketplace update handoff')
  })

  test('Codex: refuses without calling anything, and uninstall leaves it alone', () => {
    const sb = sandbox()
    sb.write('.codex/config.toml', '[marketplaces.handoff]\nsource_type = "git"\nsource = "https://example.com/else.git"\n\n[plugins."handoff@handoff"]\nenabled = true\n')
    const { code, out } = sb.run(['--harness', 'codex', '-y'])
    assert.equal(code, 1)
    assert.match(out, /already registered from https:\/\/example\.com\/else\.git/)
    sb.run(['uninstall', '-y'])
    assert.deepEqual(sb.calls(), [])
  })

  test('Codex: a quoted table name and a different local path are read correctly', () => {
    const sb = sandbox()
    sb.write('.codex/config.toml', `[marketplaces."handoff"]\nsource_type = "local"\nsource = "${sb.path('other')}"\n`)
    assert.equal(sb.run(['--harness', 'codex', '-y']).code, 1)
    sb.write('.codex/config.toml', `[marketplaces."handoff"]\nsource_type = "local"\nsource = "${stage(sb)}"\n`)
    assert.equal(sb.run(['--harness', 'codex', '-y']).code, 0)
    assert.deepEqual(sb.calls(), ['codex plugin add handoff@handoff'])
  })
})

describe('status', () => {
  const hook = (key, trustStatus) => ({ key, command: 'python3 "$PLUGIN_ROOT/context_handoff.py" stop', trustStatus })
  const plugin = (n, trustStatus) => hook(`handoff@handoff:hooks.json:post_tool_use:${n}:0`, trustStatus)
  const manual = (n, trustStatus) => hook(`/home/x/.codex/hooks.json:stop:${n}:0`, trustStatus)

  test('reports plugin hook approval and older manual entries separately', () => {
    const sb = sandbox()
    sb.write('.codex/config.toml', codexConfig(sb))
    const hooks = JSON.stringify([
      plugin(0, 'trusted'), plugin(1, 'trusted'), plugin(2, 'trusted'), plugin(3, 'untrusted'), plugin(4, 'modified'),
      manual(0, 'trusted'), manual(1, 'trusted'),
      { key: 'other@x:hooks.json:stop:0:0', command: 'node other.js', trustStatus: 'untrusted' },
    ])
    const { code, out } = sb.run(['status'], { FAKE_HOOKS: hooks })
    assert.equal(code, 0)
    assert.match(out, /plugin: 3 of 5 approved \(1 untrusted, 1 modified\)/)
    assert.match(out, /manual hooks\.json entries: 2 \(older install; rerun install to replace\)/)
  })

  test('a fully approved plugin with no manual entries says only that', () => {
    const sb = sandbox()
    sb.write('.codex/config.toml', codexConfig(sb))
    const { out } = sb.run(['status'], { FAKE_HOOKS: JSON.stringify([plugin(0, 'trusted'), plugin(1, 'trusted')]) })
    assert.match(out, /plugin: 2 of 2 approved\n/)
    assert.doesNotMatch(out, /manual hooks/)
  })
})

describe('uninstall', () => {
  test('reverses the install and never touches kha-marketplace', () => {
    const sb = sandbox()
    sb.run(['-y'])
    sb.write('.claude/plugins/installed_plugins.json', { version: 2, plugins: { 'handoff@handoff': [{ version: '0.2.0' }], 'handoff@kha-marketplace': [{ version: '0.1.2' }] } })
    sb.write('.claude/plugins/known_marketplaces.json', claudeMarketplaces(sb))
    sb.write('.codex/config.toml', codexConfig(sb))
    writeFileSync(sb.path('calls.jsonl'), '')
    const { code, out } = sb.run(['uninstall', '-y'])
    assert.equal(code, 0, out)
    assert.deepEqual(sb.calls(), [
      'claude plugin uninstall handoff@handoff',
      'claude plugin marketplace remove handoff',
      'codex plugin remove handoff@handoff',
      'codex plugin marketplace remove handoff',
    ])
    assert.equal(existsSync(sb.path('.config/opencode/plugins/handoff.js')), false)
    assert.equal(existsSync(stage(sb)), false)
  })

  test('--harness removes only that harness and keeps the staged copy while another still uses it', () => {
    const sb = sandbox()
    sb.run(['-y'])
    sb.write('.claude/plugins/installed_plugins.json', { version: 2, plugins: { 'handoff@handoff': [{ version: '0.2.0' }] } })
    sb.write('.codex/config.toml', codexConfig(sb))
    writeFileSync(sb.path('calls.jsonl'), '')
    sb.run(['uninstall', '--harness', 'opencode', '-y'])
    assert.deepEqual(sb.calls(), [])
    assert.equal(existsSync(sb.path('.config/opencode/plugins/handoff.js')), false)
    sb.run(['uninstall', '--harness', 'claude', '-y'])
    assert.equal(existsSync(stage(sb)), true, 'codex still installs from it')
  })

  test('the staged copy stays while another harness still has a marketplace pointing at it, even with its plugin gone', () => {
    const sb = sandbox()
    sb.run(['--harness', 'codex', '-y'])
    sb.write('.codex/config.toml', codexConfig(sb))
    sb.write('.claude/plugins/known_marketplaces.json', claudeMarketplaces(sb))
    assert.equal(sb.run(['uninstall', '--harness', 'codex', '-y']).code, 0)
    assert.equal(existsSync(stage(sb)), true)
    // Once Codex is really gone (the fake leaves its config alone) and Claude's registration goes too, so does the staged copy.
    writeFileSync(sb.path('.codex/config.toml'), '')
    assert.equal(sb.run(['uninstall', '--harness', 'claude', '-y']).code, 0)
    assert.equal(existsSync(stage(sb)), false)
  })

  test('with nothing installed it says so and succeeds', () => {
    const sb = sandbox()
    const { code, out } = sb.run(['uninstall', '-y'])
    assert.equal(code, 0)
    assert.match(out, /No handoff install of this installer found/)
    assert.deepEqual(sb.calls(), [])
  })
})

function lstatExists(path) {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}
