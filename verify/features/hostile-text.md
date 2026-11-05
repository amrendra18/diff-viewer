# Hostile text

## Sub-features

1. Commit subjects, author names, file paths, and file contents show as plain text. A subject holding `<b>html</b>`, the file `<img src=x onerror=alert(1)>.ts`, and the content `"<script>alert(2)</script>"` create no element and open no dialog (AGENTS.md rule 4).
2. A file that is slow to highlight cannot stop the app. `evil.cpp` is 3 lines and 12 KB, and one of its lines did not finish in 170 s in Node. The main process keeps answering, the file shows as plain text after the 2 s deadline, the next file has colors again, and the app can quit during the wait.

## How to get to it (user POV)

1. Open the practice repository and click the commit "Render <b>html</b> in subjects as text".
2. Click `evil.cpp` in its file list.

## Driving it with scripts/verify

1. Run `scripts/verify fast --feature hostile-text`.
2. The harness clicks the commit with the HTML subject and waits for the hostile file to open.
3. It expects the exact text in the summary subject, the file list, the file header, the rail, and the window title, and the change row `"<script>alert(1)</script>"` → `"<script>alert(2)</script>"`.
4. It expects no `b`, `img`, `iframe`, `object`, `embed`, or inline `script` element, and exactly one script (the app's). Any dialog during the run fails it under `page errors`.
5. Positive control: the harness then appends one `<img>` next to the subject and expects the same counter to count 1. It removes the element afterwards. `summary.json` `observations.markupCounter` holds both counts, expected next to observed.
6. The user-git-config feature repeats checks 2 to 5 under a hostile git config. The open-repository feature checks the HTML subject in the commit list.
7. The harness clicks `evil.cpp` and asks main for the recent list every 100 ms until the file shows. It expects the file between 2,000 ms and 6,000 ms after the click, at least 15 answers, and each answer in under 500 ms. It expects all 3 lines with no colored run, and the app's log to name the file and the deadline.
8. Positive control: the harness blocks main for 800 ms and expects the same probe to see an answer of at least 500 ms.
9. The harness clicks the hostile `.ts` file again and expects colored runs, so a fresh worker took over.
10. A second app opens `evil.cpp` and quits 500 ms later, while the file still highlights. It expects the app to exit with code 0. `summary.json` `observations.slowHighlight` and `observations.quitWhileSlow` hold the numbers. Bars never use this file: bar 2 clicks the 5 newest commits, and this commit is the sixth.
