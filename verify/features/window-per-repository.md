# One window per repository

## Sub-features

1. Opening a second repository from a window that already shows one opens a new window.
2. Opening a repository that is already open focuses its window and opens no new one. A minimized window is restored first.

## How to get to it (user POV)

1. With a repository open, open another one from the recent menu or "Open repository…". Then, from the new window, choose the first repository again.

## Driving it with scripts/verify

1. Run `scripts/verify fast --feature window-per-repository`.
2. The harness writes the `special` fixture into a fresh data folder's `recent.json` and opens `practice` with that folder.
3. It chooses `special` from the recent menu and expects a second window titled "special · diff-viewer", with the first window still on practice.
4. It listens for focus events on both windows, chooses `practice` from the second window's menu, and expects a focus event on the practice window, still 2 windows, and the second window still on special.
5. It minimizes the practice window, chooses `practice` again from the second window's menu, and expects the practice window not minimized, visible, and focused within 5 s, still with 2 windows.
6. `summary.json` `observations.windowPerRepository` holds the window count, the focus events, and the practice window's state after minimizing and after reopening.
