import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {readdirSync} from 'node:fs';
import path from 'node:path';
import {build} from './build.mts';

const root = path.resolve(import.meta.dirname, '..');
const bin = (name: string) => path.join(root, 'node_modules/.bin', name);
/** Two large real repositories the person running the check names, read-only: bars 1 and 2 on the history one, bar 3 on the file one. */
const REAL_REPOSITORIES = ['DIFF_VIEWER_HISTORY_REPO', 'DIFF_VIEWER_FILE_REPO'];
const withoutRealRepositories = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !REAL_REPOSITORIES.includes(name)));
const random = () => randomBytes(16).toString('hex');
/** A random value only this run's environment holds. scripts/verify's trace scan must not find it, and must find it under the planted fault env. */
const CANARY = {DIFF_VIEWER_CANARY: random()};
/**
 * The planted fault env copies its whole environment into the trace it keeps, so it runs with PATH, HOME, the canary, and
 * random stand-ins for the names the scan looks for, never the real tokens and sockets of the shell that started the check.
 */
const DECOY_ENV = {
  PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...CANARY,
  CLAUDE_CODE_MESSAGING_TOKEN: random(), CLAUDE_CODE_SESSION_ID: random(), SSH_AUTH_SOCK: `/private/tmp/${random()}`, TERM_SESSION_ID: random(),
};

function step(label: string, command: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
  console.log(`\n== ${label}`);
  const result = spawnSync(command, args, {cwd: root, stdio: 'inherit', env});
  if (result.status !== 0) throw new Error(`${label} failed with exit ${result.status ?? 'none'}.`);
}

/** Runs one feature with a planted fault, which must exit 1 and print every line in `expected`. */
function plantedFault(fault: string, env: NodeJS.ProcessEnv, what: string, expected: RegExp[], feature = 'commit-diff'): void {
  console.log(`\n== planted fault: DIFF_VIEWER_VERIFY_FAULT=${fault} scripts/verify fast --feature ${feature} must exit 1 with ${what}`);
  const result = spawnSync(path.join(root, 'scripts/verify'), ['fast', '--feature', feature], {cwd: root, encoding: 'utf8', env: {...env, DIFF_VIEWER_VERIFY_FAULT: fault}});
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  const named = expected.every(line => line.test(result.stdout));
  if (result.status !== 1 || !named) throw new Error(`planted fault ${fault}: expected exit 1 and ${what}, got exit ${result.status ?? 'none'}${named ? '' : ' without those lines'}.`);
  console.log(`planted fault ${fault}: exit 1 with ${what}, as expected`);
}

function main(level: string, fixturesOnly: boolean): void {
  console.log('== build (types for main, preload, and page)');
  build();
  step('types for scripts and tests', process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.scripts.json', '--pretty', 'false']);
  step('lint', bin('eslint'), ['--max-warnings', '0', '.']);
  const tests = readdirSync(path.join(root, 'tests')).filter(name => name.endsWith('.test.mts')).map(name => path.join('tests', name));
  // --test-force-exit ends a test file after a timeout even when the test left an app window open, so the time limit also ends this step.
  step('unit tests', process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--test', '--test-timeout=120000', '--test-force-exit', ...tests]);
  if (level === 'full') {
    step('unused code (knip)', bin('knip'), ['--no-progress']);
    step('duplicate code (jscpd)', bin('jscpd'), ['--config', '.jscpd.json', '--silent']);
    step('hand journey numbers (scripts/hand-journey --check)', path.join(root, 'scripts/hand-journey'), ['--check']);
    step(fixturesOnly ? 'verify full (fixtures only)' : 'verify full (fixtures and the two real repositories)', path.join(root, 'scripts/verify'), ['full'], {...(fixturesOnly ? withoutRealRepositories() : process.env), ...CANARY});
    plantedFault('rows', {...withoutRealRepositories(), ...CANARY}, 'a commit-diff failure on the swapped rows', [/^failed commit-diff: AssertionError.*change row shows old text on the left and new text on the right/m]);
    plantedFault('env', DECOY_ENV, 'the trace scan naming the canary and the four stand-ins in commit-diff.zip', [
      /^proven commit-diff$/m,
      ...['CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ID', 'DIFF_VIEWER_CANARY', 'SSH_AUTH_SOCK', 'TERM_SESSION_ID']
        .map(name => new RegExp(`^failed traces hold no shell environment: traces/commit-diff\\.zip holds .*\\b${name}\\b`, 'm')),
    ]);
    plantedFault('launcher-write', {...withoutRealRepositories(), ...CANARY}, 'a launcher-open failure on a changed fixture repository', [
      /^failed launcher-open: AssertionError.*fixture repository fingerprint stayed unchanged/m,
      /^failed repositories unchanged: changed:/m,
    ], 'launcher-open');
    plantedFault('launcher-git-write', {...withoutRealRepositories(), ...CANARY}, 'a launcher-open failure on changed linked-worktree Git metadata', [
      /^failed launcher-open: AssertionError.*fixture repository fingerprint stayed unchanged/m,
    ], 'launcher-open');
    plantedFault('ignored-read', {...withoutRealRepositories(), ...CANARY}, 'a read-only-repository failure naming the ignored file read', [
      /^failed read-only-repository: AssertionError.*ignored-probe\.txt was read from disk and listed/m,
    ], 'read-only-repository');
  }
}

const args = process.argv.slice(2);
const fixturesOnly = args[0] === 'full' && args[1] === '--fixtures-only';
if (args.includes('--help') || args.length !== (fixturesOnly ? 2 : 1) || !['fast', 'full'].includes(args[0])) {
  console.log([
    'scripts/check fast | full [--fixtures-only]',
    'fast: build, types, lint, unit tests.',
    'full: fast plus unused code (knip), duplicate code (jscpd), scripts/hand-journey --check (the practice repository gives the numbers the hand-journey steps promise),',
    'scripts/verify full, and five planted faults. The ignored-read fault must fail read-only-repository and name ignored-probe.txt.',
    'Each scripts/verify run gets DIFF_VIEWER_CANARY=<random>, a value the trace scan must not find unless the env fault is planted. The env fault runs with PATH, HOME, the canary, and random stand-ins for the secret names, so its trace holds none of the shell\'s real values.',
    `full measures bars 1 to 3 on the two real repositories named by ${REAL_REPOSITORIES.join(' and ')} (absolute paths, opened read-only), and exits 2 before any step when either is unset.`,
    'full --fixtures-only runs on the generated fixtures alone and ignores both variables.',
    'The last line is the exit code.',
  ].join('\n'));
  process.exit(args.includes('--help') ? 0 : 2);
}
const missing = args[0] === 'full' && !fixturesOnly ? REAL_REPOSITORIES.filter(name => !process.env[name]) : [];
if (missing.length) {
  console.error(`check full measures bars 1 to 3 on the largest real repositories, and ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set.\nSet both to absolute repository paths, for example:\n  DIFF_VIEWER_HISTORY_REPO=/path/to/history-repo DIFF_VIEWER_FILE_REPO=/path/to/file-repo ./scripts/check full\nor run on the fixtures alone with ./scripts/check full --fixtures-only`);
  console.log('check full exit 2');
  process.exit(2);
}
let code = 0;
try { main(args[0], fixturesOnly); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); code = 1; }
console.log(`check ${args[0]} exit ${code}`);
process.exit(code);
