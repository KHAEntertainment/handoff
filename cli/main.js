import * as clack from '@clack/prompts'
import { HARNESS_IDS, HELP, isUnattended, parseArgs } from './args.js'
import * as claude from './claude.js'
import * as codex from './codex.js'
import * as opencode from './opencode.js'
import { PACKAGE_ROOT, packageInfo, stage, unstage } from './stage.js'
import { handoffHookTrust, trustLines } from './trust.js'
import { makeContext, readJson, tilde } from './util.js'
import { join } from 'node:path'

const HARNESSES = { claude, codex, opencode }
const LABELS = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' }

const describe = (ctx, info) =>
  info.present
    ? `${info.label} ${info.version ?? '(not on PATH)'}  ${tilde(ctx, info.home)}  ${info.installs.length ? `installed: ${info.installs.join('; ')}` : 'not installed'}`
    : `${info.label}  not found`

function detect(ctx) {
  return HARNESS_IDS.map((id) => HARNESSES[id].probe(ctx))
}

/** The ids to act on: --harness, else --all or unattended means every one found, else null (ask). */
function requested(args, found, unattended) {
  if (args.harness) return args.harness
  if (args.all || args.yes || unattended) return found.map((info) => info.id)
  return null
}

async function ask(prompt) {
  const answer = await prompt
  if (clack.isCancel(answer)) {
    clack.cancel('Cancelled. Nothing else was changed.')
    process.exit(130)
  }
  return answer
}

async function install(ctx, args, unattended) {
  const interactive = !args.yes && !unattended
  const probes = detect(ctx)
  const found = probes.filter((info) => info.present)
  clack.note(found.map((info) => describe(ctx, info)).join('\n') || 'none', `Found ${found.length} harness${found.length === 1 ? '' : 'es'}`)
  if (found.length === 0) {
    clack.outro('No Claude Code, Codex or OpenCode found.')
    return 1
  }

  let ids = requested(args, found, unattended)
  if (!ids) {
    ids = await ask(clack.multiselect({
      message: 'Install for which?  (space to toggle, enter to confirm)',
      required: true,
      initialValues: found.filter((info) => !(info.id === 'claude' && info.kha)).map((info) => info.id),
      options: found.map((info) => ({
        value: info.id,
        label: info.label,
        hint: HARNESSES[info.id].plan(info, { switchKha: false }).text,
      })),
    }))
  }

  const results = []
  const jobs = []
  for (const id of ids) {
    const info = probes.find((probe) => probe.id === id)
    if (!info.present) {
      results.push({ id, status: 'failed', message: `${info.label} not found on this machine` })
      continue
    }
    const options = { switchKha: args.switchClaude, replaceLegacy: true }
    if (interactive && info.kha && !args.switchClaude) {
      options.switchKha = await ask(clack.confirm({
        message: `Claude Code already has handoff ${info.khaVersion} from kha-marketplace. Switch to the npm copy? (Never both: they would each hold /compact.)`,
        initialValue: false,
      }))
    }
    if (interactive && info.legacy.length > 0) {
      options.replaceLegacy = await ask(clack.confirm({
        message: `${info.label}: replace the older install (${info.legacy.map((item) => item.text).join(', ')})? Copies go to ${tilde(ctx, ctx.backupDir)} first.`,
        initialValue: true,
      }))
      if (!options.replaceLegacy) {
        results.push({ id, status: 'skipped', message: 'left the older install alone; two copies would both hold /compact' })
        continue
      }
    }
    jobs.push({ id, info, options })
  }

  if (jobs.some((job) => HARNESSES[job.id].plan(job.info, job.options).action !== 'keep')) {
    try {
      const staged = stage(ctx)
      clack.log.step(`Staged handoff ${staged.version} in ${tilde(ctx, staged.dir)}`)
    } catch (error) {
      clack.log.error(`Could not stage the plugin files: ${error.message}`)
      return 1
    }
  }
  for (const { id, info, options } of jobs) {
    try {
      const done = HARNESSES[id].install(ctx, info, options)
      for (const warning of done.warnings ?? []) clack.log.warn(`${info.label}: ${warning}`)
      results.push({ id, ...done })
    } catch (error) {
      results.push({ id, status: 'failed', message: error.message })
    }
  }
  return report(results, 'Done. Run `npx @khaentertainment/handoff status` any time to check.')
}

