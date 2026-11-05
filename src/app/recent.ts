import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { RECENT_LIMIT } from '../domain/types.ts';
import type { RepoPath } from '../domain/types.ts';

/** The list with `path` moved to the front, without repeats, at most RECENT_LIMIT long. */
function withRecent(list: readonly RepoPath[], path: RepoPath): RepoPath[] {
  return [path, ...list.filter(entry => entry !== path)].slice(0, RECENT_LIMIT);
}

/** The stored list, newest first. A missing or damaged file reads as an empty list; entries that are not absolute paths are dropped. */
export function readRecent(file: string): RepoPath[] {
  let stored: unknown;
  try { stored = JSON.parse(readFileSync(file, 'utf8')); }
  catch { return []; }
  if (!Array.isArray(stored)) return [];
  const paths = stored.filter((entry): entry is RepoPath => typeof entry === 'string' && isAbsolute(entry) && !entry.includes('\0'));
  return [...new Set(paths)].slice(0, RECENT_LIMIT);
}

/** Replaces the stored list in one rename, so a crash never leaves half a list. */
function writeRecent(file: string, list: readonly RepoPath[]): void {
  const partial = `${file}.${process.pid}.partial`;
  // Without --data-dir the file lives in Electron's default user-data folder, which may not exist yet.
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(partial, JSON.stringify(list, null, 2) + '\n', { mode: 0o600 });
  renameSync(partial, file);
}

/** Puts `path` first in the stored list and returns the new list. */
export function rememberRecent(file: string, path: RepoPath): RepoPath[] {
  const list = withRecent(readRecent(file), path);
  writeRecent(file, list);
  return list;
}

/** Drops `path`, a repository that is no longer there, from the stored list and returns the new list. */
export function forgetRecent(file: string, path: RepoPath): RepoPath[] {
  const stored = readRecent(file);
  const list = stored.filter(entry => entry !== path);
  if (list.length !== stored.length) writeRecent(file, list);
  return list;
}
