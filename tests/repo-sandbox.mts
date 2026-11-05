import {after} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import type {CommitHash, DiffRow, Line, Result} from '../src/domain/types.ts';

/** Git for building test repositories: no user settings, fixed author and time. The app's own git calls do not use it. */
export const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Case', GIT_AUTHOR_EMAIL: 'case@example.invalid', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'Case', GIT_COMMITTER_EMAIL: 'case@example.invalid', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

/** A scratch folder under /private/tmp, removed after the test file, and fresh repositories inside it. */
export function scratchFolder(label: string) {
  const scratch = mkdtempSync(`/private/tmp/diff-viewer-${label}-`);
  after(() => rmSync(scratch, {recursive: true, force: true}));
  function sandbox(name: string) {
    const folder = path.join(scratch, name);
    mkdirSync(folder);
    const git = (...args: string[]) => execFileSync('git', ['-C', folder, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {encoding: 'utf8', env}).trim();
    git('init', '--quiet', '-b', 'main');
    return {
      folder, git,
      write(file: string, content: string | Buffer) { mkdirSync(path.dirname(path.join(folder, file)), {recursive: true}); writeFileSync(path.join(folder, file), content); },
      commit(subject: string) { git('add', '--all'); git('commit', '--quiet', '--allow-empty', '-m', subject); return git('rev-parse', 'HEAD') as CommitHash; },
    };
  }
  return {scratch, sandbox};
}

/**
 * A partial clone of `source` (a test repository) next to it in `scratch`: only the newest commit's file data comes with
 * it, and older versions stay on the promisor remote. Returns the clone's folder.
 */
export function partialClone(scratch: string, source: string, name: string): string {
  const bare = path.join(scratch, `${name}.git`), clone = path.join(scratch, name);
  execFileSync('git', ['clone', '--quiet', '--bare', source, bare], {env});
  execFileSync('git', ['-C', bare, 'config', 'uploadpack.allowFilter', 'true'], {env});
  execFileSync('git', ['clone', '--quiet', '--filter=blob:none', `file://${bare}`, clone], {env});
  return clone;
}

/**
 * Moves the loose object of the commit HEAD names out of `repository`'s object store, as in a damaged repository: the
 * name HEAD still resolves to a hash, but git cannot read that commit. Returns the hash.
 */
export function withoutHeadObject(repository: string): string {
  const hash = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], {encoding: 'utf8', env}).trim();
  const objects = execFileSync('git', ['-C', repository, 'rev-parse', '--git-path', 'objects'], {encoding: 'utf8', env}).trim();
  renameSync(path.resolve(repository, objects, hash.slice(0, 2), hash.slice(2)), path.resolve(repository, objects, `moved-${hash}`));
  return hash;
}

export function value<T>(result: Result<T>): T {
  if (!result.ok) assert.fail(`expected a value, got ${JSON.stringify(result.error)}`);
  return result.value;
}

export const textOf = (line: Line | null) => line ? `${line.number}:${line.tokens.map(token => token.text).join('')}` : '-';
export const lines = (count: number, change: Record<number, string> = {}) => Array.from({length: count}, (_, index) => change[index + 1] ?? `line ${index + 1}`).join('\n') + '\n';

export function shape(rows: readonly DiffRow[]): string[] {
  return rows.map(row => row.kind === 'hidden' ? `hidden ${row.rows[0].left.number}-${row.rows[row.rows.length - 1].left.number}` : `${row.kind} ${textOf(row.left)}|${textOf(row.right)}`);
}

/**
 * Runs `work` with PATH set to one folder that holds only a logging `git`, which passes every call on to the real git.
 * Returns the argument lists the app's own git calls used, one string per call. With `git: false` the folder holds no git.
 * With `script`, the stand-in is that shell script instead, given the real git's path; it logs nothing.
 */
export async function withGitOnPath<T>(scratch: string, work: () => Promise<T>, {git = true, script}: {git?: boolean; script?: (real: string) => string} = {}): Promise<{result: T; calls: string[]}> {
  const real = (process.env.PATH ?? '').split(':').map(folder => path.join(folder, 'git')).find(file => existsSync(file));
  if (!real) assert.fail('git is not on PATH');
  const folder = mkdtempSync(path.join(scratch, 'path-'));
  const log = path.join(folder, 'calls.log');
  writeFileSync(log, '');
  if (git) writeFileSync(path.join(folder, 'git'), script?.(real) ?? `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`, {mode: 0o755});
  const saved = process.env.PATH;
  process.env.PATH = folder;
  try {
    const result = await work();
    return {result, calls: readFileSync(log, 'utf8').split('\n').filter(Boolean)};
  } finally { process.env.PATH = saved; }
}
