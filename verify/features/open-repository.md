# Open a repository

## Sub-features

1. The app opens the repository named by `--open PATH` and shows its folder name and branch in the header. `scripts/start` resolves a relative `PATH` against the folder it runs from. The app itself refuses a relative `--open` with "--open needs an absolute folder path." and exit 1.
2. The Commits tab shows the commit count, newest commit first. Over 200 commits, it shows the first 200 and "200+", with "Show older commits" at the end of the list. That button adds the next page of up to 200 commits.
3. Commit subjects and author names show as plain text. A subject holding `<b>html</b>` creates no element. A subject with an accented letter shows as written.
4. The page has no Node access: `require` and `process` are undefined in the page.
5. Bar 1 holds: the commit list shows within 300 ms of the page asking for the repository.

## How to get to it (user POV)

1. Run `scripts/start --open /path/to/repository`, or `scripts/start --open .` from inside the repository.
2. The left column shows the Commits tab with the commit count and the list below it.
3. In a repository with over 200 commits, click "Show older commits" at the end of the list to add older commits.
4. Without `--open`, the first-run screen offers "Open repository…", which shows the macOS folder chooser, and the recent list.

## Driving it with scripts/verify

1. Run `scripts/verify fast --feature open-repository`. Add `--history-repo PATH`, or set `DIFF_VIEWER_HISTORY_REPO`, to also measure bar 1 on a real repository.
2. The harness builds `practice` and `history` repositories with `scripts/fixtures` inside the evidence folder, then launches the app on `practice`.
3. It expects "Commits 12", the newest subject "Rework the app module", the subject "Describe the format helper for Zoë", header "practice" and "main", and no `b`, `img`, `iframe`, `object`, or `embed` element.
4. It runs `scripts/start --open .` from inside `practice` and `scripts/start --open <absolute path>` from the checkout, each with `--remote-debugging-port` on a free local port. It reads each window title from `http://127.0.0.1:<port>/json/list` and expects "practice · diff-viewer" for both. It then starts Electron directly with `--open practice` and expects exit 1 and the refusal message. `summary.json` `observations.startScript` holds the titles and the exit code.
5. It launches the app on the 250-commit `history` repository and expects 200 rows, "200+", and one "Show older commits" button. It clicks the button and expects 250 rows, "250", and no button. The 250 commit hashes must equal `git rev-list HEAD`, in order, so a repeated or dropped commit fails. `summary.json` `observations.olderCommits` holds expected and observed values. Screen: `older-commits.png`.
6. It then launches the app 5 times on the 250-commit `history` repository. Each launch records app start to first paint and bar 1 (commit list shown, 200 rows) in `summary.json`. A bar 1 median at or over 300 ms fails the feature.
7. With `--history-repo PATH` (or `DIFF_VIEWER_HISTORY_REPO`), it launches the app 5 more times on that repository (read-only, `--open`) and records `bar1CommitListRealMs` the same way, expecting the first 200 commits and "200+" when the repository has more.
8. The run-level row `repositories unchanged` checks every fixture and real repository, `.git` included, is byte-for-byte unchanged. The read-only-repository feature owns the full read-only test and its positive control.

## Gotchas

1. Electron on macOS takes about 15 s to exit after quit. The GPU process teardown causes it; a bare Electron app shows the same delay, and `--disable-gpu` removes it. The harness keeps the GPU on, closes apps in the background, and waits for every owned process at cleanup.
2. Bar 1 comes from two page marks, `repository-requested` and `commits-shown`, set by `src/web/renderer.ts`. Removing them breaks the measure.
3. Commit dates show in the Mac's time zone, so fixture commits made at midnight UTC can show as Dec 31, 2025.
4. The `scripts/start` check opens a local DevTools listener on 127.0.0.1 only while it runs, because `scripts/start` gives the harness no other way to read the window. The app never opens one on its own.
