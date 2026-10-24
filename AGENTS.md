# Agent guide: handoff

Read this before you change anything in this repo. `CLAUDE.md` imports this file, so Claude Code and other agents read the same instructions.

## What the repo ships

One repo, four pieces. The Claude Code plugin is the original product. The rest are ports and the installer that puts them on a machine.

| Path | What it is | Shipped how |
|---|---|---|
| `.claude-plugin/plugin.json`, `hooks/` | Claude Code plugin (`register.ts`, `hooks.json`) | Staged by `cli/stage.js` |
| `codex/` | Codex plugin (`.codex-plugin/plugin.json`, `hooks.json`, `context_handoff.py`) | Staged by `cli/stage.js` |
| `opencode/context-handoff.js` | OpenCode plugin | Copied by `cli/stage.js` and `cli/opencode.js` |
| `cli/` | The npm installer, `@khaentertainment/handoff` (`npx @khaentertainment/handoff`) | `package.json` `bin` |

Two lists must agree when you add a file that ships. `cli/stage.js` copies each plugin file into `~/.handoff/marketplace`, and `package.json` `files` controls what npm publishes. A new shipped file needs both entries. Test files are excluded from npm by the `!cli/*.test.js` entry.

The installer copies the plugin files from the package it is running from, which is the npm package under `npx` or this checkout when run from it, into `~/.handoff/marketplace`. It does not fetch from GitHub. A change reaches a machine only after a fresh install from the matching package.

## Commands

Run `npm ci` first. It installs `@clack/prompts`, which the installer needs.

```
claude plugin validate .                          # manifest and layout
claude plugin test .                              # 44 tests, hooks/register.test.ts
node --test cli/installer.test.js                 # 45 tests, runs the real CLI in a throwaway HOME
python3 -m unittest codex/test_context_handoff.py # 27 tests
```

Run all four before you open a PR. The installer tests use fake `claude`, `codex` and `opencode` binaries on `PATH`. They never touch the real `~/.claude`, `~/.codex` or `~/.config/opencode`, so keep it that way.

CI (`.github/workflows/release.yml`, job `test`) runs only the installer tests and the Codex tests, on Ubuntu with Node 24 and Python 3.12. It does not run `claude plugin validate` or `claude plugin test`, so those two are your job before the PR.

If you change the number of tests in `hooks/register.test.ts`, update the `44` in the README's Development section.

## Claude Code hook: invariants

`hooks/register.ts` is one module. These rules come from the original design and from the review of the `command.run` change in 0.1.2. Keep them unless the user says otherwise.

- **Catch a typed `/compact` on `command.run`, not `session.compact` alone.** Since Claude Code 2.1.301, the built-in `cc-plugin-sec-default` passes `session.compact` over user plugins in interactive sessions. A `command.run` hook still runs.
- **Never claim the user typed it unless the origin is `composer`.** A `session.compact` event with trigger `manual` can fire for a `/compact` nobody typed. Without a `composer` origin, the request says the mod cannot tell who sent it.
- **Keep the 15-minute stray rule as it is.** A bare `/compact` within 15 minutes of a compaction, with no handoff on disk and the context nearly empty, is ignored. `/compact now` and `/compact <instructions>` are never ignored. Do not widen the rule.
- **`/compact now` still points at a handoff already on disk.** It does not wait for a new one.
- **Own-run identity.** The mod's own fallback runs `$.command.run({command:'compact', args})` with an `OWN_COMPACT` marker and `isOwnPending=true`. The new handler must let it through and clear `isOwnPending` exactly once. Otherwise the next typed `/compact` is taken for the mod's own.
- **Never call `$.command.run` from inside the command handler.** The handoff request goes out through `$.prompt.submit` after the 500 ms `clock.after`, so the skip reply lands first.
- **Every compaction path sets `phase = 'cooling'` and `lastCompactAt`.** The stray guard and the 75% re-arm depend on both.
- **Ignore subagent events (`e.agentId !== undefined`) and precompute.** Both return early, before anything is latched.
- **A compaction counts as done only when Claude Code reports it.** Use the result of the `session.compact` call when that event reaches this copy. Otherwise match the command output that begins `Compacted`. Do not infer a compaction from the message count, because a short transcript can compact into the same number of rows.

## Testing a hook change

Unit tests mock the host, and the mocks have passed while production skipped the hook. Before you call a hook change done, check it in a real Claude Code session.

