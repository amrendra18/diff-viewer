# Requested first view

1. Run `scripts/verify fast --feature launcher-source`.
2. The harness opens the practice repository with `--source unstaged`. It checks the first changed file and its diff.
3. Calls from another folder select `staged`, `commit:HEAD`, `unstaged`, and `commit:HEAD` again. Each call must return after the tab and first file appear in the existing window.
4. Each JSON result names the owning process and requested source. One window stays open for the repository.
5. The repository fingerprint must stay the same. The harness closes the process it started.
6. A clean practice repository has no staged or unstaged files. The installed command must return `firstFile: null` for a first staged open. A later unstaged request must show its empty tab before returning `app: running` and `firstFile: null`.
7. The clean fixture ends with an empty commit. A running `commit:HEAD` request must select Commits, show "No changed files", and return its full hash with `firstFile: null`.
