# Commit diff, side by side

## Sub-features

1. Clicking a commit lists its changed files with a status chip (A, M, D, R), the name, the folder, and line counts. The first file opens.
2. Clicking a file shows the parent version on the left and the commit's version on the right, with line numbers. Removed lines are red on the left, added lines green on the right.
3. Unchanged lines more than 3 lines from a change collapse into a "Show n hidden lines" bar. Clicking the bar puts those lines in place.
4. An empty line shows as an empty row one full line high.
5. The file header, the rail, and the rows below them always name the same file. While a slow diff loads, the old rows stay under the old name; after 150 ms all three switch together to the loading panel.
6. Bars 2 and 3 hold: file list under 300 ms after a commit click, highlighted diff after a file click under 700 ms on `src/big.ts` and under 500 ms on a real repository's file.

## How to get to it (user POV)

1. Open a repository (see open-repository.md).
2. Click a commit in the Commits tab. Click a file in the list above it.

## Driving it with scripts/verify

1. Run `scripts/verify fast --feature commit-diff`. Add `--history-repo PATH` and `--file-repo PATH`, or set `DIFF_VIEWER_HISTORY_REPO` and `DIFF_VIEWER_FILE_REPO`, to also measure bars 2 and 3 on real repositories.
2. The harness checks the newest commit row shows the commit's short hash (that commit is signed), clicks "Rework the app module", and expects 4 files: `A added.ts`, `M app.ts`, `R old-name.ts→new-name.ts`, `D remove-me.ts`.
3. It clicks `app.ts` and expects change rows with the old text on the left and the new text on the right, labels "Parent <hash>" and "Commit <hash>", and one bar "Show 46 hidden lines, lines 7 to 52". Line 2 is empty and must render as an empty cell at least one line high. Clicking the bar must leave right-side line numbers 1 to 57 with no gap.
4. Bar 2: it clicks the 5 newest commits, timing each click to the painted file list, and waits for each first file's diff before the next click.
5. Bar 3 and the file switch check: in the `special` fixture it opens "Edit the big module" (4 files), records every change inside the workspace with a MutationObserver, and 5 times clicks `src/small.ts` then `src/big.ts` (4,999 lines, 50 edits, TypeScript). Each `src/big.ts` click is timed to the highlighted rows plus two painted frames. At every recorded change, the header path, the rail file name, and the diff area's `data-path` must match, and the first row's text must come from that file. At least one record must show the loading panel, so the check covered a slow diff. Positive control: the harness then writes `src/small.ts` into the header above `src/big.ts` and expects the same check to report exactly that 1 record (`observations.fileSwitchesControl`). Then it 5 times clicks `src/small.ts` then `src/dense.ts`, the densest file the size limits let through: 4,999 lines, each a whole statement, exactly `LARGE_FILE_BYTES` (200,000) bytes, 1 edit. Each `src/dense.ts` click is timed the same way (`bar3DenseDiffMs`). That time is recorded with no bar, so it does not fail the feature.
6. With `--history-repo` (or `DIFF_VIEWER_HISTORY_REPO`), bar 2 runs again on that repository's 5 newest commits. With `--file-repo` (or `DIFF_VIEWER_FILE_REPO`), the harness finds the largest file under 5,000 lines that has a highlighting language (`git grep -I -c '' HEAD`), pastes the newest non-merge commit that changed it into the hash box, and clicks that file 5 times.
7. Each median at or over its bar fails the feature. `summary.json` holds the samples, `observations.fileSwitches`, `observations.bar3BigFile`, `observations.bar3DenseFile`, and `observations.bar3FileRepo`.
8. Planted fault: `DIFF_VIEWER_VERIFY_FAULT=rows scripts/verify fast --feature commit-diff` swaps the expected sides of change rows. The run must exit 1 and name `commit-diff`. `./scripts/check full` runs it and fails unless it exits 1 with the swapped-rows failure on `commit-diff`. A second planted fault, `DIFF_VIEWER_VERIFY_FAULT=env`, launches this journey with the whole inherited environment; `./scripts/check full` fails unless that run proves `commit-diff` and fails the trace scan on `traces/commit-diff.zip`, naming its planted `DIFF_VIEWER_CANARY`.
9. The user-git-config feature runs steps 2 and 3 under a hostile git config.

## Gotchas

1. Bar timings run inside the page: from the click to the rows in the DOM plus two painted frames. The highlighter has already started on the commit's first file, so bar 3 excludes Shiki's one-time start (about 250 ms on first use).
2. The highlighter tokenizes the new version once and reuses its tokens for unchanged old lines when the grammar state before them is equal (`pair` in `src/app/highlight.ts`). On `src/big.ts` this takes 294 ms, against 575 ms for highlighting both versions in full.
3. Row heights are 19 px or 19.5 px depending on the characters in the row, so the empty-line check compares against the line height, not a neighbor row.
4. `traces/commit-diff.zip` is a Playwright trace of the practice part of this journey. Open it with `npx playwright show-trace`. Its launch record holds the app's environment, so the app gets only `PATH` and `HOME` from the shell that started the run, and every run scans the trace for anything else.
5. Highlighting time grows with lines and tokens more than with bytes. A dense 4,999-line file of 435 KB took about 1.8 s to highlight in Node. `src/dense.ts` at 200,000 bytes took 631 ms in Node for diff and highlight alone. In Node, the same shape took 403 ms at 100,000 bytes; `src/big.ts` (176 KB) took 369 ms, and TypeScript's own `typescript.js` cut to 4,999 lines (210 KB) took 434 ms. No byte limit both keeps `src/big.ts` shown and holds bar 3 on `src/dense.ts`. So the limit is 200 KB, and `bar3DenseDiffMs` has no bar.
6. Highlighting runs on a worker thread, so a slow file cannot stop the main process. The cost is about 80 ms on `src/big.ts`: medians 563 to 664 ms, against 466 to 615 ms in the main process, on a busy Mac. One highlight job accounts for about 15 ms of that; the rest is not explained. So bar 3 is 700 ms on this fixture file and 500 ms on a real repository's file, which measured 331 to 431 ms in the same runs. Copying one object per token between threads took 21 ms per version of `src/big.ts` in Node; packing, copying, and unpacking takes 6 ms, so the worker sends flat arrays.