- Test the copy you changed. Use `claude --plugin-dir <this checkout>`. Run it from an existing directory: the terminal's working directory must still exist, or `claude` refuses to start.
- Test interactively. `claude -p` is not a substitute: the 2.1.305 checks in 0.1.2 that counted were run in an interactive session.
- Never load two copies at once. A plugin install and a `~/.claude/mods/context-handoff` symlink both hold `/compact`. On the maintainer's Mac that symlink points to an older copy: remove it once the plugin is installed.
- The `headless`/SDK fallback (Traycer agents) has no test that reaches it. Say so in the PR rather than implying it's covered.

## Versions and changelog

A release bumps the version in three places, and they must agree before a tag is pushed:

- `package.json` `version`
- `.claude-plugin/plugin.json` `version`
- `codex/.codex-plugin/plugin.json` `version`. `cli/stage.js` overwrites this at staging time, but keep the source file correct.

Add user-facing changes to `CHANGELOG.md` under `## Unreleased`. When the release is cut, rename that heading to the version. The workflow does not read the changelog.

## Release and npm publishing

### What triggers a publish

Publishing happens only when a tag matching `v*` is pushed to GitHub. Nothing else publishes:

| Event | What runs | Publishes? |
|---|---|---|
| Pull request | `test` job | No |
| Push to `main`, or any push that is not a tag | Nothing | No |
| Push of a tag matching `v*` | `test` job, then `publish` job | Stages a release, pending approval |

A version bump merged to `main` does not publish. The tag is the release. A pre-release tag such as `v0.3.0-rc.1` also matches `v*`. The workflow stages it under the `next` dist-tag, so it does not replace `latest`.

### What the workflow does on a tag

1. **`test` job.** Checks that the tag, without its `v`, equals the version in `package.json`, `.claude-plugin/plugin.json` and `codex/.codex-plugin/plugin.json`. If any differs, the job fails. Then it runs the installer and Codex tests.
2. **`publish` job**, which runs only if `test` passes.
   - If `@khaentertainment/handoff@<version>` already exists on npm, it does nothing.
   - Otherwise it runs `npm stage publish --access public --tag <tag>`. The tag is `next` for a pre-release, or for a version lower than the latest on npm. It is `latest` otherwise.
   - It authenticates with npm trusted publishing (`id-token: write`). There is no npm token in the repo or in GitHub secrets.

### Staged means not yet live

`npm stage publish` puts the version in a staging queue. Nothing reaches users until a maintainer approves it with 2FA:

```
npm stage list @khaentertainment/handoff
npm stage approve <id>
```

The Staged Packages tab on npmjs.com does the same thing. Until approval, `npx @khaentertainment/handoff` still serves the previous version.

### Release steps

Follow these in order. The tag must point at the commit that holds the new versions, or the tag check fails.

1. Bump the version in the three places above, and turn the changelog's `## Unreleased` into `## <version>`.
2. Commit the change: `git commit -am "Release v<version>"`. Merge it to `main` through a PR, as for any change.
3. Tag the merged commit on `main` and push the tag: `git tag v<version>` then `git push origin v<version>`.
4. Watch the `release` workflow in GitHub Actions. Fix any failure before approving anything.
5. Approve the staged version with 2FA (see above).
6. Create the GitHub release, then bump the `handoff` pin in [kha-marketplace](https://github.com/KHAEntertainment/marketplace).

Do not push a `v*` tag unless the user has asked for that release. A tag push starts a publish. The staging queue and 2FA approval protect against an accidental public release, but they do not stop the staging.

### Before the first publish

- The npm trusted publisher must name this repo and `release.yml` exactly, as the header of `release.yml` says. Keep the filename.
- npm trusted publishers have an expiry: a publisher that has not published in time can lapse. If the first publish has not run yet, recreate the publisher just before tagging. Check the current rule on npmjs.com before relying on it.
- The `publish` job has not run yet. Its first real run will show whether staging, the dist-tag selection and the approval flow all behave as described here. Record the result in `CHANGELOG.md` or the PR, and fix this section if anything differs.

## Pull requests

- Work on a branch and open a PR to `main`. Do not push to `main` directly.
- Commit only the files your change needs. Check `git status` first, and do not add local tooling files.
- The `test` job must pass before merging.
- CodeRabbit reviews every PR. Address its valid findings. Do not merge while its review is `CHANGES_REQUESTED`, unless the user says so.
- Do not merge a PR on your own unless the user asks you to.

## Things not to do

- Do not commit `node_modules/` or `.claude-plugin/types/`. Both are git-ignored, and the types are generated by Claude Code.
- Do not add an npm token, a `NODE_AUTH_TOKEN` or any secret to the workflow. Publishing uses trusted publishing.
- Do not change the release's publish mode to direct `npm publish` without the user's decision. The staged flow keeps a 2FA approval on every release.
