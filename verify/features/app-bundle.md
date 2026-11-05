# App bundle

## Sub-features

1. `scripts/package` builds `.local/build/diff-viewer.app` with @electron/packager 20.3.0.
2. The bundle has an ad-hoc signature (`codesign --sign -`). No Apple account and no notarization.
3. `codesign --verify --deep --strict` exits 0 on the bundle.
4. The bundle starts with `--open PATH` and shows the same commit list as the checkout build.
5. Shiki runs inside the bundle: a TypeScript file opens highlighted.

## How to get to it (user POV)

1. Run `scripts/package`. The last line prints the bundle path.
2. Run `.local/build/diff-viewer.app/Contents/MacOS/diff-viewer --open /path/to/repository`.

## Driving it with scripts/verify

1. Run `scripts/verify full --feature app-bundle`. It runs at the full level only.
2. The harness packages the app, writes `logs/codesign.log`, and expects verify exit 0 and `Signature=adhoc`.
3. It launches the bundle's executable with `--open` on the practice repository, checks that the running app is packaged, and runs the open-repository checks.
4. It opens `src/app.ts` in the newest commit and expects the `export` keyword in the github-light keyword color `#D73A49`. Screen: `app-bundle-highlighted.png`.

## Gotchas

1. Packaging reuses the Electron zip that the install step put in `.local/electron-cache`, so it needs no network. Without that zip, packager downloads it into the same folder.
2. The bundle is about 288 MB. app-bundle and each launcher feature rebuild it, so every fast and full run does, in about 3 s each time. It is the bundle the installed `diff-viewer` command starts.
3. Without `--data-dir`, the bundle writes to the normal Electron user-data folder. The harness always passes `--data-dir` inside the evidence folder.
