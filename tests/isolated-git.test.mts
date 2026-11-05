import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {isolatedGit, isolatedGitOut} from '../scripts/isolated-git.mts';
import {checkoutIdentity} from '../scripts/package.mts';
import {caseGit, scratchFolder} from './repo-sandbox.mts';

const root = path.resolve(import.meta.dirname, '..');
const {scratch} = scratchFolder('isolated-git');

function hostileHome(name: string, extraConfig = '') {
  const home = path.join(scratch, name), marker = path.join(home, 'touched');
  mkdirSync(path.join(home, 'hooks'), {recursive: true});
  mkdirSync(path.join(home, '.config/git'), {recursive: true});
  writeFileSync(path.join(home, 'sign'), `#!/bin/sh\necho sign >> '${marker}'\nexit 1\n`, {mode: 0o755});
  writeFileSync(path.join(home, 'hooks/pre-commit'), `#!/bin/sh\necho pre-commit >> '${marker}'\n`, {mode: 0o755});
  writeFileSync(path.join(home, '.config/git/ignore'), '*.private\n');
  writeFileSync(path.join(home, '.config/git/attributes'), '*.private binary\n');
  writeFileSync(path.join(home, '.gitconfig'), `[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = ${home}/sign\n[core]\n\thooksPath = ${home}/hooks\n[probe]\n\tfrom = home\n${extraConfig}`);
  return {home, marker, base: {PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config')}};
}

const plainGit = (args: string[], base: Record<string, string | undefined>) => spawnSync('git', args, {encoding: 'utf8', env: base});

/** Runs the named tests of one file under `home`, and fails unless each one ran and worked. */
function innerRun(home: string, file: string, names: string[]): void {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !['NODE_TEST_CONTEXT', 'XDG_CONFIG_HOME'].includes(name) && !name.startsWith('GIT_')));
  // NODE_TEST_CONTEXT would make the inner run report to this one instead of exiting with its own result.
  const inner = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--test', ...names.map(name => `--test-name-pattern=^${name}`), file], {cwd: root, encoding: 'utf8', env: {...env, HOME: home}});
  assert.equal(inner.status, 0, inner.stdout + inner.stderr);
  for (const name of names) assert.ok(inner.stdout.includes(`✔ ${name}`), `${name} ran and worked under this home:\n${inner.stdout}`);
}

test('isolated-git: control: this home folder does sign, run a hook, set config, and ignore and mark files for plain git', () => {
  const {marker, base} = hostileHome('control');
  const repository = path.join(scratch, 'control-repository');
  assert.equal(plainGit(['init', '-q', repository], base).status, 0);
  const commit = plainGit(['-C', repository, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'first'], base);
  assert.notEqual(commit.status, 0, 'the signing program fails the commit');
  assert.deepEqual(readFileSync(marker, 'utf8').trim().split('\n'), ['pre-commit', 'sign']);
  assert.equal(plainGit(['config', '--get', 'probe.from'], base).stdout.trim(), 'home');
  writeFileSync(path.join(repository, 'notes.private'), 'x\n');
  assert.equal(plainGit(['-C', repository, 'ls-files', '-o', '--exclude-standard'], base).stdout, '', 'the default ignore file hides it');
  assert.match(plainGit(['-C', repository, 'check-attr', 'diff', 'notes.private'], base).stdout, /diff: unset/, 'the default attributes file marks it binary');
});

test('isolated-git: the helper keeps out the home folder\'s config, default ignore and attributes files, and inherited GIT_ variables', () => {
  const {marker, base: home} = hostileHome('direct');
  const base = {...home, GIT_DIR: path.join(scratch, 'no-such-git-dir')};
  const repository = path.join(scratch, 'direct-repository');
  caseGit(['init', '-q', repository], {base});
  caseGit(['-C', repository, 'commit', '-q', '--allow-empty', '-m', 'first'], {base});
  assert.equal(existsSync(marker), false, 'the signing program and the hook did not run');
  const commit = isolatedGitOut(['-C', repository, 'cat-file', 'commit', 'HEAD'], {base});
  assert.doesNotMatch(commit, /gpgsig/, 'the commit is not signed');
  assert.match(commit, /^author Case <case@example\.invalid> /m);
  assert.equal(isolatedGit(['config', '--get', 'probe.from'], {base}).stdout, '', 'GIT_CONFIG_GLOBAL keeps the home folder\'s config out');
  writeFileSync(path.join(repository, 'notes.private'), 'x\n');
  assert.equal(isolatedGitOut(['-C', repository, 'ls-files', '-o', '--exclude-standard'], {base}).trim(), 'notes.private', 'the default ignore file stays out');
  assert.match(isolatedGitOut(['-C', repository, 'check-attr', 'diff', 'notes.private'], {base}), /diff: unspecified/, 'the default attributes file stays out');
  const failed = path.join(scratch, 'no-such-folder');
  assert.notEqual(isolatedGit(['-C', failed, 'status'], {base}).status, 0, 'isolatedGit reports a failure');
  assert.throws(() => isolatedGitOut(['-C', failed, 'status'], {base}), /cannot change to/, 'isolatedGitOut throws with git\'s message');
});

