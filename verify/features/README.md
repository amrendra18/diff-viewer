# diff-viewer feature map

`scripts/verify` (the harness) starts the app on generated test repositories and drives it the way a person would. Each row below is one feature and the command that proves it. A run writes `summary.json` in `.local/verify/<time>/`, with one row per feature marked `proven`, `failed`, or `skipped`.

| # | Feature | Journey |
| --- | --- | --- |
| 1 | [Open a repository](open-repository.md) | `scripts/verify fast --feature open-repository` |
| 2 | [Commit diff, side by side](commit-diff.md) | `scripts/verify fast --feature commit-diff` |
| 3 | [Special files and commits](special-files.md) | `scripts/verify fast --feature special-files` |
| 4 | [Highlighting](highlighting.md) | `scripts/verify fast --feature highlighting` |
| 5 | [Hostile text](hostile-text.md) | `scripts/verify fast --feature hostile-text` |
| 6 | [First run and not a repository](not-a-repository.md) | `scripts/verify fast --feature not-a-repository` |
| 7 | [Recent repositories](recent-repositories.md) | `scripts/verify fast --feature recent-repositories` |
| 8 | [Dark mode](dark-mode.md) | `scripts/verify fast --feature dark-mode` |
| 9 | [Bare repository](bare-repository.md) | `scripts/verify fast --feature bare-repository` |
| 10 | [One window per repository](window-per-repository.md) | `scripts/verify fast --feature window-per-repository` |
| 11 | [Collapse the left pane](collapse-pane.md) | `scripts/verify fast --feature collapse-pane` |
| 12 | [Next and previous file](next-previous-file.md) | `scripts/verify fast --feature next-previous-file` |
| 13 | [Staged and unstaged changes](working-changes.md) | `scripts/verify fast --feature working-changes` |
| 14 | [Repository removed while open](repository-removed.md) | `scripts/verify fast --feature repository-removed` |
| 15 | [Read-only repository](read-only-repository.md) | `scripts/verify fast --feature read-only-repository` |
| 16 | [Your own git settings](user-git-config.md) | `scripts/verify fast --feature user-git-config` |
| 17 | [App bundle](app-bundle.md) | `scripts/verify full --feature app-bundle` |
| 18 | [Open through the installed command](launcher-open.md) | `scripts/verify fast --feature launcher-open` |
| 19 | [Use one running app](launcher-twice.md) | `scripts/verify fast --feature launcher-twice` |
| 20 | [Requested first view](launcher-source.md) | `scripts/verify fast --feature launcher-source` |

1. `scripts/verify fast` drives features 1 to 16 and 18 to 20. Features 18 to 20 use the packaged command. `scripts/verify full` adds feature 17.
2. A feature counts as proven only when its row in `summary.json` says `proven`. A screenshot alone proves nothing. Every run also adds the rows `repositories unchanged` and `traces hold no shell environment`. `summary.json` (`revision`, `modified`, `changesDigest`) and the top of `summary.md` name the checkout's commit and whether it had uncommitted changes when the run started. With uncommitted changes, `revision` is the parent of what was tested, and `changesDigest` fingerprints the changes; `checkoutState` in `scripts/verify.mts` says how it is computed.
3. The bars below are the numbers the harness holds the app to. A median at or over its bar fails the feature that measured it, and bars are never raised in the harness. `BAR` in `scripts/verify.mts` holds bars 1 to 3, and `LARGE_FILE_LINES` and `LARGE_FILE_BYTES` in `src/domain/types.ts` hold bar 4.

| # | What | Bar | Feature |
| --- | --- | --- | --- |
| 1 | Commit list shown after a repository is opened (200 commits) | under 300 ms | `open-repository` |
| 2 | File list shown after a commit or a tab is clicked | under 300 ms | `commit-diff`, `working-changes` |
| 3 | Highlighted diff shown after a file is clicked, file under 5,000 lines and 200 KB, measured on `src/big.ts`. The densest allowed file, `src/dense.ts` (4,999 lines of statements at exactly 200 KB), is recorded as `bar3DenseDiffMs` with no bar; it takes about 950 ms | under 700 ms on `src/big.ts`, under 500 ms on the real repository's file | `commit-diff` |
| 4 | Large-file limit | files or diffs over 5,000 lines, and files over 200 KB, stay collapsed behind "Show anyway" | `special-files` (file lines); unit test `large-diff-lines` (diff lines); unit tests `large-bytes` and `unstaged-bytes` (size) |
| 5 | Repository unchanged by the app | `.git` fingerprint and working files identical before and after | `read-only-repository`, and the row `repositories unchanged` in every run |
| 6 | Network requests | 0 | `read-only-repository` |

4. Bars 1 to 3 run on fixtures by default. To measure them on real repositories as well, pass them read-only, as flags or as environment variables (a flag wins):

```sh
scripts/verify fast --history-repo /path/to/largest-history-repository --file-repo /path/to/repository-with-large-source-files
DIFF_VIEWER_HISTORY_REPO=/path/to/largest-history-repository DIFF_VIEWER_FILE_REPO=/path/to/repository-with-large-source-files scripts/verify fast
```

   `./scripts/check full` needs both variables and exits 2 before any step when either is unset. `./scripts/check full --fixtures-only` runs on the fixtures alone. Both also run `scripts/hand-journey --check`, which fails when the practice repository does not give the numbers the hand-journey steps promise.

   Bar 2 also covers the staged and unstaged lists (feature 13), on the fixture and on both real repositories. The fixture's lists are not empty (2 staged, 2 unstaged files), and the harness stops when they are. A real repository is read-only, so its lists are timed as they are; each scope in `summary.md` names its list's file count, or says "Measured on an empty list".

5. Setup on a fresh checkout: the first two lines of [Install](../../README.md#install).
