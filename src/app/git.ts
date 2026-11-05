import { execFile } from 'node:child_process';
import { constants, existsSync, realpathSync } from 'node:fs';
import { lstat, open as openFile, readdir, readlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { diffRows, sharedRuns, splitLines } from '../domain/diff.ts';
import { COMMIT_PAGE_SIZE, CONTEXT_LINES, FULL_HASH, LARGE_FILE_BYTES, LARGE_FILE_LINES } from '../domain/types.ts';
import type { AppError, ChangedFile, ChangeStatus, CommitHash, CommitPage, CommitSummary, FileContent, FileDiff, FilePath, RepoInfo, RepoPath, Result, Source, WorkingKind } from '../domain/types.ts';
import { GIT_ENVIRONMENT, GIT_OPTIONS, GIT_SETTINGS, STATUS_ARGUMENTS } from './git-settings.ts';
import type { GitCommand } from './git-settings.ts';
import { highlightPair } from './highlight-client.mts';

export interface Repository {
  readonly path: RepoPath;
  readonly bare: boolean;
}

/** One side of a change: absent, a git object (blob, link target, or submodule commit), or the working folder's copy at the change's path. */
type Side =
  | { readonly kind: 'none' }
  | { readonly kind: 'object'; readonly mode: string; readonly name: string }
  | { readonly kind: 'disk'; readonly mode: string };

interface Change {
  readonly file: ChangedFile;
  readonly old: Side;
  readonly new: Side;
}

/** The changed files of one source, and git's unified diff of one of them. */
interface Listing {
  readonly changes: readonly Change[];
  /** Called only when the old version exists; an added file's diff is built from its text. */
  patch(change: Change): Promise<string>;
}

class GitError extends Error {
  readonly error: AppError;
  /** False when git itself could not start, for example when it is not on PATH. */
  readonly started: boolean;
  constructor(error: AppError, started = true) { super(error.kind); this.error = error; this.started = started; }
}

const GIT_MISSING = 'git was not found on PATH. Install git, for example with xcode-select --install, then try again.';

const ZERO = /^0+$/;
const NO_MODE = '000000';
const NONE: Side = { kind: 'none' };
/** `git hash-object -t tree /dev/null` for each object format; hash-object is outside AGENTS.md rule 2. */
const EMPTY_TREE: Readonly<Record<string, string>> = {
  sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321',
};
/** Git calls a file binary when a NUL byte sits in its first 8,000 bytes. */
const BINARY_PROBE_BYTES = 8000;
const NO_FOLLOW = constants.O_RDONLY | constants.O_NOFOLLOW;
const DIFF_MISFIT = 'Git\'s diff does not fit this file on disk. A git filter, such as git-lfs, may rewrite the file before git compares it, or the file changed just now.';
const ok = <T>(value: T): Result<T> => ({ ok: true, value });

function cleanEnvironment(extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  return { ...env, ...Object.fromEntries(GIT_ENVIRONMENT), ...extra };
}

function git(folder: string, command: GitCommand, args: readonly string[], { input, env = {} }: { input?: string; env?: Readonly<Record<string, string>> } = {}): Promise<string> {
  const fixed = [...GIT_SETTINGS.flatMap(setting => ['-c', setting]), ...GIT_OPTIONS, '-C', folder, command];
  return new Promise((done, fail) => {
    const child = execFile('git', [...fixed, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: cleanEnvironment(env) }, (error, stdout, stderr) => {
      // A spawn failure has a string code such as ENOENT; a git that ran and failed has its exit status as a number.
      if (error && typeof error.code === 'string') fail(new GitError({ kind: 'gitFailed', message: error.code === 'ENOENT' ? GIT_MISSING : error.message }, false));
      else if (error) fail(new GitError({ kind: 'gitFailed', message: (stderr || error.message).trim() }));
      else done(stdout);
    });
    if (input !== undefined) {
      // A git that exits before it reads its input breaks the pipe. Its exit status, above, reports the failure.
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(input);
    }
  });
}

const gone = (repo: Repository) => !existsSync(repo.path) || (!repo.bare && !existsSync(join(repo.path, '.git')));

async function attempt<T>(work: () => Promise<T>, repo?: Repository): Promise<Result<T>> {
  try { return ok(await work()); }
  catch (error) {
    if (repo && gone(repo)) return { ok: false, error: { kind: 'repositoryGone', path: repo.path } };
    if (error instanceof GitError) return { ok: false, error: error.error };
    return { ok: false, error: { kind: 'gitFailed', message: error instanceof Error ? error.message : String(error) } };
  }
}

/** Git's own answer for a folder with no repository in it or above it. LC_ALL=C keeps the answer in English. */
const NOT_A_REPOSITORY = /^fatal: not a git repository/m;

/**
 * notARepository only for a missing folder or git's own "not a git repository" answer. Any other failure, such as a
 * broken .git/config or git's refusal of a folder another user owns, keeps git's message.
 */
export function openRepository(folder: string): Promise<Result<Repository>> {
  return attempt(async () => {
    const absolute = resolve(folder);
    const notARepository = new GitError({ kind: 'notARepository', path: absolute });
    if (!existsSync(absolute)) throw notARepository;
    let bare: boolean;
    try { bare = (await git(absolute, 'rev-parse', ['--is-bare-repository'], { env: { LC_ALL: 'C' } })).trim() === 'true'; }
    catch (error) {
      const message = error instanceof GitError && error.started && error.error.kind === 'gitFailed' ? error.error.message : '';
      throw NOT_A_REPOSITORY.test(message) ? notARepository : error;
    }
    const top = (await git(absolute, 'rev-parse', [bare ? '--absolute-git-dir' : '--show-toplevel'])).replace(/\r?\n$/, '');
    return { path: realpathSync(top) as RepoPath, bare };
  });
}

async function hasHead(repo: Repository): Promise<boolean> {
  try { await git(repo.path, 'rev-parse', ['--verify', '--quiet', 'HEAD^{commit}']); return true; }
  catch (error) {
    if (gone(repo)) throw error;
    return false;
  }
}

async function branchName(repo: Repository): Promise<string | null> {
  if (await hasHead(repo)) {
    const ref = (await git(repo.path, 'rev-parse', ['--symbolic-full-name', 'HEAD'])).trim();
    return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
  }
  if (repo.bare) return null;
  const head = (await git(repo.path, 'status', STATUS_ARGUMENTS)).split('\0').find(entry => entry.startsWith('# branch.head '));
  const name = head?.slice('# branch.head '.length);
  return name && name !== '(detached)' ? name : null;
}

const COMMIT_FORMAT = '--format=%H%x00%P%x00%an%x00%aI%x00%s';

function parseCommits(out: string): CommitSummary[] {
  const fields = out.split('\0');
  const commits: CommitSummary[] = [];
  for (let index = 0; index + 4 < fields.length; index += 5) {
    const [hash, parents, authorName, authorTime, subject] = fields.slice(index, index + 5);
    commits.push({ hash: hash as CommitHash, parents: parents ? parents.split(' ') as CommitHash[] : [], authorName, authorTime, subject });
  }
  return commits;
}

async function readCommits(repo: Repository, skip: number): Promise<CommitPage> {
  if (!(await hasHead(repo))) return { commits: [], more: false };
  const commits = parseCommits(await git(repo.path, 'log', ['-z', COMMIT_FORMAT, `--skip=${skip}`, `--max-count=${COMMIT_PAGE_SIZE + 1}`, 'HEAD', '--']));
  return { commits: commits.slice(0, COMMIT_PAGE_SIZE), more: commits.length > COMMIT_PAGE_SIZE };
}

export function commitPage(repo: Repository, skip: number): Promise<Result<CommitPage>> {
  return attempt(() => readCommits(repo, skip), repo);
}

/**
 * The one commit, on any branch or none, whose name starts with `text` (4 to 64 hex characters; SHA-256 names are 64 long).
 * Every object with that prefix is listed, so a branch or tag named like a hash cannot stand in for it.
 */
export function resolveCommit(repo: Repository, text: string): Promise<Result<CommitSummary>> {
  return attempt(async () => {
    const unknown = new GitError({ kind: 'unknownCommit', text });
    const prefix = text.toLowerCase();
    if (!/^[0-9a-f]{4,64}$/.test(prefix)) throw unknown;
    const objects = (await git(repo.path, 'rev-parse', [`--disambiguate=${prefix}`]).catch(() => '')).split('\n').filter(Boolean);
    // One cat-file process for every listed object, however many share the prefix.
    const types = objects.length ? (await git(repo.path, 'cat-file', ['--batch-check=%(objecttype)'], { input: objects.join('\n') + '\n' })).split('\n') : [];
    const commits = objects.filter((_, index) => types[index] === 'commit');
    if (commits.length !== 1) throw unknown;
    const [commit] = parseCommits(await git(repo.path, 'log', ['-1', '-z', COMMIT_FORMAT, commits[0], '--']));
    return commit;
  }, repo);
}

/** The full hash git finds for `name`, or '' when it finds none. */
const verified = async (repo: Repository, name: string) => (await git(repo.path, 'rev-parse', ['--verify', '--quiet', '--end-of-options', name]).catch(() => '')).trim();

/**
 * Resolve a launcher revision before it can reach a listing or diff command. Git gives the same answer for a name it does
 * not know and for a commit it cannot read, so a name that resolves is read once more: unknownCommit only for a name that
 * names no commit, and gitFailed with git's line when the object it names cannot be read.
 */
export function resolveRevision(repo: Repository, revision: string): Promise<Result<CommitHash>> {
  return attempt(async () => {
    const hash = await verified(repo, `${revision}^{commit}`);
    if (FULL_HASH.test(hash)) return hash as CommitHash;
    const named = await verified(repo, revision);
    // A full hash resolves to itself without a read, so for one the repository does not hold, a failed read means unknown.
    if (FULL_HASH.test(named) && named !== revision.toLowerCase()) {
      try { await git(repo.path, 'cat-file', ['-t', named]); }
      catch (error) {
        if (!(error instanceof GitError && error.error.kind === 'gitFailed' && error.started)) throw error;
        throw new GitError({ kind: 'gitFailed', message: `git could not read commit ${revision} (${named}) in ${repo.path}: ${error.error.message.split('\n')[0]}` });
      }
    }
    throw new GitError({ kind: 'unknownCommit', text: revision });
  }, repo);
}

const STATUS: Record<string, ChangeStatus> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', T: 'modified', U: 'unmerged' };

/** A side of a raw record. All zeros with a mode means the working folder: only diff-files reports it. */
function sideOf(mode: string, name: string): Side {
  if (mode === NO_MODE) return NONE;
  return ZERO.test(name) ? { kind: 'disk', mode } : { kind: 'object', mode, name };
}

const modeOf = (side: Side) => side.kind === 'none' ? NO_MODE : side.mode;

function contentOf(old: Side, current: Side, added: string): FileContent {
  const modes = [modeOf(old), modeOf(current)];
  if (modes.includes('160000')) return 'submodule';
  if (modes.includes('120000')) return 'symlink';
  return added === '-' ? 'binary' : 'text';
}

/**
 * Parses `--raw --numstat -z`. A raw record with no numstat record is dropped: diff-files lists a file whose time changed
 * but whose content did not, because the app cannot refresh the index, and only the numstat pass compares content.
 * With `counted` false the output is `--raw -z` alone, and every record is kept as a file without line counts.
 */
function parseChanges(out: string, counted = true): Change[] {
  const fields = out.split('\0');
  const records: { old: Side; new: Side; status: ChangeStatus; oldPath: string; path: string }[] = [];
  let index = 0;
  while (fields[index]?.startsWith(':')) {
    const [oldMode, newMode, oldName, newName, letter] = fields[index++].slice(1).split(' ');
    const status = STATUS[letter[0]];
    if (!status) throw new GitError({ kind: 'gitFailed', message: `Unexpected change status ${letter}.` });
    const oldPath = fields[index++];
    const path = status === 'renamed' ? fields[index++] : oldPath;
    records.push({ old: sideOf(oldMode, oldName), new: sideOf(newMode, newName), status, oldPath, path });
  }
  const counts = new Map<string, [string, string]>();
  while (index < fields.length && fields[index] !== '') {
    const [added, removed, ...rest] = fields[index++].split('\t');
    const path = rest.join('\t');
    // A rename's numstat record leaves the path empty and names the old and new paths in the next two fields.
    counts.set(path === '' ? fields[(index += 2) - 1] : path, [added, removed]);
  }
  return records.flatMap(record => {
    const count = counted ? counts.get(record.path) : ['', ''];
    if (!count) return [];
    const [added, removed] = count;
    const file: ChangedFile = {
      path: record.path as FilePath,
      oldPath: record.status === 'renamed' ? record.oldPath as FilePath : null,
      status: record.status,
      content: contentOf(record.old, record.new, added),
      added: added === '-' || added === '' ? null : Number(added),
      removed: removed === '-' || removed === '' ? null : Number(removed),
      untracked: false,
    };
    return [{ file, old: record.old, new: record.new }];
  });
}

const pathsOf = (file: ChangedFile) => file.oldPath ? [file.oldPath, file.path] : [file.path];
const PATCH = ['-p', `-U${CONTEXT_LINES}`, '--no-ext-diff', '--no-textconv'] as const;
const EMPTY: Listing = { changes: [], patch: () => Promise.resolve('') };

async function firstParent(repo: Repository, hash: CommitHash): Promise<CommitHash | null> {
  let out: string;
  try { out = await git(repo.path, 'log', ['-1', '--format=%P', hash, '--']); }
  catch { throw new GitError({ kind: 'unknownCommit', text: hash }); }
  const parent = out.trim().split(' ')[0];
  return parent ? parent as CommitHash : null;
}

/** Every changed path, or with `only` (one file, and a rename's old path) just those, so one file's diff costs the same in any size of commit. */
type Only = readonly string[] | undefined;
const limitTo = (only: Only) => only ? ['--', ...only] : [];

/**
 * True when the repository holds data fetched from a promisor remote, as a partial clone does: git marks each such pack
 * with a .promisor file. Only a partial clone may lack file data on purpose.
 */
async function fromPromisor(repo: Repository): Promise<boolean> {
  const packs = resolve(repo.path, (await git(repo.path, 'rev-parse', ['--git-path', 'objects/pack'])).replace(/\r?\n$/, ''));
  return (await readdir(packs).catch(() => [])).some(name => name.endsWith('.promisor'));
}

/** A commit against its first parent, or against nothing for a root commit. */
async function commitListing(repo: Repository, hash: CommitHash, only: Only): Promise<Listing> {
  const parent = await firstParent(repo, hash);
  const range = parent ? [parent, hash] : ['--root', hash];
  const raw = ['-r', '-M', '--no-commit-id', '--raw', '-z', ...range, ...limitTo(only)];
  let changes: Change[];
  try { changes = parseChanges(await git(repo.path, 'diff-tree', ['--numstat', ...raw])); }
  catch (error) {
    // In a partial clone, --numstat and inexact rename detection need file data that is not on disk, and the app never
    // fetches it (GIT_ENVIRONMENT in git-settings.ts). Raw records with exact renames only (-M100%) need just the trees,
    // so the files are listed without line counts; opening one whose data is missing shows git's error. When this
    // listing fails too, git's first answer stands. In any other repository a missing object is damage, so git's answer stands.
    if (!(error instanceof GitError) || !error.started || !(await fromPromisor(repo))) throw error;
    try { changes = parseChanges(await git(repo.path, 'diff-tree', raw.map(arg => arg === '-M' ? '-M100%' : arg)), false); }
    catch { throw error; }
  }
  return { changes, patch: change => git(repo.path, 'diff-tree', [...PATCH, '-M', '--no-commit-id', ...range, '--', ...pathsOf(change.file)]) };
}

/** What `--cached` compares the index with: HEAD, or the empty tree before the first commit. */
async function stagedBase(repo: Repository): Promise<string> {
  if (await hasHead(repo)) return 'HEAD';
  return EMPTY_TREE[(await git(repo.path, 'rev-parse', ['--show-object-format'])).trim()] ?? EMPTY_TREE.sha1;
}

/**
 * The last commit against the index. A conflicted file is left out: it shows once, in the unstaged listing.
 * --ita-invisible-in-index leaves out a file added with `git add -N`, which holds no staged content yet.
 */
async function stagedListing(repo: Repository, only: Only): Promise<Listing> {
  if (repo.bare) return EMPTY;
  const base = await stagedBase(repo);
  const compare = ['--cached', '-M', '--ita-invisible-in-index'];
  const changes = parseChanges(await git(repo.path, 'diff-index', [...compare, '--raw', '--numstat', '-z', base, ...limitTo(only)])).filter(change => change.file.status !== 'unmerged');
  return { changes, patch: change => git(repo.path, 'diff-index', [...PATCH, ...compare, base, '--', ...pathsOf(change.file)]) };
}

async function trackedUnstaged(repo: Repository, only: Only): Promise<Change[]> {
  const changes = parseChanges(await git(repo.path, 'diff-files', ['--raw', '--numstat', '-z', ...limitTo(only)]));
  const conflicted = new Set(changes.filter(change => change.file.status === 'unmerged').map(change => change.file.path));
  const byPath = new Map<string, Change>();
  for (const change of changes) {
    // A conflicted file comes twice: an unmerged record with no sides, then our side (index stage 2) against the working folder.
    if (byPath.get(change.file.path)?.old.kind === 'object') continue;
    byPath.set(change.file.path, conflicted.has(change.file.path) ? { ...change, file: { ...change.file, status: 'unmerged' } } : change);
  }
  return [...byPath.values()];
}

/** Untracked paths, ignored ones left out. A folder that holds its own repository ends with a slash. */
async function untrackedPaths(repo: Repository, only: Only): Promise<string[]> {
  return (await git(repo.path, 'ls-files', ['--others', '--exclude-standard', '-z', ...limitTo(only)])).split('\0').filter(Boolean);
}

/** The paths whose `diff` attribute is unset (`-diff` or `binary` in .gitattributes), which git shows as binary. */
async function markedBinary(repo: Repository, paths: readonly string[]): Promise<Set<string>> {
  if (!paths.length) return new Set();
  const fields = (await git(repo.path, 'check-attr', ['-z', '--stdin', 'diff'], { input: paths.join('\0') + '\0' })).split('\0');
  const binary = new Set<string>();
  for (let index = 0; index + 2 < fields.length; index += 3) if (fields[index + 2] === 'unset') binary.add(fields[index]);
  return binary;
}

/**
 * Untracked files read at once while listing. Read one at a time, 20,000 small files took 2.9 s; reads run in parallel
 * because each one mostly waits on the disk.
 */
export const UNTRACKED_READS = 16;

async function readStart(handle: FileHandle, buffer: Buffer): Promise<Buffer> {
  let filled = 0;
  while (filled < buffer.length) {
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
    if (!bytesRead) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

/**
 * An untracked file's content as git sees it, from its first bytes: binary, or text with its line count. A file over
 * LARGE_FILE_BYTES is not counted, so only its first 8,000 bytes are read; its diff answers tooLarge from its size.
 */
async function untrackedContent(file: string, size: number): Promise<{ binary: true } | { binary: false; lines: number | null }> {
  const handle = await openFile(file, NO_FOLLOW);
  try {
    const counted = size <= LARGE_FILE_BYTES;
    const data = await readStart(handle, Buffer.alloc(counted ? size : BINARY_PROBE_BYTES));
    if (data.subarray(0, BINARY_PROBE_BYTES).includes(0)) return { binary: true };
    if (!counted) return { binary: false, lines: null };
    let lines = 0;
    for (let at = data.indexOf(0x0a); at >= 0; at = data.indexOf(0x0a, at + 1)) lines++;
    return { binary: false, lines: data.length && data[data.length - 1] !== 0x0a ? lines + 1 : lines };
  } finally { await handle.close(); }
}

const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';

/**
 * One untracked path as an added file. Null when it disappeared after git listed it. A file the app cannot read, such as
 * one with mode 000, is listed without line counts; opening it shows why it cannot be read.
 */
async function untrackedChange(repo: Repository, listed: string, binaryByAttribute: boolean): Promise<Change | null> {
  const path = listed.endsWith('/') ? listed.slice(0, -1) : listed;
  const full = join(repo.path, path);
  const stats = await lstat(full).catch(() => null);
  if (!stats) return null;
  const change = (content: FileContent, added: number | null, mode: string): Change => ({
    file: { path: path as FilePath, oldPath: null, status: 'added', content, added, removed: added === null ? null : 0, untracked: true },
    old: NONE,
    new: { kind: 'disk', mode },
  });
  if (stats.isSymbolicLink()) return change('symlink', 1, '120000');
  if (stats.isDirectory()) return change('submodule', null, '160000');
  const mode = stats.mode & 0o111 ? '100755' : '100644';
  if (!stats.isFile() || binaryByAttribute) return change('binary', null, mode);
  try {
    const content = await untrackedContent(full, stats.size);
    return content.binary ? change('binary', null, mode) : change('text', content.lines, mode);
  } catch (error) {
    if (missing(error)) return null;
    return change('text', null, mode);
  }
}

async function untrackedChanges(repo: Repository, paths: readonly string[]): Promise<Change[]> {
  const binary = await markedBinary(repo, paths);
  const changes: (Change | null)[] = [];
  let next = 0;
  const reader = async () => {
    while (next < paths.length) {
      const index = next++;
      changes[index] = await untrackedChange(repo, paths[index], binary.has(paths[index]));
    }
  };
  await Promise.all(Array.from({ length: Math.min(UNTRACKED_READS, paths.length) }, reader));
  return changes.filter((change): change is Change => change !== null);
}

/**
 * The index against the working folder, plus untracked files as added files, in path order. With `only`, an untracked file
 * inside a folder named there is listed by git but not read.
 */
async function unstagedListing(repo: Repository, only: Only): Promise<Listing> {
  if (repo.bare) return EMPTY;
  const [tracked, paths] = await Promise.all([trackedUnstaged(repo, only), untrackedPaths(repo, only)]);
  const untracked = await untrackedChanges(repo, only === undefined ? paths : paths.filter(path => only.includes(path.replace(/\/$/, ''))));
  const changes = [...tracked, ...untracked].sort((a, b) => a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0);
  return {
    changes,
    // --ours compares a conflicted file's own side (index stage 2) with the working folder, instead of a combined diff.
    patch: change => git(repo.path, 'diff-files', [...PATCH, ...(change.file.status === 'unmerged' ? ['--ours'] : []), '--', change.file.path]),
  };
}

function listing(repo: Repository, source: Source, only?: Only): Promise<Listing> {
  switch (source.kind) {
    case 'commit': return commitListing(repo, source.hash, only);
    case 'staged': return stagedListing(repo, only);
    case 'unstaged': return unstagedListing(repo, only);
  }
}

/**
 * The tab counts, and with `list` that tab's files from the same listing. A count git cannot produce is null, so one working
 * file git cannot read, such as one whose required clean filter is missing, leaves the commits and the other count; that
 * tab's own list then shows git's message.
 */
async function workingState(repo: Repository, list: WorkingKind | null): Promise<{ staged: number | null; unstaged: number | null; files: Result<readonly ChangedFile[]> | null }> {
  if (repo.bare) return { staged: 0, unstaged: 0, files: list && ok([]) };
  const files = list && changedFiles(repo, { kind: list });
  const count = async (kind: WorkingKind, counted: () => Promise<number>) => {
    if (kind !== list || !files) return counted().catch(() => null);
    const listed = await files;
    return listed.ok ? listed.value.length : null;
  };
  const [staged, unstaged] = await Promise.all([
    count('staged', async () => (await stagedListing(repo, undefined)).changes.length),
    count('unstaged', async () => {
      const [tracked, untracked] = await Promise.all([trackedUnstaged(repo, undefined), untrackedPaths(repo, undefined)]);
      return tracked.length + untracked.length;
    }),
  ]);
  return { staged, unstaged, files: files && await files };
}

export function repositoryInfo(repo: Repository, list: WorkingKind | null = null): Promise<Result<RepoInfo>> {
  return attempt(async () => {
    const [branch, state, commits] = await Promise.all([branchName(repo), workingState(repo, list), readCommits(repo, 0)]);
    return { path: repo.path, name: basename(repo.path), branch, bare: repo.bare, stagedCount: state.staged, unstagedCount: state.unstaged, commits, files: state.files };
  }, repo);
}

export function changedFiles(repo: Repository, source: Source): Promise<Result<readonly ChangedFile[]>> {
  return attempt(async () => (await listing(repo, source)).changes.map(change => change.file), repo);
}

/** A working file's text. A file the app may not open, such as one with mode 000, fails with unreadableFile for that file alone. */
async function readDisk(repo: Repository, file: ChangedFile): Promise<string> {
  let handle: FileHandle;
  try { handle = await openFile(join(repo.path, file.path), NO_FOLLOW); }
  catch (error) { throw new GitError({ kind: 'unreadableFile', path: file.path, message: error instanceof Error ? error.message : String(error) }); }
  try { return await handle.readFile('utf8'); }
  finally { await handle.close(); }
}

function textOf(repo: Repository, file: ChangedFile, side: Side): Promise<string> {
  switch (side.kind) {
    case 'none': return Promise.resolve('');
    case 'object': return git(repo.path, 'cat-file', ['blob', side.name]);
    case 'disk': return readDisk(repo, file);
  }
}

async function sizeOf(repo: Repository, file: ChangedFile, side: Side): Promise<number | null> {
  switch (side.kind) {
    case 'none': return null;
    case 'object': return Number((await git(repo.path, 'cat-file', ['-s', side.name])).trim());
    case 'disk': return (await lstat(join(repo.path, file.path))).size;
  }
}

/** A link's target path, read without following the link. Null when this side is not a link. */
function targetOf(repo: Repository, file: ChangedFile, side: Side): Promise<string | null> {
  if (side.kind === 'none' || side.mode !== '120000') return Promise.resolve(null);
  return side.kind === 'object' ? git(repo.path, 'cat-file', ['blob', side.name]) : readlink(join(repo.path, file.path));
}

/** A submodule's commit. The working folder's commit is in git's diff text; the app never reads inside the submodule. */
async function commitOf(listed: Listing, change: Change, side: Side): Promise<CommitHash | null> {
  if (side.kind === 'none' || side.mode !== '160000') return null;
  if (side.kind === 'object') return side.name as CommitHash;
  if (change.old.kind === 'none') return null;
  const match = /^\+Subproject commit ([0-9a-f]+)/m.exec(await listed.patch(change));
  return match ? match[1] as CommitHash : null;
}

/** Git's diff of an added file: one hunk that adds every line. */
function addedPatch(text: string): string {
  const lines = splitLines(text);
  return lines.length ? `@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}\n`).join('')}` : '';
}

function isModeOnly({ file, old, new: current }: Change): boolean {
  return file.status === 'modified' && old.kind !== 'none' && current.kind !== 'none' && old.mode !== current.mode && file.added === 0 && file.removed === 0;
}

const WORKING_DIFF_CACHE_SIZE = 4;
const workingDiffCache = new Map<string, FileDiff>();

/** What one side's content depends on: its object name, or the working file's size, times, and inode. Null when the file cannot be checked. */
async function sideKey(repo: Repository, file: ChangedFile, side: Side): Promise<string | null> {
  switch (side.kind) {
    case 'none': return 'none';
    case 'object': return `${side.mode} ${side.name}`;
    case 'disk': {
      const stats = await lstat(join(repo.path, file.path), { bigint: true }).catch(() => null);
      return stats && `${side.mode} ${stats.size} ${stats.mtimeNs} ${stats.ctimeNs} ${stats.ino}`;
    }
  }
}

async function readFileDiff(repo: Repository, listed: Listing, change: Change, showLarge: boolean, cached: boolean): Promise<FileDiff> {
  const { file, old, new: current } = change;
  switch (file.content) {
    case 'binary': return { kind: 'binary', file, oldSize: await sizeOf(repo, file, old), newSize: await sizeOf(repo, file, current) };
    case 'submodule': return { kind: 'submodule', file, oldCommit: await commitOf(listed, change, old), newCommit: await commitOf(listed, change, current) };
    case 'symlink': return { kind: 'symlink', file, oldTarget: await targetOf(repo, file, old), newTarget: await targetOf(repo, file, current) };
    case 'text': break;
  }
  if (isModeOnly(change)) return { kind: 'modeOnly', file, oldMode: modeOf(old), newMode: modeOf(current) };
  const sides = cached ? await Promise.all([sideKey(repo, file, old), sideKey(repo, file, current)]) : [null];
  const key = sides.includes(null) ? null : JSON.stringify([repo.path, file, showLarge, ...sides]);
  const known = key === null ? undefined : workingDiffCache.get(key);
  if (known) return known;
  const diff = await readTextDiff(repo, listed, change, showLarge);
  if (key !== null) {
    workingDiffCache.set(key, diff);
    for (const oldest of workingDiffCache.keys()) if (workingDiffCache.size > WORKING_DIFF_CACHE_SIZE) workingDiffCache.delete(oldest);
  }
  return diff;
}

async function readTextDiff(repo: Repository, listed: Listing, change: Change, showLarge: boolean): Promise<FileDiff> {
  const { file, old, new: current } = change;
  // Both limits are checked before a version is read: the listing counted an added file's lines when it is small enough, and every version's size is known.
  if (old.kind === 'none' && !showLarge && file.added !== null && file.added > LARGE_FILE_LINES) return { kind: 'tooLarge', file, over: 'lines', lineCount: file.added };
  if (!showLarge) {
    const [oldBytes, newBytes] = await Promise.all([sizeOf(repo, file, old), sizeOf(repo, file, current)]);
    const byteCount = Math.max(oldBytes ?? 0, newBytes ?? 0);
    if (byteCount > LARGE_FILE_BYTES) return { kind: 'tooLarge', file, over: 'bytes', byteCount };
  }
  const [oldText, newText] = await Promise.all([textOf(repo, file, old), textOf(repo, file, current)]);
  const lineCount = Math.max(splitLines(oldText).length, splitLines(newText).length, (file.added ?? 0) + (file.removed ?? 0));
  if (lineCount > LARGE_FILE_LINES && !showLarge) return { kind: 'tooLarge', file, over: 'lines', lineCount };
  const diffText = old.kind === 'none' ? addedPatch(newText) : await listed.patch(change);
  const [oldVersion, newVersion] = await highlightPair(oldText, file.oldPath ?? file.path, newText, file.path, sharedRuns(diffText, splitLines(oldText).length));
  try { return { kind: 'text', file, rows: diffRows(diffText, oldVersion, newVersion) }; }
  catch (error) {
    if (current.kind !== 'disk') throw error;
    throw new GitError({ kind: 'unreadableFile', path: file.path, message: DIFF_MISFIT });
  }
}

/** `oldPath` is the old path of a renamed file, as its listing gave it; without it a renamed file reads as added. */
export function fileDiff(repo: Repository, source: Source, path: FilePath, showLarge: boolean, oldPath: FilePath | null = null): Promise<Result<FileDiff>> {
  return attempt(async () => {
    const listed = await listing(repo, source, oldPath ? [oldPath, path] : [path]);
    const change = listed.changes.find(candidate => candidate.file.path === path);
    if (!change) throw new GitError({ kind: 'unknownFile', path });
    return readFileDiff(repo, listed, change, showLarge, source.kind !== 'commit');
  }, repo);
}
