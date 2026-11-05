# Read-only repository

## Sub-features

1. The app never writes to a repository it opens: not `.git`, not the working files. This holds even when git would like to refresh a stale index entry, also while it lists and reads staged and unstaged changes. One exception: a filter program that git runs, such as git-lfs, may write its own cache into `.git`, as it does for `git status`. The test repositories have no filter that writes, so this journey does not cover that case.
2. The app runs only the git commands on AGENTS.md rule 2's list. Plain `git diff` and `git show` are not on it.
3. No request leaves the app origin at the network layer. Main cancels every request outside `diff-viewer://app/`.
4. The served page carries a Content-Security-Policy header (`default-src 'none'`, `connect-src 'none'`), and its meta tag says the same. The policy stops a request from the page before it reaches the network layer.

## How to get to it (user POV)

1. Nothing to click. Every journey relies on it: opening a repository, clicking a commit, and clicking a file leave the repository as it was.
2. AGENTS.md rule 2 states the rule and names this test.

## Driving it with scripts/verify

1. Run `scripts/verify fast --feature read-only-repository`.
2. The harness builds two fresh copies of the practice repository under `fixtures-read-only/` (`app` and `control`). In each, `src/format.ts` is tracked and unchanged, but its file time no longer matches the index. A plain `git status` then rewrites `.git/index`.
3. App run. It fingerprints `app` (sha256 over every file, `.git` included), opens it, clicks "Rework the app module", clicks `app.ts`, clicks the Staged tab, the Unstaged tab, and `todo.txt`, clicks Refresh, quits, and waits for the app to exit. It fingerprints again. Expected: same.
4. Positive control. It fingerprints `control`, runs the app's own status command (`status` plus `STATUS_ARGUMENTS`) without `GIT_OPTIONAL_LOCKS=0`, and fingerprints again. Expected: changed. The command is built from `GIT_SETTINGS`, `GIT_OPTIONS`, and `STATUS_ARGUMENTS`, imported from `src/app/git-settings.ts`, the module `src/app/git.ts` uses. This shows the fingerprint can see the write that the app's guard prevents.
5. Git commands. The app run starts with a recording `git` first on `PATH` (`state/git-recorder/git`). It appends each argument list to `calls.bin` and runs the real git. The harness takes the first word after the global options of each call. Expected: every one is on AGENTS.md rule 2's list, read from AGENTS.md itself, and that list equals `GIT_COMMANDS` in `src/app/git-settings.ts`. The record must include `diff-index`, `diff-files`, `ls-files`, and `check-attr`, so the staged and unstaged reads ran through the recorder. Positive control: the same check, fed `diff` and `show`, flags both. `observations.readOnlyRepository.gitCalls` holds the counts per command.
6. Network count. Right after launch, the harness adds `onCompleted` and `onErrorOccurred` listeners to the app's session. They sit beside main's `onBeforeRequest` and see every request it lets through or cancels. The run expects `diff-viewer://app/index.html` among them (the listeners were in place before the page loaded) and 0 requests outside the app origin.
7. Policy check. Main fetches `diff-viewer://app/index.html` through its session and reads the `Content-Security-Policy` header; the page's meta tag must match it. The page then tries `fetch('http://127.0.0.1:9/from-page')`. Expected: a `TypeError`, one `securitypolicyviolation` event for `connect-src`, and no such request in the listeners' log.
8. Network positive control. The harness opens a hidden test-only window in main and loads `http://127.0.0.1:9/read-only-control`. Expected: counted once, with error `net::ERR_BLOCKED_BY_CLIENT` (main cancelled it).
9. `summary.json` `observations.readOnlyRepository` holds both fingerprint pairs, the expected and observed results, every request seen, the policy results, and the control request.
10. The harness plants `ignored-probe.txt` in Git's exclude list, then asks the page to open it as an unstaged diff. It must return `unknownFile`. The changed `CHANGELOG.md` and allowed untracked `notes/todo.txt` must return text diffs. `observations.readOnlyRepository.diskReads` records expected and observed results.
11. Run `DIFF_VIEWER_VERIFY_FAULT=ignored-read scripts/verify fast --feature read-only-repository` as a control. The harness changes only its disposable compiled app. The fault adds `ignored-probe.txt` to the app's file list, causing the app to read it. The journey must exit 1 and name `ignored-probe.txt`. The harness restores the compiled file after the run.
12. Every run also fingerprints each fixture repository, and each repository passed with `--history-repo` or `--file-repo` (or their environment variables), before the first journey and after the last app has exited. The row `repositories unchanged` fails if any changed.

## Gotchas

1. The fingerprint covers file contents, not file times. A git command that only touches a file's time is not seen.
2. The listeners count requests at the network layer only. A request the page's policy stops never reaches them, which is why step 7 checks the policy separately and step 8 uses a test-only window for the positive control.
3. The app run waits for the app to exit (about 15 s on macOS) before the second fingerprint, so writes made while quitting are seen too.
