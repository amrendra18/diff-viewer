# Your own git settings

## Sub-features

1. Your own git settings do not change what the app shows. `src/app/git-settings.ts` pins every setting found to change the text the app parses.
2. Pinned: `log.showSignature=false` (signature checks printed into log output), `i18n.logOutputEncoding=UTF-8` (subjects and names re-encoded), `diff.renameLimit=1000` and `status.renameLimit=1000` (rename detection capped), `status.renames=true` (renames in status turned off). Also `core.quotepath=off`, `core.fsmonitor=false`, `color.ui=false`.

## How to get to it (user POV)

1. Nothing to click. A repository with signed commits opens with correct short hashes, and clicking a commit shows its files, whatever your git settings say.

## Driving it with scripts/verify

1. Run `scripts/verify fast --feature user-git-config`.
2. The harness writes a git config to `state/git-home-user/.config/git/config` in the evidence folder. It sets `log.showSignature`, `log.decorate`, `i18n.logOutputEncoding`, `diff.renameLimit`, `diff.suppressBlankEmpty`, `diff.noprefix`, `status.renames`, `status.renameLimit`, `core.abbrev`, and `color.ui`. The real git config of the person running the harness is never read or changed.
3. Positive control. It runs the app's `log` and `diff-tree --raw` commands with only `core.quotepath`, `core.fsmonitor`, and `color.ui` pinned, once under that config and once under an empty one. Expected: both outputs change. This shows the config does break the commands when nothing pins it.
4. It launches the app with `HOME` and `XDG_CONFIG_HOME` pointing at that config, then runs the open-repository checks (including the accented subject), the commit-diff checks (short hash of the signed newest commit, its 4 files with the rename, side-by-side rows, the hidden-lines bar, the empty line), and the hostile-text checks.
5. `summary.json` `observations.userGitConfig` holds the config, the control result, and whether the newest commit is signed.

## Gotchas

1. The practice repository's newest commit carries a fixed SSH signature header that verifies against no key. With `log.showSignature=true`, git prints `No signature` before that commit's record. No key is generated or stored.
2. `status.renames` and `status.renameLimit` change the staged count only when a rename is staged. The practice repository stages none, so this journey does not see those two. They were measured once on scratch repositories: `status.renames=false` turned one staged rename into a delete and an add, and `status.renameLimit=1` did the same to two edited staged renames. The pins restored both.
3. `core.abbrev`, `diff.suppressBlankEmpty`, `diff.noprefix`, and `log.decorate` stay unpinned on purpose. They change bytes that the parser ignores (the patch `index` line, empty context lines) or bytes these commands do not print. The journey keeps them in the config to prove that. `color.ui = always` is there to show the `color.ui=false` pin holds.
4. Git reads `~/.gitconfig` after the `XDG_CONFIG_HOME` file, so the harness also points `HOME` at the evidence folder. Without that, a setting in your own `~/.gitconfig` could cancel the test config.
