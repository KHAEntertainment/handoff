// Runs the real CLI against a throwaway HOME with fake `claude`, `codex` and `opencode` on PATH that record
// their arguments. Nothing here touches the real ~/.claude, ~/.codex or ~/.config/opencode.
//
//   node --test cli/installer.test.js
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

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
if (process.env.FAKE_FAIL === name) { console.error('boom'); process.exit(1) }
`

const sandboxes = []
after(() => sandboxes.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

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
const json = (path) => JSON.parse(readFileSync(path, 'utf8'))
const oldHook = (mode) => ({ type: 'command', command: `/opt/homebrew/bin/python3 "/x/context-handoff/context_handoff.py" ${mode}`, timeout: 10 })
const FRESH = [
  'claude plugin marketplace add STAGE',
  'claude plugin install handoff@handoff',
  'codex plugin marketplace add STAGE',
  'codex plugin add handoff@handoff',
]

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
    sb.write('.claude/plugins/known_marketplaces.json', { handoff: { source: {} } })
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
      'claude plugin uninstall handoff@kha-marketplace',
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
    assert.equal(existsSync(sb.path('.handoff/backups')), false)
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

describe('status', () => {
  const hook = (key, trustStatus) => ({ key, command: 'python3 "$PLUGIN_ROOT/context_handoff.py" stop', trustStatus })
  const plugin = (n, trustStatus) => hook(`handoff@handoff:hooks.json:post_tool_use:${n}:0`, trustStatus)
  const manual = (n, trustStatus) => hook(`/home/x/.codex/hooks.json:stop:${n}:0`, trustStatus)

  test('reports plugin hook approval and older manual entries separately', () => {
    const sb = sandbox()
    sb.write('.codex/config.toml', '[plugins."handoff@handoff"]\nenabled = true\n')
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
    sb.write('.codex/config.toml', '[plugins."handoff@handoff"]\nenabled = true\n')
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
    sb.write('.claude/plugins/known_marketplaces.json', { handoff: {} })
    sb.write('.codex/config.toml', '[marketplaces.handoff]\nsource = "x"\n\n[plugins."handoff@handoff"]\nenabled = true\n')
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
    sb.write('.codex/config.toml', '[plugins."handoff@handoff"]\nenabled = true\n')
    writeFileSync(sb.path('calls.jsonl'), '')
    sb.run(['uninstall', '--harness', 'opencode', '-y'])
    assert.deepEqual(sb.calls(), [])
    assert.equal(existsSync(sb.path('.config/opencode/plugins/handoff.js')), false)
    sb.run(['uninstall', '--harness', 'claude', '-y'])
    assert.equal(existsSync(stage(sb)), true, 'codex still installs from it')
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
