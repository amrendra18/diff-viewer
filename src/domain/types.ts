declare const brand: unique symbol;
type Brand<T, Name extends string> = T & { readonly [brand]: Name };

/** Absolute, symlink-resolved path of a repository's top folder (or of a bare repository). */
export type RepoPath = Brand<string, 'RepoPath'>;
/** Full lowercase hex object name: 40 characters, or 64 in a SHA-256 repository. */
export type CommitHash = Brand<string, 'CommitHash'>;
/** Path relative to the repository's top folder, with forward slashes, as git prints it. */
export type FilePath = Brand<string, 'FilePath'>;

export type Source =
  | { readonly kind: 'commit'; readonly hash: CommitHash }
  | { readonly kind: 'staged' }
  | { readonly kind: 'unstaged' };

/**
 * A launcher selection stays pending until the page reports what it shows for it. A null source asks only for the
 * repository view, for a later open without --source of a window that may show a card.
 */
export interface RequestedView { readonly id: string; readonly source: Source | null }

export interface CommitSummary {
  readonly hash: CommitHash;
  readonly subject: string;
  readonly authorName: string;
  /** Author time, ISO 8601 with offset. */
  readonly authorTime: string;
  /** Empty for a root commit; two or more for a merge. A merge is diffed against parents[0]. */
  readonly parents: readonly CommitHash[];
}

export interface RepoInfo {
  readonly path: RepoPath;
  /** Folder name shown in the header. */
  readonly name: string;
  /** Current branch name, or null when HEAD is detached. */
  readonly branch: string | null;
  /** A bare repository has commits only: no staged or unstaged source. */
  readonly bare: boolean;
  /** Null when git could not list that source, for example when a working file's required clean filter is missing. */
  readonly stagedCount: number | null;
  readonly unstagedCount: number | null;
  /** Newest first, at most COMMIT_PAGE_SIZE entries. */
  readonly commits: CommitPage;
  /**
   * The file list of the tab the load named, listed once for both its count and its list, so a refresh runs each listing
   * once. Null when the load named no tab.
   */
  readonly files: Result<readonly ChangedFile[]> | null;
}

/** The staged or unstaged tab, whose file list a repository load can return with the counts. */
export type WorkingKind = 'staged' | 'unstaged';

export interface CommitPage {
  readonly commits: readonly CommitSummary[];
  /** True when older commits exist beyond this page. */
  readonly more: boolean;
}

/** 'unmerged' appears only in the unstaged source: a file with a merge conflict, shown once. */
export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'unmerged';

export type FileContent = 'text' | 'binary' | 'submodule' | 'symlink';

export interface ChangedFile {
  readonly path: FilePath;
  /** Set only when status is 'renamed'. */
  readonly oldPath: FilePath | null;
  readonly status: ChangeStatus;
  readonly content: FileContent;
  /**
   * Line counts from git's numstat. Null for binary content, for an untracked file over LARGE_FILE_BYTES or one the app
   * cannot read, and for a commit's file in a partial clone, whose missing file data the app never fetches.
   */
  readonly added: number | null;
  readonly removed: number | null;
  /** Only in the unstaged source: a file git does not track yet. */
  readonly untracked: boolean;
}

/** One color per appearance, from Shiki's light and dark themes. */
export interface TokenColor {
  readonly light: string;
  readonly dark: string;
}

export interface Token {
  readonly text: string;
  /** Null before highlighting. */
  readonly color: TokenColor | null;
  /** True inside a changed line for the words that differ from the paired line. */
  readonly changed: boolean;
}

export interface Line {
  /** 1-based line number in its own file version. */
  readonly number: number;
  readonly tokens: readonly Token[];
}

export type DiffRow =
  | { readonly kind: 'context'; readonly left: Line; readonly right: Line }
  /** A removed line, an added line, or a removed and added pair. Never both null. */
  | { readonly kind: 'change'; readonly left: Line | null; readonly right: Line | null }
  /** Unchanged lines between changes, collapsed. The page expands them without a new request. */
  | { readonly kind: 'hidden'; readonly rows: readonly ContextRow[] };

export type ContextRow = Extract<DiffRow, { kind: 'context' }>;

