---
name: verify-diff-viewer
description: Drive diff-viewer, the read-only Electron app that shows git commit, staged, and unstaged diffs side by side, through scripts/verify. Use after any change to src/, scripts/, or the page, before claiming a diff-viewer feature works, or to measure the bars in verify/features/README.md.
---

# Verify diff-viewer

`scripts/verify [fast|full] [--feature NAME] [--history-repo PATH] [--file-repo PATH]` is the harness. `DIFF_VIEWER_HISTORY_REPO` and `DIFF_VIEWER_FILE_REPO` give the same two paths when the flags are absent. `scripts/verify --help` lists levels, features, flags, exit codes, and the map path. The feature map is `verify/features/README.md`.

## Doctor

1. The harness first checks that the screen is unlocked (`lsappinfo front` must not name `loginwindow`; `scripts/screen.mts`), then macOS on Apple silicon, Node 24, git, each pinned package in `node_modules`, the Electron binary, and `codesign` when app-bundle or a launcher feature is selected. A locked screen exits 3 with "the screen is locked" before anything launches. A journey that fails while `loginwindow` is in front exits 3 with "the screen locked during the run", and the journeys after it are not run.
2. It then rebuilds `dist/` with `scripts/build.mts`. A failed check or build exits 3 before anything launches. `logs/doctor.json` names the failed row.
3. Fix a missing package with `npm ci --ignore-scripts` and the Electron install line under "Install" in `README.md`.

## Launch

1. Each launch uses Playwright `_electron.launch` with `--open <repository>` (or no `--open` for the first-run screen) and `--data-dir <evidence>/state/<label>`, so no run touches the real Electron user-data folder. Journeys that need a recent list write `recent.json` into their own data folder first.
2. Ready means the commit rows exist: `#commits .commit`. A file is shown when `#diff > [data-path]` names it and `#diff` has no `aria-busy`.
3. The app bundle (feature app-bundle) launches `.local/build/diff-viewer.app/Contents/MacOS/diff-viewer` the same way.
4. Every launch adds `onCompleted` and `onErrorOccurred` listeners to the app's session right away, so the harness can count requests. open-repository also runs `scripts/start` twice with `--remote-debugging-port` on a free local port.
5. Theme journeys call `page.emulateMedia({colorScheme: null})` before setting `nativeTheme.themeSource`; Playwright otherwise pins the page to light.
6. Focus journeys (working-changes, repository-removed) turn off Playwright's focus emulation with the CDP call `Emulation.setFocusEmulationEnabled`, then call `blur()` and `focus()` on the window in main. With the emulation on, the page never sees a focus change. A try counts when main reports `BrowserWindow.isFocused()` true and the page saw a `focus` event; up to 3 tries, recorded in `observations.refocus`.
7. read-only-repository launches with a recording `git` first on `PATH` (`state/git-recorder/`), to check every git command against AGENTS.md rule 2. launcher-open does the same for `bin/diff-viewer` and the app it starts (`state/launcher-git-recorder/`).
8. Every launch shuts the person at the Mac out of the app's windows: main's `before-input-event` drops each key press from the system, and `setIgnoreMouseEvents(true)` lets the system pointer pass through. Playwright's keys and pointer arrive through CDP and pass neither, so the harness's input still works. The harness focuses app windows, so without this someone typing in another app could scroll the diff or re-open a file or commit mid-journey. The app's log (`logs/<label>.log`) gets one line per blocked key press, without the key.
9. Every app the harness starts (Playwright launches, `scripts/start`, Electron run directly) and the harness's own git get only `PATH` and `HOME` from the shell that started the run, plus what a journey sets (`HOME` for user-git-config, the recorder's `PATH` for read-only-repository). A trace records the launch environment, so tokens, sockets, and session ids in the shell must never reach the app. Electron and git start with none of them; `PATH` and `HOME` keep the app on the same git and user config as the harness.
10. launcher-open, launcher-twice, and launcher-source package the app, then run `bin/diff-viewer open PATH --format json` from a folder outside the checkout with `DIFF_VIEWER_STATE_DIR=<evidence>/state/<label>`. The command returns after the app writes its ready file. Each journey stops only the process IDs the command returned. Packaging replaces `.local/build/diff-viewer.app`, the bundle the installed command starts.

