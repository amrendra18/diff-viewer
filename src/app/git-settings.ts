// No imports here: scripts/verify.mts loads this file with Node's type stripping to run the app's exact status command.

/**
 * Passed as `-c` pairs on every git call. The user's own settings must not change the text the app parses:
 * a signature check printed into log output, subjects re-encoded away from UTF-8, or rename detection turned off or capped.
 */
export const GIT_SETTINGS = [
  'core.quotepath=off', 'core.fsmonitor=false', 'color.ui=false', 'log.showSignature=false', 'i18n.logOutputEncoding=UTF-8',
  'diff.renameLimit=1000', 'status.renames=true', 'status.renameLimit=1000',
] as const;

/** Global options after the settings, before `-C <repository>`. */
export const GIT_OPTIONS = ['--literal-pathspecs'] as const;

/**
 * Set on every git call. Optional locks off, so git status never rewrites the index of a repository the app only reads.
 * In a partial clone, git would fetch a missing object from the promisor remote and write a pack into .git. Git 2.44 and
 * newer skip that fetch with GIT_NO_LAZY_FETCH. On older git, a GIT_ALLOW_PROTOCOL that names no real transport refuses
 * it. Either way git fetches nothing: a commit's file list leaves out line counts (git.ts commitListing), and opening a
 * file whose data is missing shows git's error for that file.
 */
export const GIT_ENVIRONMENT = [['GIT_OPTIONAL_LOCKS', '0'], ['GIT_TERMINAL_PROMPT', '0'], ['GIT_NO_LAZY_FETCH', '1'], ['GIT_ALLOW_PROTOCOL', 'none']] as const;

/**
 * AGENTS.md rule 2: the only git commands the app runs. Plain `git diff` is missing on purpose: it rewrites a stale index
 * even with GIT_OPTIONAL_LOCKS=0 (unit test stale-index).
 */
export const GIT_COMMANDS = ['log', 'diff-tree', 'diff-index', 'diff-files', 'cat-file', 'ls-files', 'rev-parse', 'status', 'check-attr'] as const;
export type GitCommand = typeof GIT_COMMANDS[number];

/** Only for the branch name of a repository with no commit yet, where rev-parse cannot name HEAD. */
export const STATUS_ARGUMENTS = ['--porcelain=v2', '--branch', '--untracked-files=no', '-z'] as const;
