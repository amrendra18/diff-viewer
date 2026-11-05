# Next and previous file

## Sub-features

1. `]` opens the next file in the list and `[` the previous one.
2. The keys also work while the left pane is collapsed, and the rail follows.
3. At the first or last file the key does nothing.
4. Typing `]` or `[` in the hash box types the character and moves no file.
5. After "Show anyway" on a large file, `]` and `[` still step from that file, and the rail still names its place ("file 1 of 3").

## How to get to it (user POV)

1. Open a commit with several files and press `]` or `[`.

## Driving it with scripts/verify

1. Run `scripts/verify fast --feature next-previous-file`.
2. In the newest practice commit (4 files), the harness presses `] ] ] [ [ [` and expects app.ts, new-name.ts, remove-me.ts, new-name.ts, app.ts, added.ts.
3. It watches the diff area's `aria-busy` attribute, which the page sets on every file request. `[` on the first file must cause no change in 300 ms.
4. It collapses the pane with Command-B, presses `]`, and expects `src/app.ts` with the rail showing `app.ts`.
5. It checks the hash box's placeholder, "Paste a commit hash, then press Return". It clicks the hash box and types `][`. It expects the box to hold `][`, no new file request, and the header still on `src/app.ts`.
6. In the `step` fixture (one commit: `a-large.txt` with 5,001 lines, then `b-next.ts` and `c-last.ts`) it clicks "Show anyway". It expects the rail title to read "file 1 of 3". It presses `]` and expects `b-next.ts` with "file 2 of 3", then `[` and expects `a-large.txt` hidden again with "file 1 of 3".

## Gotchas

1. Space or Enter from someone typing in another app, landing on the clicked commit button, reloads the commit and opens its first file, so the next `]` opens a file the harness did not expect. The harness therefore blocks the system's keys and pointer in the app's windows (verify skill, Launch 8). A failed run keeps `traces/next-previous-file.zip` (or `next-previous-file-show-anyway.zip`), the matching `logs/<label>-events.json`, and `screens/<label>-failed.png`.
