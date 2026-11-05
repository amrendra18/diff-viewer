import {spawnSync} from 'node:child_process';
import type {SpawnSyncReturns} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {GIT_SETTINGS} from '../src/app/git-settings.ts';

type Variables = Readonly<Record<string, string | undefined>>;
export type IsolatedGitOptions = {
  /** The variables to start from, in place of this process's. Inherited GIT_ variables are always dropped. */
  base?: Variables;
  env?: Readonly<Record<string, string>>;
  input?: string | Buffer;
};

const NO_DEFAULT_IGNORE_OR_ATTRIBUTES = ['-c', 'core.excludesFile=/dev/null', '-c', 'core.attributesFile=/dev/null'];

const withoutGitVariables = (base: Variables) => Object.fromEntries(Object.entries(base).filter((entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('GIT_')));

function checkedOutput(result: SpawnSyncReturns<string>, args: readonly string[]): string {
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} exited ${result.status ?? 'none'}: ${result.stderr.trim()}`);
  return result.stdout;
}

/**
 * Git for tests and scripts. The person's git config, default ignore and attributes files, signing key, and hooks stay
 * out, so a run neither signs with their key nor fails on their settings. Reports git's exit status and never throws for it.
 */
export function isolatedGit(args: readonly string[], {base = process.env, env = {}, input}: IsolatedGitOptions = {}): SpawnSyncReturns<string> {
  return spawnSync('git', [...NO_DEFAULT_IGNORE_OR_ATTRIBUTES, ...args], {encoding: 'utf8', maxBuffer: 1 << 28, input, env: {...withoutGitVariables(base), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...env}});
}

/** `isolatedGit` for a call that must work: returns its output, and throws with the cause when it fails. */
export function isolatedGitOut(args: readonly string[], options: IsolatedGitOptions = {}): string {
  return checkedOutput(isolatedGit(args, options), args);
}

/**
 * A read that must agree with the person's own git status and with the app: their config stays in, because it holds
 * their global ignore file. The app's settings are pinned, and no optional locks are taken.
 */
export function personalGitOut(args: readonly string[], {base = process.env}: {base?: Variables} = {}): string {
  const settings = GIT_SETTINGS.flatMap(setting => ['-c', setting]);
  return checkedOutput(spawnSync('git', [...settings, ...args], {encoding: 'utf8', maxBuffer: 1 << 28, env: {...withoutGitVariables(base), GIT_OPTIONAL_LOCKS: '0'}}), args);
}

/** The real git on PATH, for a stand-in git that runs it. */
export function realGit(): string {
  const real = (process.env.PATH ?? '').split(':').map(folder => path.join(folder, 'git')).find(file => existsSync(file));
  if (!real) throw new Error('git is not on PATH');
  return real;
}
