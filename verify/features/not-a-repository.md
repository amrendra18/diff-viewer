# First run and not a repository

## Sub-features

1. A window with no repository shows the first-run screen, "Open a git repository", with the recent list. `repository()` answers `null` for such a window.
2. A folder that is not a git repository shows "This folder is not a git repository" with the folder path and "Choose another folder…". `repository()` answers the `notARepository` error, never `null`.

## How to get to it (user POV)

1. Start the app with no repository: `scripts/start`.
2. Click "Open repository…" and pick a folder that is not a repository, or pick such a folder from the recent list.

## Driving it with scripts/verify

1. Run `scripts/verify fast --feature not-a-repository`.
2. The harness makes a plain folder under `/private/tmp/diff-viewer-plain-*` and writes it into a fresh data folder's `recent.json`.
3. It starts the app with no `--open`. It expects the first-run card, whose text ends "It only reads the repository. It never stages, edits, or commits.", `repository()` equal to `null`, a hidden workspace, and the plain folder in the recent list.
4. It clicks that recent entry and expects the not-a-repository card naming the folder, with one "Choose another folder…" button.
5. It starts the app with `--open` on the plain folder and expects the same card and `repository()` equal to `{ok: false, error: {kind: 'notARepository', path}}`.
6. The plain folder is deleted at the end.

## Gotchas

1. The plain folder lives under `/private/tmp` because a folder inside this checkout is inside its git repository, so git would find that repository.
2. The macOS folder chooser cannot be driven by Playwright, so the journey reaches the card through the recent list and the `--open` start argument.