## Drive

1. Stable handles: `#commits .commit[data-hash]`, `#commits .more` ("Show older commits"), `#commit-count`, `.subj`, `#commits-tab`, `#staged-tab`, `#unstaged-tab`, `#staged-count`, `#unstaged-count`, `#commit-panel`, `#working-panel`, `#refresh`, `#selection`, `#subject`, `#commit-meta`, `#files .col-empty`, `#paste`, `#files .file[data-path]`, `#file-head .path`, `#diff > [data-path]`, `#diff[aria-busy]`, `#diff tr[data-kind="context|change|hidden"]`, `td.ln.l|r`, `td.cd.l|r`, `.w`, `tr.gap button`, `#show-large`, `#banner`, `#diff .banner`, `#diff .notice .big|.fact`, `#start .card h2`, `#start .recent button`, `#repo-button`, `#recent-menu button`, `#pane .side-btn`, `#rail-info`, `#rail-source`, `#rail-file`, `#pane-split[aria-valuenow]`, `#file-head .word`.
2. Fixtures: `scripts/fixtures DIR` builds `DIR/practice` (12 commits with the newest signed, a merge, a binary change, a 5,001-line file, a rename, a hostile file name, an HTML subject, a small C++ file past the 2 s highlighting deadline, an accented subject, 2 staged and 2 unstaged files, and one tracked file whose time no longer matches the index), `DIR/history` (250 commits), `DIR/special` (a submodule, a symlink, and a mode-only change, then a 4,999-line TypeScript file edited in 50 places plus `src/notes.ts` with a block comment above its hunk), `DIR/step` (one commit: a 5,001-line file, then two small files, for `]` and `[` after "Show anyway"), and `DIR/practice.git` (a bare clone).
3. The expected texts live in `scripts/fixtures.mts` (`NEWEST_SUBJECT`, `HTML_SUBJECT`, `ACCENTED_SUBJECT`, `HOSTILE_FILE`, `APP_CHANGES`, `SPECIAL_*`, `STEP_*`, `BIG_FILE`, `SUBMODULE_COMMITS`, `SYMLINK_TARGETS`).
4. working-changes and repository-removed copy the practice repository under the evidence folder and change the copy from outside the app (edits, `git reset --hard`, `git clean -fd`, commits and a conflicted merge that is then aborted, a move, a delete). The shared fixtures stay unchanged.
5. read-only-repository and user-git-config are described in `verify/features/`. Their results sit in `summary.json` `observations` with expected next to observed.
6. Positive controls: hostile-text plants one `<img>` and expects the markup counter to see it (`observations.markupCounter`), and blocks main for 800 ms and expects its main-answer probe to see it (`observations.slowHighlight`); commit-diff writes another file's name into the header and expects the file-switch check to report it (`observations.fileSwitchesControl`).

## Measure

