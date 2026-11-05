import {spawn} from 'node:child_process';
import {rmSync} from 'node:fs';
import path from 'node:path';
import {changedFiles, openRepository, repositoryInfo} from '../src/app/git.ts';
import type {Result} from '../src/domain/types.ts';
import {fingerprint} from './fingerprint.mts';
import {createPractice, NEWEST_SUBJECT} from './fixtures.mts';

const root = path.resolve(import.meta.dirname, '..');
const HAND = path.join(root, '.local/hand');
const PRACTICE = path.join(HAND, 'practice');
const DATA = path.join(HAND, 'data');

/** What the steps below promise about the practice repository. */
export const PROMISED = {commits: 12, newestFiles: 4, staged: 2, unstaged: 2, untracked: 1} as const;
type Numbers = Record<keyof typeof PROMISED, number>;

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`The practice repository could not be read: ${JSON.stringify(result.error)}`);
  return result.value;
}

/** The practice repository's numbers, read with the app's own git code. */
export async function practiceNumbers(folder: string): Promise<Numbers> {
  const repo = value(await openRepository(folder));
  const info = value(await repositoryInfo(repo));
  const newest = value(await changedFiles(repo, {kind: 'commit', hash: info.commits.commits[0].hash}));
  const staged = value(await changedFiles(repo, {kind: 'staged'}));
  const unstaged = value(await changedFiles(repo, {kind: 'unstaged'}));
  return {commits: info.commits.commits.length, newestFiles: newest.length, staged: staged.length, unstaged: unstaged.length, untracked: unstaged.filter(file => file.untracked).length};
}

const STEPS: readonly [string, string][] = [
  ['Click "Open repository…" and pick the practice folder printed above.', `The left pane shows the tabs "Staged", "Unstaged", and "Commits". The Commits tab lists ${PROMISED.commits} commits.`],
  [`Click the newest commit, "${NEWEST_SUBJECT}", then click app.ts in the file list.`,
    `The file list shows ${PROMISED.newestFiles} files, and the first one, added.ts, opens by itself. app.ts shows side by side, highlighted, with its changed words marked.`],
  ['In app.ts, click "Show 46 hidden lines".', 'The hidden unchanged lines appear.'],
  ['Click the "Staged" tab, then the "Unstaged" tab.', `Staged shows ${PROMISED.staged} files. Unstaged shows ${PROMISED.unstaged} files, ${PROMISED.untracked} marked "untracked" and new.`],
  [`Copy a commit hash: in Terminal, run git -C '${PRACTICE}' rev-parse HEAD~1 | pbcopy. In the app, click the "Commits" tab, click the box "Paste a commit hash, then press Return", press Command-V, then press Return.`,
    'The hash appears in the box. The commit "Start the change log" opens, and its file list shows CHANGELOG.md.'],
  ['Switch macOS to dark mode (System Settings, Appearance).', 'The app turns dark without a restart, and the highlighting stays readable.'],
  ['Open one of your own repositories from the recent menu or "Open repository…".', 'Its commits and diffs show the same way.'],
];

async function main(startApp: boolean): Promise<number> {
  console.log('== Step 1: build the practice repository and start the app');
  rmSync(PRACTICE, {recursive: true, force: true});
  createPractice(PRACTICE);
  console.log(`Practice repository: ${PRACTICE}`);
  const before = fingerprint(PRACTICE);
  const got = await practiceNumbers(PRACTICE);
  const labels: Record<keyof Numbers, string> = {commits: 'commits', newestFiles: 'files in the newest commit', staged: 'staged files', unstaged: 'unstaged files', untracked: 'untracked among them'};
  for (const key of Object.keys(PROMISED) as (keyof Numbers)[]) console.log(`  ${labels[key]}: ${got[key]} (want ${PROMISED[key]})`);
  console.log('\nBy hand, in the app window:');
  STEPS.forEach(([step, want], index) => console.log(`  Step ${index + 2}: ${step}\n    want: ${want}`));
  console.log('\nQuit the app with Command-Q when you are done.');
  let appCode = 0;
  if (startApp) {
    console.log(`\nStarting the app with its data in ${DATA} ...`);
    const child = spawn(path.join(root, 'scripts/start'), ['--data-dir', DATA], {cwd: root, stdio: 'inherit'});
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
    appCode = await new Promise<number>(done => child.on('exit', exit => done(exit ?? 1)));
    console.log(`\nThe app exited with code ${appCode} (want 0).`);
  }
  const unchanged = fingerprint(PRACTICE) === before;
  console.log(`Practice repository unchanged: ${unchanged ? 'yes' : 'no'} (want yes)`);
  const promised = (Object.keys(PROMISED) as (keyof Numbers)[]).every(key => got[key] === PROMISED[key]);
  return promised && unchanged && appCode === 0 ? 0 : 1;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.some(arg => arg !== '--check')) {
    console.log([
      'scripts/hand-journey [--check]',
      'A journey through the app by hand, on a practice repository.',
      `Builds the practice repository in ${path.relative(root, PRACTICE)}, prints its path and numbers, prints each step with what to look for,`,
      `and starts the app with its data in ${path.relative(root, DATA)}. It never uses the default user-data folder.`,
      '--check builds and prints everything without starting the app.',
      'Exit 0 when the numbers match the steps, the app exits 0, and the practice repository is unchanged from before the numbers were read to after the app quits.',
    ].join('\n'));
    process.exit(args.includes('--help') ? 0 : 2);
  }
  main(!args.includes('--check')).then(code => process.exit(code), error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
}
