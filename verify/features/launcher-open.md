# Open through the installed command

## Sub-features

1. `diff-viewer open PATH --format json` returns one JSON object after the repository title appears and the window is visible. The returned process stays alive until something stops it.
2. It opens a linked worktree and a bare repository as well as an ordinary repository.
3. A `DIFF_VIEWER_STATE_DIR` path that ends in a slash works. Every app data folder contains Chromium data and `recent.json`.
4. Every git call, from the command and from the app it starts, is on AGENTS.md rule 2's list.

## How to get to it (user POV)

1. Run `scripts/package`, and install the command as "Install" in the README says.
2. Run `diff-viewer open PATH --format json` from any folder.

## Driving it with scripts/verify

1. Run `scripts/verify fast --feature launcher-open`.
2. The harness builds the signed app bundle, then calls `bin/diff-viewer open PATH --format json` from a folder outside the checkout.
3. Five calls use separate `DIFF_VIEWER_STATE_DIR` folders. One opens a linked worktree and one opens a bare repository. The first `DIFF_VIEWER_STATE_DIR` path ends in a slash.
4. The fixture, linked worktree, and its source clone (including shared Git metadata) must stay unchanged.
5. The harness records five return times and their median. They have no time bar.
6. Each call runs with a recording `git` first on `PATH` (`state/launcher-git-recorder/`). The app the command starts inherits it, so the record holds the command's `rev-parse` calls and the app's own calls. Expected: the record holds `rev-parse` and `log`, and every call is on AGENTS.md rule 2's list. `summary.json` `observations.launcherOpen.gitCalls` holds the counts per command.
7. `DIFF_VIEWER_VERIFY_FAULT=launcher-write scripts/verify fast --feature launcher-open` changes a fixture file on purpose. The journey must report a changed fingerprint.
8. `DIFF_VIEWER_VERIFY_FAULT=launcher-git-write scripts/verify fast --feature launcher-open` changes shared Git metadata on purpose. The source clone fingerprint must detect it.

## Gotchas

1. The journey rebuilds `.local/build/diff-viewer.app`, the bundle the installed command starts, from the working tree. Quit the app first.
