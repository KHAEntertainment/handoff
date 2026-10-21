# Changelog

## 0.1.1

- OpenCode: approve the plugin's own handoff permission asks (`external_directory`, `edit`, `read`) from the `permission.asked` event. Only for a tracked, non-child session and only when the ask names that session's exact handoff file (or its folder). Relative paths (the `edit` ask names its target relative to the session directory) are resolved against that session's own directory and approved only if they land on the handoff file; unresolved paths are never approved. Fixes resumed agents stalling on an unanswered ask under hosts that override user permission config. The `permission.ask` plugin hook is not called by OpenCode 1.18.

## 0.1.0

First public release. Claude Code plugin (repo root), plus experimental Codex and OpenCode ports under `codex/` and `opencode/`.
