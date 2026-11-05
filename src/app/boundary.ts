import { isAbsolute } from 'node:path';
import { FULL_HASH, VIEW_MESSAGE_LIMIT, VIEW_PROBLEMS } from '../domain/types.ts';
import type { CommitHash, FilePath, RepoPath, Source, ViewReport, WorkingKind } from '../domain/types.ts';

export const APP_ORIGIN = 'diff-viewer://app';
export const APP_URL = `${APP_ORIGIN}/index.html`;

/** A message from the page after main has checked every argument. */
export type Request =
  | { readonly method: 'openRepository' }
  | { readonly method: 'repository'; readonly list: WorkingKind | null }
  | { readonly method: 'commits'; readonly skip: number }
  | { readonly method: 'files'; readonly source: Source }
  | { readonly method: 'resolveCommit'; readonly text: string }
  | { readonly method: 'fileDiff'; readonly source: Source; readonly path: FilePath; readonly showLarge: boolean; readonly oldPath: FilePath | null }
  | { readonly method: 'recent' }
  | { readonly method: 'openRecent'; readonly path: RepoPath }
  | { readonly method: 'requestedView' }
  | { readonly method: 'viewReady'; readonly id: string; readonly report: ViewReport };

const MAX_SKIP = 10_000_000;
const MAX_PATH = 4096;
const MAX_PASTE = 256;

function refuse(reason: string): never {
  throw new Error(`Refused: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function parseSource(value: unknown): Source {
  if (!isRecord(value)) refuse('a source must be an object.');
  if (value.kind === 'staged' || value.kind === 'unstaged') {
    if (Object.keys(value).length !== 1) refuse(`a ${value.kind} source has only its kind.`);
    return { kind: value.kind };
  }
  if (value.kind !== 'commit') refuse('a source kind is commit, staged, or unstaged.');
  if (Object.keys(value).sort().join(',') !== 'hash,kind') refuse('a commit source has exactly kind and hash.');
  if (typeof value.hash !== 'string' || !FULL_HASH.test(value.hash)) refuse('a commit hash is 40 or 64 lowercase hex characters.');
  return { kind: 'commit', hash: value.hash as CommitHash };
}

function parseFilePath(value: unknown): FilePath {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH) refuse('a file path is a non-empty string up to 4096 characters.');
  if (value.includes('\0')) refuse('a file path cannot hold a NUL character.');
  if (value.split('/').some(part => part === '' || part === '.' || part === '..')) refuse('a file path is relative to the repository, with no empty, "." or ".." parts.');
  return value as FilePath;
}

function parseSkip(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_SKIP) refuse('skip is a whole number from 0 to 10,000,000.');
  return value;
}

function parseRepoPath(value: unknown): RepoPath {
  if (typeof value !== 'string' || value.length > MAX_PATH || !isAbsolute(value)) refuse('a repository path is an absolute path up to 4096 characters.');
  if (value.includes('\0')) refuse('a repository path cannot hold a NUL character.');
  return value as RepoPath;
}

/** Any pasted text up to 256 characters; git.ts decides whether it names a commit. */
function parsePaste(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_PASTE) refuse('a pasted hash is a string up to 256 characters.');
  return value.trim();
}

function parseList(value: unknown): WorkingKind | null {
  if (value !== null && value !== 'staged' && value !== 'unstaged') refuse('a listed tab is staged, unstaged, or null.');
  return value;
}

function parseBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') refuse('showLarge is true or false.');
  return value;
}

function parseId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) refuse('a request id is a UUID.');
  return value;
}

/** The page's report of a requested view: its first file, or the problem it shows, with the shown text. */
function parseViewReport(value: unknown): ViewReport {
  if (!isRecord(value)) refuse('a view report must be an object.');
  if (value.ok === true) {
    if (Object.keys(value).sort().join(',') !== 'firstFile,ok') refuse('a shown view report has exactly ok and firstFile.');
    return { ok: true, firstFile: value.firstFile === null ? null : parseFilePath(value.firstFile) };
  }
  if (value.ok !== false || Object.keys(value).sort().join(',') !== 'message,ok,problem') refuse('a failed view report has exactly ok, problem, and message.');
  const problem = VIEW_PROBLEMS.find(kind => kind === value.problem);
  if (!problem) refuse('a view problem is one of the app\'s error kinds.');
  if (typeof value.message !== 'string' || value.message.length > VIEW_MESSAGE_LIMIT) refuse('a view problem message is a string up to 4096 characters.');
  return { ok: false, problem, message: value.message };
}

export function parseRequest(method: unknown, args: unknown): Request {
  if (!Array.isArray(args)) refuse('arguments must be a list.');
  const arity = (count: number) => { if (args.length !== count) refuse(`${String(method)} takes ${count} arguments.`); };
  switch (method) {
    case 'openRepository': arity(0); return { method };
    case 'repository': arity(1); return { method, list: parseList(args[0]) };
    case 'commits': arity(1); return { method, skip: parseSkip(args[0]) };
    case 'resolveCommit': arity(1); return { method, text: parsePaste(args[0]) };
    case 'files': arity(1); return { method, source: parseSource(args[0]) };
    case 'fileDiff': arity(4); return { method, source: parseSource(args[0]), path: parseFilePath(args[1]), showLarge: parseBoolean(args[2]), oldPath: args[3] === null ? null : parseFilePath(args[3]) };
    case 'recent': arity(0); return { method };
    case 'openRecent': arity(1); return { method, path: parseRepoPath(args[0]) };
    case 'requestedView': arity(0); return { method };
    case 'viewReady': arity(2); return { method, id: parseId(args[0]), report: parseViewReport(args[1]) };
    default: return refuse('unknown method.');
  }
}

/** Only the app's own top frame, in a window main created, may call. */
export function trustedSender(ownWindow: boolean, url: string, topFrame: boolean): boolean {
  return ownWindow && topFrame && url === APP_URL;
}
