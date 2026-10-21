# handoff

A Claude Code plugin that makes the agent write itself a resume note before its context is compacted, compacts, then points it back at the note.

Compaction keeps the conversation text only in part and drops tool inputs and outputs. Without a handoff, the agent comes out of a compaction knowing roughly what you talked about but not what it was in the middle of. With one, it reads its own notes and carries on.

## Install

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

Manual installs, no packaging yet:

- `opencode/context-handoff.js`: copy or symlink to `~/.config/opencode/plugins/`. Working. It approves its own handoff-folder permission asks, because a resumed agent reading the handoff would otherwise wait on a prompt nobody answers in headless hosts.
- `codex/context_handoff.py`: Codex hooks cannot start a compaction, so this version asks for the handoff near Codex's auto-compact limit and re-points the agent afterwards. In progress.

## Development

```
claude plugin validate .
claude plugin test .      # 42 tests in hooks/register.test.ts
```

The editor types for `claude-code` are generated by Claude Code into `.claude-plugin/types/` (git-ignored).

The message prefix `[context-handoff]` in prompts and notes is the plugin's original name and is kept for continuity.

## License

MIT. See [LICENSE](LICENSE).
