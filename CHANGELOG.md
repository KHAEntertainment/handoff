# Changelog

## Unreleased

- Codex: hold a manual `/compact` once when no handoff is on disk, using the `PreCompact` hook (Codex 0.163 or later). The next prompt asks the agent for the handoff and to hand back; a second `/compact` goes through. Automatic compactions are never held, because stopping one aborts the agent's turn. The threshold check now finds the session's rollout under `$CODEX_HOME/sessions` (default `~/.codex`) when Codex sends no `transcript_path`, and reads the compact limit from `$CODEX_HOME/config.toml`. Adds `codex/test_context_handoff.py`.

## 0.1.2

- Claude Code: a typed `/compact` is held for a handoff again. Since Claude Code 2.1.301 the built-in `cc-plugin-sec-default` hands `session.compact` past user plugins in interactive sessions, so a bare `/compact` compacted at once with no handoff. The mod now holds the command on `command.run`, which it still receives. A command from the person's prompt (`composer`) is reported to the agent as the user's; from anywhere else (SDK, headless Traycer agents) the request still says the mod cannot tell who sent it. `/compact now` still compacts at once and, as before, points at a handoff already on disk; the 15-minute stray-`/compact` rule is unchanged. After a typed compaction, the pointer or tool-work note now rides on the command's output, once Claude Code reports `Compacted`. A manual compaction that reaches `session.compact` with no known source no longer says the user asked for it, even with instructions. A compaction Claude Code starts by itself still gets no note while `session.compact` is passed over. The `session.compact` handler stays for builds and modes where it still fires, guarded so one compaction is never decided twice.

## 0.1.1

- OpenCode: approve the plugin's own handoff permission asks (`external_directory`, `edit`, `read`) from the `permission.asked` event. Only for a tracked, non-child session and only when the ask names that session's exact handoff file (or its folder). Relative paths (the `edit` ask names its target relative to the session directory) are resolved against that session's own directory and approved only if they land on the handoff file; unresolved paths are never approved. Fixes resumed agents stalling on an unanswered ask under hosts that override user permission config. The `permission.ask` plugin hook is not called by OpenCode 1.18.

## 0.1.0

First public release. Claude Code plugin (repo root), plus experimental Codex and OpenCode ports under `codex/` and `opencode/`.
