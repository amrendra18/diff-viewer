# Open through the installed command

1. The harness builds the signed app bundle, then calls `bin/diff-viewer open PATH --format json` from a folder outside the checkout.
2. Five calls use separate `DIFF_VIEWER_STATE_DIR` folders. One opens a linked worktree and one opens a bare repository. Each returns one JSON object after the repository title appears and the window is visible. The returned process stays alive until the harness stops it.
3. The first state path ends in a slash. Every state folder contains Chromium data and `recent.json`. The fixture, linked worktree, and its source clone (including shared Git metadata) stay unchanged.
4. The harness records five return times and their median. They have no time bar.
5. Each call runs with a recording `git` first on `PATH` (`state/launcher-git-recorder/`). The app the command starts inherits it, so the record holds the command's `rev-parse` calls and the app's own calls. Expected: the record holds `rev-parse` and `log`, and every call is on AGENTS.md rule 2's list. `summary.json` `observations.launcherOpen.gitCalls` holds the counts per command.
6. `DIFF_VIEWER_VERIFY_FAULT=launcher-write scripts/verify fast --feature launcher-open` changes a fixture file on purpose. The journey must report a changed fingerprint.
7. `DIFF_VIEWER_VERIFY_FAULT=launcher-git-write scripts/verify fast --feature launcher-open` changes shared Git metadata on purpose. The source clone fingerprint must detect it.
