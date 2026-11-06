# handoff

Makes the agent write itself a resume note before its context is compacted, compacts, then points it back at the note. Built for Claude Code; ports for Codex and OpenCode.

Compaction keeps the conversation text only in part and drops tool inputs and outputs. Without a handoff, the agent comes out of a compaction knowing roughly what you talked about but not what it was in the middle of. With one, it reads its own notes and carries on.

## Install

For Claude Code, Codex and OpenCode in one go:

```
npx @khaentertainment/handoff
```

It finds the harnesses on this machine, shows their versions and any handoff already installed, and lets you pick all or some. For scripts and agents:

```
npx @khaentertainment/handoff --harness claude,codex,opencode -y     # or --all
npx @khaentertainment/handoff status                                 # versions, install locations, Codex hook approval
npx @khaentertainment/handoff uninstall
```

Inside an agent, in CI, or without a terminal it skips the prompts and uses every harness it finds. User scope only. Needs Node 20.12 or later.

What it does, per harness:

| Harness | Installs | Notes |
|---|---|---|
| Claude Code | `claude plugin marketplace add ~/.handoff/marketplace`, then `claude plugin install handoff@handoff` | If `handoff@kha-marketplace` is installed, it is kept and Claude is skipped. `--switch-claude` replaces it. Never both: each would hold `/compact`. |
| Codex | `codex plugin marketplace add ~/.handoff/marketplace`, then `codex plugin add handoff@handoff` | Approve the plugin's 5 hooks in Codex's `/hooks` screen; Codex runs none of them until then. Needs `python3` on `PATH`. |
| OpenCode | Copies the plugin to `~/.config/opencode/plugins/handoff.js` | No `opencode.json` edit. A `handoff.js` it did not write (or that was edited since) is never replaced or removed unless you pass `--force`, which backs it up first. |

It copies this package version's files to `~/.handoff/marketplace` first, so every harness gets the same version. To upgrade, run `npx @khaentertainment/handoff@latest` again.

An older manual install is replaced after you confirm (`-y` confirms): Codex `hooks.json` entries that run `context_handoff.py` and the `~/.codex/hooks/context-handoff` link (in `$CODEX_HOME` if set), and an OpenCode `plugins/context-handoff.js` file or link. Copies go to `~/.handoff/backups/<time>/` first, and the old install is removed only after the new one succeeds; if that cleanup fails, the new install is rolled back. A marketplace named `handoff` that points somewhere other than `~/.handoff/marketplace` is never used or removed.

Claude Code only, from the marketplace:

```
/plugin marketplace add KHAEntertainment/kha-marketplace
/plugin install handoff@kha-marketplace
```

Needs a Claude Code build with module hooks (`command.run`, `session.compact`, `turn.complete`); tested on 2.1.305.

Load one copy only. If you ran the mod before it was a plugin (a `~/.claude/mods/context-handoff` link or folder), remove that copy when you install this one: two copies each decide the same `/compact`, and the old one can hold a `/compact now` the new one let through.

## Use

Nothing to do. It watches the context fill and acts at the threshold (80% by default), when you type `/compact`, or before a large interactive Claude session has been idle for 45 minutes.

| You type | What happens |
|---|---|
| nothing, context reaches the threshold | The agent is asked for a handoff, writes it, ends its turn with `Handoff written.`, the session compacts, and the agent is told to read the handoff and continue. |
| nothing, a large Claude session stays idle | After 45 minutes, the agent is asked for a handoff, then follows the same compact/resume flow. See the eligibility and timing limits below. |
| `/compact` | Same flow. The command is held ("skipped") while the handoff is written, then the compaction runs by itself. |
| `/compact now` | Compacts at once, no handoff. Text after `now` is kept as compaction instructions. |
| `/compact <instructions>` | Handoff first, with your instructions passed on to the handoff request. |

After a bare `/compact` you see "Compaction postponed until the handoff is written", under the names of the plugins that hook the command. The compaction follows once the handoff is on disk.

