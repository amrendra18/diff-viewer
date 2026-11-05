# Use one running app

1. Start the packaged app with the practice repository and one private state folder. Its ready marker reports `app: started` and the owning main process ID.
2. From outside the repository, run `diff-viewer open PATH --format json` five times. Open the same repository, a second repository, and then alternate. Each result reports `app: running`, the canonical repository, and the same owning process ID.
3. After each call, check that the requested window has focus. Count one window per repository and one owning Electron main process for that state folder.
4. Send eight `open` calls for a third repository at once. All eight report `app: running` and the owning process ID. They share one new window.
5. Call `open` with a symlink to the first state folder. Check that it reaches the same owner and creates no sibling state folder.
6. Start a second app with a separate state folder and no `--data-dir` argument. Check that an installed-command call reaches that owner while the first owner remains alive. Compare all repository fingerprints before and after.
7. Record all five measured second-call return times and their median. The journey closes only the app processes it started.

Run `scripts/verify fast --feature launcher-twice`. The evidence folder's `summary.json` records the results and times.