test('isolated-git: the helper reads the environment when it is called', () => {
  const folder = path.join(scratch, 'stand-in');
  mkdirSync(folder);
  writeFileSync(path.join(folder, 'git'), '#!/bin/sh\necho stand-in\n', {mode: 0o755});
  const saved = process.env.PATH;
  process.env.PATH = folder;
  try { assert.equal(isolatedGitOut(['--version']).trim(), 'stand-in'); }
  finally { process.env.PATH = saved; }
});

test('isolated-git: with git missing from PATH, the failure names the cause', () => {
  assert.throws(() => isolatedGitOut(['--version'], {base: {PATH: path.join(scratch, 'no-such-bin')}}), /ENOENT/);
});

test('isolated-git: a contributor whose git config signs commits and runs hooks gets a working launcher test, with no signing or hook run', () => {
  const {home, marker} = hostileHome('contributor');
  innerRun(home, 'tests/launcher.test.mts', ['launcher: its own git calls set every variable of GIT_ENVIRONMENT']);
  assert.equal(existsSync(marker), false);
});

test('isolated-git: a contributor\'s core.autocrlf and global ignore file leave the working-file tests alone', () => {
  const {home} = hostileHome('line-endings', `[core]\n\tautocrlf = input\n\texcludesFile = ${path.join(scratch, 'global-ignore')}\n`);
  writeFileSync(path.join(scratch, 'global-ignore'), '*.log\n');
  innerRun(home, 'tests/working-cases.test.mts', ['crlf: a CRLF working file', 'untracked-huge: an untracked text file']);
});

test('isolated-git: the build identity agrees with the person\'s git status about a file their global ignore file hides', () => {
  const {base} = hostileHome('identity', `[core]\n\texcludesFile = ${path.join(scratch, 'identity-ignore')}\n\thooksPath = /dev/null\n[commit]\n\tgpgsign = false\n`);
  writeFileSync(path.join(scratch, 'identity-ignore'), '*.orig\n');
  const repository = path.join(scratch, 'identity-repository');
  caseGit(['init', '-q', repository]);
  caseGit(['-C', repository, 'commit', '-q', '--allow-empty', '-m', 'first']);
  writeFileSync(path.join(repository, 'notes.orig'), 'x\n');
  assert.equal(plainGit(['-C', repository, 'status', '--porcelain'], base).stdout, '', 'the person\'s git status is clean');
  assert.equal(checkoutIdentity(repository, base).modified, false);
  writeFileSync(path.join(repository, 'notes.txt'), 'x\n');
  assert.equal(checkoutIdentity(repository, base).modified, true);
});

test('isolated-git: tests and scripts start git only through scripts/isolated-git.mts, apart from the named lines', () => {
  const sources = ['tests', 'scripts'].flatMap(folder => readdirSync(path.join(root, folder))
    .filter(name => name.endsWith('.mts') && name !== 'isolated-git.mts')
    .flatMap(name => readFileSync(path.join(root, folder, name), 'utf8').split('\n').map((line, index) => ({at: `${folder}/${name}:${index + 1}`, line}))));
  const named = (pattern: RegExp, allowed: RegExp[]) => sources.filter(({line}) => pattern.test(line) && !allowed.some(each => each.test(line))).map(({at}) => at);
  assert.deepEqual(named(/\b(?:spawn|spawnSync|execFile|execFileSync)\('git'/, [/^const plainGit = /, /const unpinned = /]), [], 'every other git call goes through the helper');
  assert.deepEqual(named(/\bpersonalGitOut\(/, [/const gitAsTheAppReads = /, /const git = \(args: string\[\]\) => personalGitOut\(/]), [], 'only the app\'s lists and the checkout\'s identity read the person\'s config');
});