Since Claude Code 2.1.301 the built-in `cc-plugin-sec-default` hands `session.compact` past user plugins in interactive sessions, so the mod holds a typed `/compact` on `command.run` instead. Where `session.compact` still reaches it (`claude -p`, for example), you may instead see the same text after "Not compacted ·", the label Claude Code draws for any skipped compaction.

With `autoCompact` off the text says to type `/compact` again once the handoff is ready, since nothing compacts by itself.

### Idle compaction in Claude Code

Claude Code can compact while idle even below the handoff fill threshold. That path does not run `/compact`, and the built-in security default can skip the plugin's `session.compact` hook. The plugin therefore requests a handoff proactively, after 45 minutes without primary-session activity, rather than trying to stop that compaction afterwards.

The timer runs in interactive sessions only, with the plugin's `autoCompact` on, Claude's `idleCompaction` setting not off, and automatic compaction enabled for the session as Claude reports it (so `/config` and `DISABLE_AUTO_COMPACT` both count). It requires at least 200,000 context tokens and honors `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` (minimum 100,000). A new prompt, primary turn, tool call, compaction, or session end cancels the deadline. Interrupted turns do not arm it. A callback delayed more than two minutes, for example by sleep, is discarded.

This starts a model turn while you are away. It is an early fallback, not a veto on native compaction: it cannot guarantee a handoff if Claude compacts first, the machine sleeps past the deadline, or the handoff turn is refused or cannot finish. Your tool permissions still apply; a handoff-file approval can leave the turn waiting for you. Unlike the native idle trigger, it does not inspect prompt-cache TTL, so it may also request a handoff after a shorter cache has expired. Set `idleHandoffMinutes` to `0` to disable it. Your Claude settings are never rewritten.

## Settings

Set through the plugin's options (`/plugin`, or `claude plugin configure handoff`).

| Key | Default | Meaning |
|---|---|---|
| `thresholdPercent` | 80 | How full the window gets before the handoff is requested. Measured against the compaction window when that is smaller than the model's. |
| `autoCompact` | true | Compact and resume on your behalf. Off: the agent tells you the handoff is ready and you compact. |
| `idleHandoffMinutes` | 45 | Claude only: request a handoff after this many idle minutes in an eligible interactive session. `0` disables it; values above `45` are capped to leave time before native idle compaction. |

## How it works

Phases: `armed` (watching the fill) -> `nudged` (handoff asked for) -> `ready` (handoff on disk) -> `cooling` (just compacted; waits for the fill to drop 5 points under the threshold before watching again).

1. At the threshold, or on `/compact`, the agent is asked for a handoff: goal, state now, what is in play, what was ruled out, next steps, what must survive.
2. The agent ends its turn with `Handoff written.`; the plugin compacts, with instructions that keep the handoff path in the summary.
3. After compaction the agent is told to read the handoff in full and continue. If it says the work is finished or it is waiting, it does nothing more.
4. If the turn ends with the handoff still missing, the agent is asked once more. If a compaction happens without a handoff, a mechanical digest (files edited, last shell commands) is added instead.

A bare `/compact` that arrives within 15 minutes of a compaction, with no handoff on disk and the fill below threshold minus 5, is ignored. `/compact now` and `/compact <instructions>` are never ignored.

### Where the handoff goes

