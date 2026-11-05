# Repository removed while open

## Sub-features

1. A repository moved or deleted while its window is open shows the card "This repository is no longer there" with its old path, on the next refresh.
2. The card offers "Open repository…" and the recent list.

## How to get to it (user POV)

1. Open a repository. Move or delete its folder in Finder. Come back to the window, or click Refresh.

## Driving it with scripts/verify

1. Run `scripts/verify fast --feature repository-removed`.
2. Moved: the harness builds `fixtures-removed/moved`, opens it on the Unstaged tab, renames the folder, and clicks Refresh in the header. The card must name the old path.
3. Deleted: it builds `fixtures-removed/deleted`, opens the newest commit, deletes the folder, and moves the system focus away from the window and back. The card must name the old path.

## Gotchas

1. Main answers `repositoryGone` when a read fails and the folder, or its `.git`, no longer exists. Any read can find it: the counts, a file list, or a file's diff. The unit test `repository-removed-bare` covers a bare repository, which has no staged or unstaged read to fail.
2. The focus step uses the same real focus change as working-changes (see its Gotchas).
