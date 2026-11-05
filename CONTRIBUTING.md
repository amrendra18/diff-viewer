# Contributing

Read [AGENTS.md](AGENTS.md) first. Its rules hold for people and coding agents alike: read-only git, the allowed git commands, the closed page, untrusted text, and exact dependency pins.

## Set up

Follow "Install" in the [README](README.md#install).

## Checks

Run these from the top of the checkout. `./scripts/check` prints its exit code on its last line. `scripts/verify` prints the evidence folder on its last line and exits with its result code.

1. `./scripts/check fast`: build, type checks, lint, and unit tests. Run it after every change. Seven unit test files open app windows: `boundary`, `card-recovery`, `focus-refresh`, `hand-off`, `many-rows`, `refresh-click`, and `try-again`. They are the files in `tests/` that use `_electron` from Playwright or `withStandInGit` from `tests/electron-test.mts`. The slowest of their tests take about 20 s, and `many-rows` takes about 75 s. Leave the Mac alone while they run. The step gives each test at most 120 s (`--test-timeout=120000`), and `many-rows` has its own limit of 240 s. `--test-force-exit` then ends a test file that left an app window open, so a stuck test fails the step.
2. `scripts/verify fast`: starts the app with Playwright on generated test repositories and proves each feature in [verify/features/README.md](verify/features/README.md). Run it when a change touches `src/`, `bin/`, `scripts/`, or the page. `scripts/verify fast --feature NAME` runs one feature. The three launcher features build and sign the app bundle first. That rebuilds `.local/build/diff-viewer.app`, the bundle the installed `diff-viewer` command starts, from your working tree. Quit the app first, and run `scripts/package` again on a reviewed commit before daily use.
3. `./scripts/check full --fixtures-only`: everything above, plus unused-code and duplicate-code checks, `scripts/hand-journey --check`, `scripts/verify full`, and five planted faults (deliberate breaks each check must catch). Run it before you open a pull request.
4. `./scripts/check full`: check 3, plus the speed bars on two large real repositories you choose. [verify/features/README.md](verify/features/README.md) step 4 explains the two variables.

`scripts/verify` and `./scripts/check full` open app windows and take focus. Keep the Mac unlocked and leave it alone while they run, or the focus journeys can fail. On a locked screen, `scripts/verify` stops with exit 3 before it starts the app.

## Other scripts

1. `scripts/start [--open PATH] [--data-dir FOLDER]` builds and runs the app from the checkout. App data goes to `.local/app-data` unless `--data-dir` names another absolute folder. While the app runs with that folder, a second `scripts/start` opens nothing and says so.
2. `scripts/fixtures DIR` builds the practice repositories the tests use.
3. `scripts/hand-journey` builds a practice repository under `.local/hand/`, prints steps to try by hand, and starts the app.
4. `scripts/package` builds `.local/build/diff-viewer.app` with an ad-hoc signature.

## Changes

1. Follow [AGENTS.md](AGENTS.md) rules 5 (failing test first, smallest change) and 8 (a changed journey updates `verify/features/` and the harness together).
2. Pin a new dependency to an exact version. It must have been released at least 21 days earlier; `npm view NAME time` shows release dates.
3. In a pull request, list the commands you ran with their exit codes, and anything you skipped.

`.gitmessage` is a commit message template; `git config commit.template .gitmessage` turns it on. It is optional.

The commit hooks in `.pre-commit-config.yaml` call [`first-commit`](https://github.com/amrendra18/first-commit), a separate tool. On each commit it scans the staged files for secrets and private data and checks the commit message. On each push it checks the clone's setup and the commits the push sends. `first-commit check` scans the whole clone. `.repo-policy.json` holds its settings for this repository. To use the hooks, put `pre-commit` and `first-commit` on your `PATH`, then run the one-time `first-commit setup` in your clone. It sets up files, Git settings, hooks, and Gitleaks, and saves your identity in `~/.config/first-commit/identity.json`. Add `--dry-run` to preview it. The hooks are optional for contributors. The checks above are what a pull request must pass.
