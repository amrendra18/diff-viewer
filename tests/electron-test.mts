import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {_electron} from 'playwright';
import type {ElectronApplication, Page} from 'playwright';
import {createFixtures} from '../scripts/fixtures.mts';
import {realGit} from '../scripts/isolated-git.mts';

/** Shared setup for the unit tests that start the Electron app. */
export const root = path.resolve(import.meta.dirname, '..');

/** The process environment without ELECTRON_RUN_AS_NODE, which would start Electron as plain Node. */
export function appEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'));
}

export async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return check();
}

/** The app's environment with a stand-in `git` (from `script`, as in withStandInGit) written to `folder`/bin and first on PATH. */
export function standInEnv(folder: string, script: (real: string, folder: string) => string): Record<string, string> {
  const bin = path.join(folder, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'git'), script(realGit(), folder), {mode: 0o755});
  const env = appEnv();
  return {...env, PATH: `${bin}:${env.PATH ?? ''}`};
}

/**
 * A stand-in git script that fails each `git log` whose arguments hold `marker`, as a damaged repository would; other
 * commands run the real git. An empty marker fails every `git log`.
 */
export const failingLogIn = (marker: string) => (real: string) =>
  `#!/bin/sh\ncase "$*" in *'${marker}'*) for arg in "$@"; do [ "$arg" = log ] && { echo 'fatal: planted log failure' >&2; exit 128; }; done;; esac\nexec '${real}' "$@"\n`;
/** A stand-in git script that fails every `git log`. */
export const failingLog = failingLogIn('');

type StandIn = {folder: string; practice: string; app: ElectronApplication; page: Page};

/**
 * Starts the app on a fresh practice fixture with a stand-in `git` first on PATH. `script` gets the real git and the
 * scratch folder and returns the stand-in's shell script. The folder is removed afterwards.
 */
export async function withStandInGit(prefix: string, script: (real: string, folder: string) => string, body: (setup: StandIn) => Promise<void>): Promise<void> {
  const folder = mkdtempSync(`/private/tmp/diff-viewer-${prefix}-`);
  const {practice} = createFixtures(path.join(folder, 'repos'));
  mkdirSync(path.join(folder, 'data'));
  const app = await _electron.launch({args: [root, '--open', practice, '--data-dir', path.join(folder, 'data')], cwd: root, env: standInEnv(folder, script), timeout: 30000});
  try {
    await body({folder, practice, app, page: await app.firstWindow()});
  } finally {
    await app.close();
    rmSync(folder, {recursive: true, force: true, maxRetries: 5});
  }
}