- Default: `~/.claude/handoffs/<session>.md`
- Under [Traycer](https://traycer.ai) (when `TRAYCER_EPIC_ID` is set): a spec artifact at `~/.traycer/epics/<epic>/artifacts/session-handoff-<agent>/index.md`

The plugin also writes small debug files in `~/.claude/handoffs/` (`.last-loaded.json`, `.compact-events-<session>.json`). They never block anything and can be deleted freely.

### Optional: i-have-adhd reminder

If the `i-have-adhd` plugin's marker file `~/.claude/.i-have-adhd-always` exists, a compaction ends with a one-line reminder to follow its rules. Without the file, nothing happens.

## Failure behaviour

It fails open: if a step errors, the compaction or the session carries on as if the plugin were not there. To switch it off, `/plugin disable handoff`.

## Other harnesses (experimental)

The installer above sets these up. By hand:

- `opencode/context-handoff.js`: copy or symlink to `~/.config/opencode/plugins/`. Working. It approves its own handoff-folder permission asks, because a resumed agent reading the handoff would otherwise wait on a prompt nobody answers in headless hosts.
- `codex/` (`.codex-plugin/plugin.json`, `hooks.json`, `context_handoff.py`): Codex hooks cannot start a compaction, so this version asks for the handoff near Codex's auto-compact limit and re-points the agent afterwards. A manual `/compact` with no handoff on disk is held once (`PreCompact`, Codex 0.163 or later), the next prompt asks for the handoff, and a second `/compact` goes through. An automatic compaction is never held. The installer makes it a Codex plugin that brings its own hooks. To wire it by hand instead, register it in `hooks.json` in the active Codex home (`$CODEX_HOME/hooks.json`, default `~/.codex/hooks.json`), then approve the hooks in Codex's `/hooks` screen: Codex runs only hooks it trusts, and any edit to a hook resets its approval.

  ```json
  {
    "hooks": {
      "PostToolUse":      [{ "hooks": [{ "type": "command", "command": "python3 /path/to/codex/context_handoff.py post-tool", "timeout": 10 }] }],
      "Stop":             [{ "hooks": [{ "type": "command", "command": "python3 /path/to/codex/context_handoff.py stop", "timeout": 10 }] }],
      "PreCompact":       [{ "matcher": "manual", "hooks": [{ "type": "command", "command": "python3 /path/to/codex/context_handoff.py pre-compact", "timeout": 10 }] }],
      "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "python3 /path/to/codex/context_handoff.py prompt", "timeout": 10 }] }],
      "SessionStart":     [{ "matcher": "compact", "hooks": [{ "type": "command", "command": "python3 /path/to/codex/context_handoff.py session-start", "timeout": 10 }] }]
    }
  }
  ```

## Development

```
claude plugin validate .
claude plugin test .      # 66 tests in hooks/register.test.ts
python3 -m unittest codex/test_context_handoff.py
node --test cli/installer.test.js
```

The editor types for `claude-code` are generated by Claude Code into `.claude-plugin/types/` (git-ignored).

The message prefix `[context-handoff]` in prompts and notes is the plugin's original name and is kept for continuity.

### Releasing

1. Set the same version in `package.json`, `.claude-plugin/plugin.json` and `codex/.codex-plugin/plugin.json`, and turn the CHANGELOG's `## Unreleased` into `## <version>`.
2. Merge the change to `main` through a pull request, as for any change.
3. Tag the merged commit on `main` and push the tag: `git tag v<version>`, then `git push origin v<version>`. The tag must point at the commit with the new versions, or the tag check fails.
4. `.github/workflows/release.yml` checks that the tag matches the versions in `package.json`, `.claude-plugin/plugin.json` and `codex/.codex-plugin/plugin.json`, runs the tests, and stages the package on npm with trusted publishing (no npm token). Pre-release tags such as `v0.3.0-rc.1` are staged under the `next` dist-tag, so they do not replace `latest`.
5. Approve the staged version with 2FA: `npm stage list @khaentertainment/handoff`, then `npm stage approve <id>`, or the Staged Packages tab on npmjs.com. Nothing is public until you approve it.
6. Create the GitHub release, then open one PR in [kha-marketplace](https://github.com/KHAEntertainment/marketplace) that bumps the `handoff` pin (`source.ref` in `.claude-plugin/marketplace.json`) and brings handoff's entry in its `README.md` up to date with this release: summary, install command and "After install" line, with no current or pinned version. Its `AGENTS.md` and the README's "Updating a plugin" section have the rule.

A merge to `main` does not publish. Only a pushed `v*` tag does.

## License

MIT. See [LICENSE](LICENSE).
