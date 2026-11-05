# Use one running app

## Sub-features

1. A later `diff-viewer open` reaches the app that is already running for that app data folder. It reports `app: running`, the canonical repository, and the same owning process ID.
2. Each repository has one window, the requested window gets focus, and one Electron main process owns each app data folder.
3. Eight `open` calls for one repository at once share one new window.
4. A symlink to an app data folder reaches the same owner and creates no sibling app data folder.

## How to get to it (user POV)

1. Run `diff-viewer open PATH` for one repository, then again for it and for another, from any folder.

## Driving it with scripts/verify

1. Run `scripts/verify fast --feature launcher-twice`. The evidence folder's `summary.json` records the results and times.
2. The harness starts the packaged app with the practice repository and one private app data folder. Its ready marker reports `app: started` and the owning main process ID.
3. From outside the repository, it runs `diff-viewer open PATH --format json` five times. It opens the same repository, a second repository, and then alternates. Each result must report `app: running`, the canonical repository, and the same owning process ID.
4. After each call, it checks that the requested window has focus. It counts one window per repository and one owning Electron main process for that app data folder.
5. It sends eight `open` calls for a third repository at once. All eight must report `app: running` and the owning process ID, and share one new window.
6. It calls `open` with a symlink to the first app data folder. The call must reach the same owner and create no sibling app data folder.
7. It starts a second app with a separate app data folder and no `--data-dir` argument. An installed-command call must reach that owner while the first owner remains alive. It compares all repository fingerprints before and after.
8. It records all five measured second-call return times and their median. The journey closes only the app processes it started.

## Gotchas

1. The journey packages the app, so it rebuilds `.local/build/diff-viewer.app` from the working tree. Quit the app first.
