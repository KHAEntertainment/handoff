export const HARNESS_IDS = ['claude', 'codex', 'opencode']
const ALIASES = { 'claude-code': 'claude', claudecode: 'claude' }

export const HELP = `handoff: write a resume handoff before compaction, then resume from it.

Usage: handoff [install|status|uninstall] [options]

Options:
  --harness <list>   Comma-separated: claude, codex, opencode
  --all              Every harness found on this machine
  -y, --yes          No prompts; confirm replacing older installs
  --force            Back up and replace a plugins/handoff.js that handoff did not install
  --switch-claude    Replace handoff@kha-marketplace with the npm copy (default: keep it and skip Claude)
  -v, --version      Print the version
  -h, --help         Print this help

Without --harness, --all or -y, the harnesses are picked from a list. Inside an agent, in CI, or without a
terminal, prompts are skipped and every harness found is used. User scope only.`

/** Parses argv (without node and script). Throws on anything it does not know. */
export function parseArgs(argv) {
  const out = { command: 'install', harness: null, all: false, yes: false, switchClaude: false, force: false, help: false, version: false }
  let sawCommand = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--harness' || arg.startsWith('--harness=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i]
      if (!value) throw new Error('--harness needs a value, for example --harness claude,codex')
      out.harness ??= []
      const names = value.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean)
      if (names.length === 0) throw new Error(`--harness "${value}" names no harness. Use: ${HARNESS_IDS.join(', ')}`)
      for (const raw of names) {
        const id = ALIASES[raw] ?? raw
        if (!HARNESS_IDS.includes(id)) throw new Error(`Unknown harness "${raw}". Use: ${HARNESS_IDS.join(', ')}`)
        if (!out.harness.includes(id)) out.harness.push(id)
      }
    } else if (arg === '--all') out.all = true
    else if (arg === '-y' || arg === '--yes') out.yes = true
    else if (arg === '--switch-claude') out.switchClaude = true
    else if (arg === '--force') out.force = true
    else if (arg === '-h' || arg === '--help') out.help = true
    else if (arg === '-v' || arg === '--version') out.version = true
    else if (!arg.startsWith('-') && !sawCommand) {
      if (!['install', 'status', 'uninstall'].includes(arg)) throw new Error(`Unknown command "${arg}". Use install, status or uninstall`)
      out.command = arg
      sawCommand = true
    } else throw new Error(`Unknown option "${arg}"`)
  }
  if (out.harness && out.all) throw new Error('Use either --harness or --all, not both')
  return out
}

const AGENT_VARS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'CODEX_CI', 'OPENCODE', 'AGENT', 'AI_AGENT', 'CURSOR_AGENT', 'GEMINI_CLI', 'CI']

/** True when no person is at the prompt: an agent, CI, or no terminal. */
export function isUnattended(env, tty) {
  return !tty || AGENT_VARS.some((name) => isSet(env[name]))
}

/** An env var counts when it has a value other than an explicit "off": CI=false and CI=0 are not CI. */
const isSet = (value) => Boolean(value) && !/^(0|false|no|off)$/i.test(value.trim())
