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

Nothing to do. It watches the context fill and acts at the threshold (80% by default), or when you type `/compact`.

| You type | What happens |
|---|---|
| nothing, context reaches the threshold | The agent is asked for a handoff, writes it, ends its turn with `Handoff written.`, the session compacts, and the agent is told to read the handoff and continue. |
| `/compact` | Same flow. The command is held ("skipped") while the handoff is written, then the compaction runs by itself. |
| `/compact now` | Compacts at once, no handoff. Text after `now` is kept as compaction instructions. |
| `/compact <instructions>` | Handoff first, with your instructions passed on to the handoff request. |

After a bare `/compact` you see "Compaction postponed until the handoff is written", under the names of the plugins that hook the command. The compaction follows once the handoff is on disk.

Since Claude Code 2.1.301 the built-in `cc-plugin-sec-default` hands `session.compact` past user plugins in interactive sessions, so the mod holds a typed `/compact` on `command.run` instead. Where `session.compact` still reaches it (`claude -p`, for example), you may instead see the same text after "Not compacted ·", the label Claude Code draws for any skipped compaction.

With `autoCompact` off the text says to type `/compact` again once the handoff is ready, since nothing compacts by itself.

## Settings

Set through the plugin's options (`/plugin`, or `claude plugin configure handoff`).

| Key | Default | Meaning |
|---|---|---|
| `thresholdPercent` | 80 | How full the window gets before the handoff is requested. Measured against the compaction window when that is smaller than the model's. |
| `autoCompact` | true | Compact and resume on your behalf. Off: the agent tells you the handoff is ready and you compact. |

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
claude plugin test .      # 44 tests in hooks/register.test.ts
python3 -m unittest codex/test_context_handoff.py
node --test cli/installer.test.js
```

The editor types for `claude-code` are generated by Claude Code into `.claude-plugin/types/` (git-ignored).

The message prefix `[context-handoff]` in prompts and notes is the plugin's original name and is kept for continuity.

### Releasing

1. Set the same version in `package.json` and `.claude-plugin/plugin.json`, and turn the CHANGELOG's `## Unreleased` into `## <version>`.
2. Tag and push: `git tag v<version> && git push origin v<version>`.
3. `.github/workflows/release.yml` checks that the tag matches both versions, runs the tests, and stages the package on npm with trusted publishing (no npm token).
4. Approve the staged version with 2FA: `npm stage list @khaentertainment/handoff`, then `npm stage approve <id>`, or the Staged Packages tab on npmjs.com.
5. Create the GitHub release, then bump the `handoff` pin in [kha-marketplace](https://github.com/KHAEntertainment/marketplace).

## License

MIT. See [LICENSE](LICENSE).