1. `summary.json` `measurements` holds 5 samples and the median for app start to first paint, bar 1 (`bar1CommitListMs`), bar 2 (`bar2FileListMs`), bar 3 (`bar3DiffMs`, the 4,999-line file), and the 5,001-line "Show anyway" time, each with its bar and scope.
2. working-changes adds `bar2StagedListMs` and `bar2UnstagedListMs` (tab click to the painted list) on the practice fixture, and the same names with `HistoryRepo` and `FileRepo` on the real repositories. They run before any focus step, and each tab's paths are then compared with git's own listing (`observations.workingListsMatchGit`).
3. `--history-repo PATH` (or `DIFF_VIEWER_HISTORY_REPO`) adds `bar1CommitListRealMs` and `bar2FileListRealMs` on that repository. `--file-repo PATH` (or `DIFF_VIEWER_FILE_REPO`) adds `bar3DiffRealMs` on its largest highlighted file under 5,000 lines. Both repositories are opened read-only and fingerprinted before and after the run.
4. A median at or over its bar (the bars table in `verify/features/README.md`) fails the feature that measured it. Bars are never raised in the harness.
5. Before each measurement the harness waits while the 1-minute load average is over 6, up to 5 minutes; `observations.loadBeforeMeasuring` records the load and the wait.
6. `traces/commit-diff.zip` is a Playwright trace of the commit-diff journey. A failed working-changes or next-previous-file app also keeps `traces/<label>.zip`, `logs/<label>-events.json` (the page's focus, key, divider pointer, scroll, file-request, panel, and file-list events with times; typed characters are not kept), and `screens/<label>-failed.png`.

## Evidence

1. The last output line is the evidence folder `.local/verify/<UTC time>/`, holding `summary.md`, `summary.json`, `index.html`, `screens/`, `traces/`, `logs/`, `fixtures/`, and `state/`.
2. `summary.json` `revision`, `modified` and `changesDigest`, and the top of `summary.md`, name the checkout's commit and whether it had uncommitted changes at the start. With uncommitted changes, `revision` is the parent of what was tested and `changesDigest` fingerprints the changes. Read `summary.json` `features` before claiming coverage. Exit 0 proves only the selected features. Every run adds the rows `repositories unchanged` and `traces hold no shell environment`.
3. The trace scan unzips each `traces/*.zip` and fails the run when one holds `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_SESSION_ID`, `SSH_AUTH_SOCK`, `TERM_SESSION_ID`, or the value of any variable of that shell outside `PATH` and `HOME`. It skips values under 8 characters, the checkout's path and its parents, and text inside the `PATH` or `HOME` value, because the harness writes those itself. `observations.environmentScan` lists the traces, the variable names searched, and what was found, by name only.
4. Planted faults: `DIFF_VIEWER_VERIFY_FAULT=rows scripts/verify fast --feature commit-diff` must exit 1 and name `commit-diff`. `DIFF_VIEWER_VERIFY_FAULT=env` launches with the whole inherited environment; the same run must exit 1 with `commit-diff` proven and the trace scan failed. `launcher-write` and `launcher-git-write` must fail launcher-open, and `ignored-read` must fail read-only-repository; `verify/features/launcher-open.md` and `read-only-repository.md` describe them.

## Cleanup

1. The harness records each app's process ID and its helper processes, closes each app, and waits up to 80 s for all of them to exit.
2. Electron on macOS takes about 15 s to exit after quit (GPU process teardown), so a run always ends with that wait.
3. Any owned process still alive after the wait is stopped and listed under `cleanup.stopped`; one still alive after that fails the run. Cleanup never deletes the evidence folder. The not-a-repository journey deletes its plain folder under `/private/tmp`.

## Helpers

1. `./scripts/check --help` and CONTRIBUTING.md "Checks" describe each level. Each verify run gets `DIFF_VIEWER_CANARY=<random>`: verify full must not find it in a trace, and the `env` fault must find it in `traces/commit-diff.zip`. The last line is `check <level> exit <code>`.
2. `scripts/check full` needs the two real-repository variables; `verify/features/README.md` step 4 explains them and `--fixtures-only`.
3. `scripts/start --open PATH` builds and runs the app from the checkout with data in `.local/app-data`.
4. `scripts/package` builds and signs the bundle. `scripts/fixtures DIR` builds the fixture repositories.
5. `scripts/hand-journey` builds the practice repository in `.local/hand/practice`, prints its numbers and the hand-journey steps with "want", and starts the app with `--data-dir .local/hand/data`. `scripts/hand-journey --check` does all of it except starting the app.
