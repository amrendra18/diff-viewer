# Recent repositories

## Sub-features

1. The app remembers the last 10 repositories it opened, newest first, in `recent.json` in its data folder. The first write creates the data folder when it does not exist yet.
2. The header menu lists them and marks the one this window shows.
3. Choosing a repository that was deleted shows "This repository is no longer there" with its path, and removes it from `recent.json`.
4. That card offers "Back to <repository>" when the window still has a repository open. It brings back the same view, with the same commit and file.

## How to get to it (user POV)

1. Click the repository name in the header. The menu lists recent repositories.

## Driving it with scripts/verify

1. Run `scripts/verify fast --feature recent-repositories`.
2. The harness builds a throwaway copy of the practice repository named `gone`. With one shared data folder that does not exist yet, it opens `gone`, then `special`, each in its own app run, and waits for each app to exit. After the first run it expects `recent.json` to hold `gone`.
3. It deletes `gone` and opens `practice` with the same data folder.
4. It expects `recent.json` to hold practice, special, and gone, in that order. It opens the commit "Fix a typo in the README" and its file `README.md`. It expects the menu to list the same three with a check mark on practice only.
5. It clicks `gone` and expects the repository-gone card naming its path. `recent.json` must then hold only practice and special, in that order.
6. It clicks "Back to practice" and expects the repository view again, with the same commit selected and `README.md` shown.

## Gotchas

1. The runs that share a data folder wait for the previous app to exit first, about 15 s each on macOS.
2. `src/app/main.ts` creates the `--data-dir` folder itself, so step 2 cannot fail on `recent.ts` alone. The unit test `recent-list: the first write creates a user-data folder that does not exist yet` covers the packaged app started directly, without `--data-dir`. The installed command always passes `--data-dir`, and `src/app/main.ts` creates that folder.