function report(results, doneText) {
  for (const { id, status, message } of results) {
    const text = `${LABELS[id]}: ${message}`
    if (status === 'failed') clack.log.error(text)
    else if (status === 'ok') clack.log.success(text)
    else clack.log.info(text)
  }
  const failed = results.some((result) => result.status === 'failed')
  clack.outro(failed ? 'Finished with errors.' : doneText)
  return failed ? 1 : 0
}

async function uninstall(ctx, args, unattended) {
  const probes = detect(ctx)
  const ids = (args.harness ?? HARNESS_IDS).filter((id) => probes.find((info) => info.id === id).ours)
  clack.note(probes.map((info) => describe(ctx, info)).join('\n'), 'Installs')
  if (ids.length === 0) {
    clack.outro('No handoff install of this installer found. Older manual installs and kha-marketplace are never touched here.')
    return 0
  }
  if (!args.yes && !unattended) {
    await ask(clack.confirm({ message: `Remove handoff from ${ids.join(', ')}?`, initialValue: true })) || process.exit(0)
  }
  const results = []
  for (const id of ids) {
    try {
      results.push({ id, ...HARNESSES[id].uninstall(ctx, probes.find((info) => info.id === id)) })
    } catch (error) {
      results.push({ id, status: 'failed', message: error.message })
    }
  }
  // The staged marketplace goes once neither Claude Code nor Codex still installs from it.
  const stillUsed = probes.some((info) => (info.id === 'claude' || info.id === 'codex') && info.ours && !ids.includes(info.id))
  if (!stillUsed && !results.some((result) => result.status === 'failed')) unstage(ctx)
  return report(results, 'Removed.')
}

async function status(ctx) {
  const probes = detect(ctx)
  const stagedVersion = readJson(join(ctx.stageDir, 'claude', '.claude-plugin', 'plugin.json'))?.version
  clack.intro(`handoff ${packageInfo().version}: status`)
  for (const info of probes) {
    const lines = [describe(ctx, info)]
    if (info.id === 'claude' && info.kha && info.ours) lines.push('  both copies are installed: remove one, they each hold /compact')
    if (info.id === 'opencode' && info.ours) lines.push(`  plugins/handoff.js is ${opencode.isCurrent(ctx) ? 'the version shipped with this package' : 'different from this package version'}`)
    if (info.id === 'codex' && info.version && (info.ours || info.legacy.length > 0)) {
      const trust = await handoffHookTrust(ctx)
      if (trust.error) lines.push(`  hook trust: unknown (${trust.error})`)
      else {
        const found = trustLines(trust.hooks)
        if (found.length === 0 && info.ours) found.push('plugin: no handoff hooks registered')
        lines.push(...found.map((line) => `  ${line}`))
      }
    }
    clack.log.message(lines.join('\n'))
  }
  clack.outro(stagedVersion ? `Staged marketplace: ${tilde(ctx, ctx.stageDir)} (${stagedVersion})` : 'No staged marketplace.')
  return 0
}

export async function main(argv, env = process.env) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    console.error(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (args.help) return console.log(HELP), 0
  if (args.version) return console.log(packageInfo().version), 0
  const ctx = makeContext(env)
  const unattended = isUnattended(env, process.stdin.isTTY && process.stdout.isTTY)
  if (args.command === 'status') return status(ctx)
  clack.intro(`handoff ${packageInfo().version}: write a resume handoff before compaction`)
  return args.command === 'uninstall' ? uninstall(ctx, args, unattended) : install(ctx, args, unattended)
}