export type FileDiff =
  | { readonly kind: 'text'; readonly file: ChangedFile; readonly rows: readonly DiffRow[] }
  | { readonly kind: 'binary'; readonly file: ChangedFile; readonly oldSize: number | null; readonly newSize: number | null }
  /** Over LARGE_FILE_LINES in either version or in the diff; fileDiff with showLarge true returns the 'text' form. */
  | { readonly kind: 'tooLarge'; readonly file: ChangedFile; readonly over: 'lines'; readonly lineCount: number }
  /** Over LARGE_FILE_BYTES in either version, found from the sizes before either version is read. byteCount is the larger size. */
  | { readonly kind: 'tooLarge'; readonly file: ChangedFile; readonly over: 'bytes'; readonly byteCount: number }
  | { readonly kind: 'submodule'; readonly file: ChangedFile; readonly oldCommit: CommitHash | null; readonly newCommit: CommitHash | null }
  | { readonly kind: 'symlink'; readonly file: ChangedFile; readonly oldTarget: string | null; readonly newTarget: string | null }
  | { readonly kind: 'modeOnly'; readonly file: ChangedFile; readonly oldMode: string; readonly newMode: string };

export const LARGE_FILE_LINES = 5000;
export const LARGE_FILE_BYTES = 200000;
/** Unchanged lines shown around each change, as git shows by default. */
export const CONTEXT_LINES = 3;
/** The end of a window title once its page shows a repository. Main waits for it before it reports a window as ready. */
export const TITLE_SUFFIX = ' · diff-viewer';
/** The page's calls to main. */
export const CALL_CHANNEL = 'diff-viewer:call';
/** Main's requested views to a running page. */
export const VIEW_CHANNEL = 'diff-viewer:requested-view';
/** Repositories kept in the recent list. */
export const RECENT_LIMIT = 10;
export const VIEW_MESSAGE_LIMIT = 4096;
/** A full commit hash: 40 lowercase hex characters, or 64 in a SHA-256 repository. */
export const FULL_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Commits per page; bar 1 times the first page. */
export const COMMIT_PAGE_SIZE = 200;

export type AppError =
  | { readonly kind: 'notARepository'; readonly path: string }
  | { readonly kind: 'repositoryGone'; readonly path: RepoPath }
  | { readonly kind: 'unknownCommit'; readonly text: string }
  | { readonly kind: 'unknownFile'; readonly path: string }
  /** A working file the app may not open, such as one with mode 000, or one git's diff does not fit. `message` says why. */
  | { readonly kind: 'unreadableFile'; readonly path: string; readonly message: string }
  | { readonly kind: 'gitFailed'; readonly message: string };

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: AppError };

/** Problems the page can show: main's errors, and 'refused' for a call main refused or a view another click replaced. */
export const VIEW_PROBLEMS = ['notARepository', 'repositoryGone', 'unknownCommit', 'unknownFile', 'unreadableFile', 'gitFailed', 'refused'] as const;

/**
 * What the page shows for a requested view, once painted: the source's file list with its first file open (null for an
 * empty list), or the problem it shows instead of the list, with the text it shows.
 */
export type ViewReport =
  | { readonly ok: true; readonly firstFile: FilePath | null }
  | { readonly ok: false; readonly problem: typeof VIEW_PROBLEMS[number]; readonly message: string };

/** The only object the preload exposes to the page, as window.diffViewer. Main validates every argument. */
export interface DiffViewerApi {
  /**
   * Shows the folder chooser. Null when the user cancels, or when the chosen repository opens in another window:
   * a window with no repository (the first-run screen) takes the chosen repository itself; a window that already
   * shows one opens a new window, and a repository already open in a window focuses that window.
   * A folder that is not a repository returns the notARepository error to the calling window.
   */
  openRepository(): Promise<Result<RepoInfo> | null>;
  /**
   * Reloads the repository this window shows: counts and the first commit page, and with `list` that tab's files. Null when
   * this window has no repository yet (the first-run screen).
   */
  repository(list?: WorkingKind | null): Promise<Result<RepoInfo> | null>;
  commits(skip: number): Promise<Result<CommitPage>>;
  /** Resolves a pasted hash prefix to a commit on any branch. */
  resolveCommit(text: string): Promise<Result<CommitSummary>>;
  files(source: Source): Promise<Result<readonly ChangedFile[]>>;
  /** `oldPath` is a renamed file's old path from its listing; main lists only these paths, so a click costs the same in any size of commit. */
  fileDiff(source: Source, path: FilePath, showLarge: boolean, oldPath?: FilePath | null): Promise<Result<FileDiff>>;
  recent(): Promise<readonly RepoPath[]>;
  /** Same window rules as openRepository; null when the repository opens or is focused in another window. */
  openRecent(path: RepoPath): Promise<Result<RepoInfo> | null>;
  requestedView(): Promise<RequestedView | null>;
  viewReady(id: string, report: ViewReport): Promise<boolean>;
  onRequestedView(callback: (view: RequestedView) => void): void;
}
