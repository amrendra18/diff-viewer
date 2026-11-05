# Special files and commits

## Sub-features

1. A binary file shows "Binary file, not shown" with its old and new sizes.
2. A file over 5,000 lines shows "Large file hidden" with its line count, and a file over 200 KB shows it with its size. "Show anyway" shows every line (bar 4). The unit tests `large-bytes` and `unstaged-bytes` cover the size limit.
3. A renamed file names its old and new path and shows its content change.
4. A merge commit is compared with its first parent. A banner names both parents, and the left side is labeled "First parent".
5. The first commit of a repository shows a banner, "No parent" on the left, and every file as added.
6. A submodule shows "Submodule: abc1234 → def5678", a symlink shows its old and new target, and a mode-only change shows "File mode 100644 → 100755".

## How to get to it (user POV)

1. Open a repository and click a commit that holds such a file. The first file opens; click the others in the file list.

## Driving it with scripts/verify

1. Run `scripts/verify fast --feature special-files`.
2. Practice fixture: "Change the logo" must show `256 bytes → 256 bytes`. "Add the generated table" must show "table.txt has 5,001 lines, over the 5,000-line limit." "Show anyway" is clicked 5 times and must show 5,001 change rows; the time is recorded as `showAnyway5001Ms` with no bar.
3. "Rework the app module", file `src/new-name.ts`: header `src/old-name.ts→src/new-name.ts` and one change row `return text.trim();` → `return text.trim().toLowerCase();`.
4. "Merge branch 'search'": the banner names the first parent (with its subject) and the second parent, the labels read "First parent <hash>" and "Commit <hash>", and the file list is `A search.ts`.
5. "Start the notes app": the first-commit banner, the label "No parent", and 6 files, all `A`.
6. Special fixture, "Point at new targets": files `link`, `run.sh`, `lib`. `link` shows "Symbolic link" and `target-one → ../somewhere/else`; `run.sh` shows "File mode 100644 → 100755"; `vendor/lib` shows "Submodule: aaaaaaa → bbbbbbb".

## Gotchas

1. The special fixture's submodule is a bare gitlink with no `.gitmodules` entry, which is enough for git to report it as a submodule change.
2. The `special` fixture is built with `git fast-import`, so its object names are the same on every build (`tests/fixtures.test.mts`).
