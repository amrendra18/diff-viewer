import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {env as gitEnv, withoutHeadObject} from './repo-sandbox.mts';

const root = path.resolve(import.meta.dirname, '..');
const command = path.join(root, 'bin/diff-viewer');

/** A fresh scratch folder under /private/tmp, so the tests need no .local folder in the checkout. */
const scratch = (label: string) => mkdtempSync(`/private/tmp/diff-viewer-${label}`);

/** A repository in `parent` with one commit, made with fixed test settings. */
function committedRepository(parent: string, name: string): string {
  const repository = path.join(parent, name);
  for (const args of [['init', '-q', repository], ['-C', repository, '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'first']]) {
    assert.equal(spawnSync('git', args, {env: gitEnv}).status, 0, `git ${args.join(' ')}`);
  }
  return repository;
}

function copiedLauncher(temp: string): string {
  const fakeCommand = path.join(temp, 'bin/diff-viewer');
  mkdirSync(path.dirname(fakeCommand), {recursive: true});
  copyFileSync(command, fakeCommand);
  mkdirSync(path.join(temp, 'src/domain'), {recursive: true});
  copyFileSync(path.join(root, 'src/domain/source-argument.mjs'), path.join(temp, 'src/domain/source-argument.mjs'));
  chmodSync(fakeCommand, 0o755);
  copyFileSync(path.join(root, 'package.json'), path.join(temp, 'package.json'));
  return fakeCommand;
}

/** An error object carries exactly one non-empty next step. */
function assertOneNextStep(error: {next: unknown}, args: string[]): void {
  assert(Array.isArray(error.next) && error.next.length === 1 && typeof error.next[0] === 'string' && error.next[0].length > 0, `${args.join(' ')}: next holds one step, got ${JSON.stringify(error.next)}`);
}

test('launch-flags: help, version, bad sources, and unknown commits leave state empty', () => {
  const state = scratch('launcher-test-');
  const repositories = scratch('launcher-test-repositories-');
  try {
    const run = (...args: string[]) => spawnSync(command, args, {cwd: root, encoding: 'utf8', env: {...process.env, DIFF_VIEWER_STATE_DIR: state}});
    for (const args of [['--help'], ['open', '--help']]) {
      const result = run(...args);
      assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
      assert.match(result.stdout, /^Usage: diff-viewer open PATH /m, `${args.join(' ')} prints the usage line`);
    }
    const version = run('--version');
    assert.equal(version.status, 0, version.stderr);
    assert.match(version.stdout, /^diff-viewer \d+\.\d+\.\d+ \((?:unknown|[0-9a-f]{40}|[0-9a-f]{64})(?:, modified)?\)\n$/);
    for (const args of [['no-such-verb', '--format', 'json'], ['open', '--no-such-flag', '--format', 'json'], ['open', '--no-such-flag', '--help', '--format', 'json'], ['open', '--format', 'json'], ['--format', 'json']]) {
      const result = run(...args);
      assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
      const error = JSON.parse(result.stdout).error;
      assert.deepEqual(Object.keys(error).sort(), ['code', 'message', 'next']);
      assertOneNextStep(error, args);
    }
    const textError = run('no-such-verb');
    assert.equal(textError.status, 2);
    assert.match(textError.stderr, /^next: run diff-viewer --help$/m, 'the text fix line names the command, not the checkout path');
    assert.doesNotMatch(textError.stderr, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the text fix line hides the checkout path');
    assert.match(run().stderr, /^Missing verb\. /, 'no arguments names the missing verb');
    for (const args of [['open', '.', '--source', 'broken', '--format', 'json'], ['open', '.', '--source', '--format', 'json'], ['open', '.', '--source', 'commit:', '--format', 'json']]) {
      const result = run(...args);
      assert.equal(result.status, 2, `${args.join(' ')}: ${result.stdout} ${result.stderr}`);
      assert.equal(JSON.parse(result.stdout).error.code, 'bad-source');
    }
    const notRepository = run('open', path.join(state, 'not-a-repository'), '--format', 'json');
    assert.equal(notRepository.status, 1);
    assert.equal(JSON.parse(notRepository.stdout).error.code, 'not-a-repository');
    assertOneNextStep(JSON.parse(notRepository.stdout).error, ['open', 'not-a-repository']);
    const unknown = run('open', committedRepository(repositories, 'repository'), '--source', 'commit:does-not-exist', '--format', 'json');
    assert.equal(unknown.status, 1);
    assert.equal(JSON.parse(unknown.stdout).error.code, 'unknown-commit');
    assert.deepEqual(readdirSync(state), []);
  } finally {
    rmSync(state, {recursive: true, force: true});
    rmSync(repositories, {recursive: true, force: true});
  }
});

test('launcher-version: packaged identity stays fixed and reads no app state', () => {
  const temp = scratch('launcher-version-');
  try {
    const fakeCommand = copiedLauncher(temp);
    const resources = path.join(temp, '.local/build/diff-viewer.app/Contents/Resources');
    const marker = path.join(temp, 'started');
    const state = path.join(temp, 'state');
    mkdirSync(resources, {recursive: true});
    const app = path.join(temp, '.local/build/diff-viewer.app/Contents/MacOS/diff-viewer');
    mkdirSync(path.dirname(app), {recursive: true});
    writeFileSync(app, `#!/bin/sh\necho started > "${marker}"\n`, {mode: 0o755});
    const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version as string;
    // A fixed revision: the test reads no checkout's git, so it also runs from a copy with no .git.
    const revision = '0123456789abcdef0123456789abcdef01234567';
    const identity = {version, revision, modified: false};
    writeFileSync(path.join(resources, 'build-identity.json'), JSON.stringify(identity));
    writeFileSync(path.join(temp, 'package.json'), JSON.stringify({version: '9.9.9'}));
    const run = (...args: string[]) => spawnSync(fakeCommand, args, {encoding: 'utf8', env: {...process.env, DIFF_VIEWER_STATE_DIR: state}});
    for (const args of [['--version', '--format', 'json'], ['--help'], ['open', '--help']]) {
      const result = run(...args);
      assert.equal(result.status, 0, result.stderr);
      if (args[0] === '--version') {
        assert.equal(result.stdout.trim().split('\n').length, 1);
        assert.deepEqual(JSON.parse(result.stdout), identity);
      }
    }
    assert.equal(existsSync(state), false, 'help and version did not read or create app state');
    assert.equal(existsSync(marker), false, 'help and version started no app');
    rmSync(path.join(resources, 'build-identity.json'));
    const withoutBundle = run('--version', '--format', 'json');
    assert.equal(withoutBundle.status, 0);
    assert.deepEqual(JSON.parse(withoutBundle.stdout), {version: '9.9.9', revision: 'unknown', modified: null});
    writeFileSync(path.join(resources, 'build-identity.json'), '{broken');
    const damaged = run('--version', '--format', 'json');
    assert.equal(damaged.status, 1);
    assert.equal(damaged.stdout.trim().split('\n').length, 1);
    assert.equal(JSON.parse(damaged.stdout).error.code, 'damaged-build');
    for (const invalid of [
      {version, revision: [revision], modified: false},
      {version: '', revision, modified: false},
    ]) {
      writeFileSync(path.join(resources, 'build-identity.json'), JSON.stringify(invalid));
      const result = run('--version', '--format', 'json');
      assert.equal(result.status, 1, `accepted damaged identity ${JSON.stringify(invalid)}`);
      assert.equal(JSON.parse(result.stdout).error.code, 'damaged-build');
    }
    assert.equal(existsSync(state), false);
    assert.equal(existsSync(marker), false);
  } finally { rmSync(temp, {recursive: true, force: true}); }
});

test('launcher: a state path that is a file returns one JSON error before starting an app', () => {
  const temp = scratch('launcher-state-');
  try {
    const fakeCommand = copiedLauncher(temp);
    const fakeApp = path.join(temp, '.local/build/diff-viewer.app/Contents/MacOS/diff-viewer');
    const repository = path.join(temp, 'repository');
    const stateFile = path.join(temp, 'state-file');
    const marker = path.join(temp, 'started');
    mkdirSync(path.dirname(fakeApp), {recursive: true});
    mkdirSync(repository);
    writeFileSync(fakeApp, `#!/bin/sh\necho started > "${marker}"\n`, {mode: 0o755});
    writeFileSync(stateFile, 'a file');
    assert.equal(spawnSync('git', ['init', '-q', repository]).status, 0);
    const result = spawnSync(fakeCommand, ['open', repository, '--format', 'json'], {
      encoding: 'utf8', env: {...process.env, DIFF_VIEWER_STATE_DIR: stateFile},
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout.trim().split('\n').length, 1);
    assert.equal(JSON.parse(result.stdout).error.code, 'state-unavailable');
    assert.equal(existsSync(marker), false, 'the app did not start');
  } finally { rmSync(temp, {recursive: true, force: true}); }
});

test('launcher: a bare repository reaches the app bundle check', () => {
  const temp = scratch('launcher-bare-');
  try {
    const fakeCommand = copiedLauncher(temp);
    const bare = path.join(temp, 'bare.git');
    assert.equal(spawnSync('git', ['init', '--bare', '-q', bare]).status, 0);
    const result = spawnSync(fakeCommand, ['open', bare, '--format', 'json'], {encoding: 'utf8', env: {...process.env, DIFF_VIEWER_STATE_DIR: path.join(temp, 'state')}});
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error.code, 'missing-app');
  } finally { rmSync(temp, {recursive: true, force: true}); }
});

test('launcher: the command called through a link, as installed in ~/.local/bin, finds its own checkout', () => {
  const temp = realpathSync(scratch('launcher-link-'));
  try {
    const checkout = path.join(temp, 'checkout');
    const fakeCommand = copiedLauncher(checkout);
    const link = path.join(temp, 'home/.local/bin/diff-viewer');
    mkdirSync(path.dirname(link), {recursive: true});
    symlinkSync(fakeCommand, link);
    const run = (...args: string[]) => spawnSync(link, args, {encoding: 'utf8', env: {...process.env, DIFF_VIEWER_STATE_DIR: path.join(temp, 'state')}});
    const version = run('--version', '--format', 'json');
    assert.equal(version.status, 0, `--version through the link: ${version.stderr}`);
    assert.equal(JSON.parse(version.stdout).version, JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version, 'the version comes from the checkout\'s package.json');
    const bare = path.join(temp, 'bare.git');
    assert.equal(spawnSync('git', ['init', '--bare', '-q', bare]).status, 0);
    const opened = run('open', bare, '--format', 'json');
    assert.equal(opened.status, 1, opened.stderr);
    assert.deepEqual(JSON.parse(opened.stdout).error, {code: 'missing-app', message: `App bundle is missing at ${path.join(checkout, '.local/build/diff-viewer.app/Contents/MacOS/diff-viewer')}.`, next: [`run scripts/package in ${checkout}`]},
      'the command looks for the app bundle in the checkout, not beside the link');
  } finally { rmSync(temp, {recursive: true, force: true}); }
});

test('launcher: a folder inside a bare repository opens and reports the bare repository, as the app names it', () => {
  const temp = scratch('launcher-bare-inside-');
  try {
    const fakeCommand = copiedLauncher(temp);
    const fakeApp = path.join(temp, '.local/build/diff-viewer.app/Contents/MacOS/diff-viewer');
    const bare = path.join(temp, 'bare.git');
    const opened = path.join(temp, 'opened');
    mkdirSync(path.dirname(fakeApp), {recursive: true});
    assert.equal(spawnSync('git', ['init', '--bare', '-q', bare]).status, 0);
    writeFileSync(fakeApp, `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--open" ]; then shift; printf '%s' "$1" > "${opened}"; fi
  if [ "$1" = "--ready-file" ]; then shift; ready="$1"; fi
  shift
done
printf '%s\\n' '{"ready":true,"title":"bare.git · diff-viewer","visible":true,"app":"running","pid":${process.pid}}' > "$ready"
`, {mode: 0o755});
    const result = spawnSync(fakeCommand, ['open', path.join(bare, 'refs'), '--format', 'json'], {
      encoding: 'utf8', timeout: 5000, env: {...process.env, DIFF_VIEWER_STATE_DIR: path.join(temp, 'state')},
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).repository, bare, 'the result names the bare repository, not the folder inside it');
    assert.equal(readFileSync(opened, 'utf8'), bare, 'the app is asked for the path it will itself report');
  } finally { rmSync(temp, {recursive: true, force: true}); }
});

test('launcher: inherited Git settings and a trailing space keep the requested repository', () => {
  const temp = scratch('launcher-git-path-');
  try {
    const fakeCommand = copiedLauncher(temp);
    const normal = path.join(temp, 'normal');
    const spaced = path.join(temp, 'space ');
    for (const repository of [normal, spaced]) assert.equal(spawnSync('git', ['init', '-q', repository]).status, 0);
    const run = (repository: string, extra: Record<string, string> = {}) => spawnSync(fakeCommand, ['open', repository, '--format', 'json'], {
      encoding: 'utf8', env: {...process.env, DIFF_VIEWER_STATE_DIR: path.join(temp, 'state'), ...extra},
    });
    const poisoned = run(normal, {GIT_DIR: path.join(temp, 'missing-git-dir'), GIT_WORK_TREE: spaced});
    assert.equal(poisoned.status, 1);
    assert.equal(JSON.parse(poisoned.stdout).error.code, 'missing-app', 'the requested repository reached the bundle check despite inherited Git settings');
    const trailingSpace = run(spaced);
    assert.equal(trailingSpace.status, 1);
    assert.equal(JSON.parse(trailingSpace.stdout).error.code, 'missing-app', 'the path ending in a space reached the bundle check');
  } finally { rmSync(temp, {recursive: true, force: true}); }
});

test('launcher: an app that exits early or never becomes ready returns one error and leaves no owned process', () => {
  const temp = scratch('launcher-failure-');
  const fakeCommand = copiedLauncher(temp);
  const fakeApp = path.join(temp, '.local/build/diff-viewer.app/Contents/MacOS/diff-viewer');
  const repository = path.join(temp, 'repository');
  const state = path.join(temp, 'state');
  try {
    mkdirSync(path.dirname(fakeApp), {recursive: true});
    mkdirSync(repository);
    mkdirSync(state);
    const git = spawnSync('git', ['init', '-q', repository]);
    assert.equal(git.status, 0);
    const run = () => spawnSync(fakeCommand, ['open', repository, '--format', 'json'], {
      encoding: 'utf8', timeout: 25000, env: {...process.env, DIFF_VIEWER_STATE_DIR: state},
    });
    writeFileSync(fakeApp, '#!/bin/sh\nexit 7\n', {mode: 0o755});
    const early = run();
    assert.equal(early.status, 1);
    assert.equal(JSON.parse(early.stdout).error.code, 'app-not-ready');
    assert.equal(early.stdout.trim().split('\n').length, 1);
    writeFileSync(fakeApp, '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.DIFF_VIEWER_STATE_DIR + "/owned-pid", String(process.pid)); setInterval(() => {}, 1000);\n', {mode: 0o755});
    const started = Date.now();
    const stalled = run();
    assert.equal(stalled.status, 1);
    assert.equal(JSON.parse(stalled.stdout).error.code, 'app-not-ready');
    assert.equal(stalled.stdout.trim().split('\n').length, 1);
    assert(Date.now() - started < 25000, 'the launcher returned within 25 seconds');
    const pid = Number(readFileSync(path.join(state, 'owned-pid'), 'utf8'));
    assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the child that never became ready stopped');
    assert.equal(existsSync(path.join(state, 'owned-pid')), true);
  } finally { rmSync(temp, {recursive: true, force: true}); }
});

test('launcher: a secondary app may exit before the primary reports the focused window', () => {
  const temp = scratch('launcher-running-');
  try {
    const fakeCommand = copiedLauncher(temp);
    const fakeApp = path.join(temp, '.local/build/diff-viewer.app/Contents/MacOS/diff-viewer');
    const repository = path.join(temp, 'repository');
    mkdirSync(path.dirname(fakeApp), {recursive: true});
    mkdirSync(repository);
    assert.equal(spawnSync('git', ['init', '-q', repository]).status, 0);
    writeFileSync(fakeApp, `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--ready-file" ]; then shift; ready="$1"; fi
  shift
done
(sleep 0.2; printf '%s\\n' '{"ready":true,"title":"repository · diff-viewer","visible":true,"app":"running","pid":${process.pid}}' > "$ready") &
exit 0
`, {mode: 0o755});
    const result = spawnSync(fakeCommand, ['open', repository, '--format', 'json'], {
      encoding: 'utf8', timeout: 5000, env: {...process.env, DIFF_VIEWER_STATE_DIR: path.join(temp, 'state')},
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {repository, app: 'running', pid: process.pid, title: 'repository · diff-viewer', visible: true});
    assert.equal(result.stdout.trim().split('\n').length, 1);
  } finally { rmSync(temp, {recursive: true, force: true}); }
});

test('launcher: a ready file with ready false returns the app\'s error code and message at once', () => {
  const temp = scratch('launcher-ready-false-');
  try {
    const fakeCommand = copiedLauncher(temp);
    const fakeApp = path.join(temp, '.local/build/diff-viewer.app/Contents/MacOS/diff-viewer');
    const repository = path.join(temp, 'repository');
    const signal = path.join(temp, 'signal.json');
    mkdirSync(path.dirname(fakeApp), {recursive: true});
    assert.equal(spawnSync('git', ['init', '-q', repository]).status, 0);
    writeFileSync(fakeApp, `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--ready-file" ]; then shift; ready="$1"; fi
  shift
done
cp "${signal}" "$ready"
`, {mode: 0o755});
    const run = (...extra: string[]) => spawnSync(fakeCommand, ['open', repository, ...extra], {
      encoding: 'utf8', timeout: 15000, env: {...process.env, DIFF_VIEWER_STATE_DIR: path.join(temp, 'state')},
    });
    const message = 'git could not read the repository: fatal: bad config line 9';
    writeFileSync(signal, JSON.stringify({ready: false, error: {code: 'git-failed', message}}));
    const started = Date.now();
    const result = run('--format', 'json');
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert(Date.now() - started < 10000, 'the launcher did not wait for its 20 s limit');
    assert.equal(result.stdout.trim().split('\n').length, 1);
    const error = JSON.parse(result.stdout).error;
    assert.deepEqual([error.code, error.message], ['git-failed', message], 'the app\'s code and message reach the caller');
    assertOneNextStep(error, ['open', 'ready false']);
    const text = run();
    assert.equal(text.status, 1);
    assert.match(text.stderr, /^git could not read the repository: fatal: bad config line 9$/m, 'text mode prints the app\'s message');
    writeFileSync(signal, JSON.stringify({ready: false, error: {code: 'no-such-code', message: 'odd'}}));
    const unknown = run('--format', 'json');
    assert.equal(unknown.status, 1);
    assert.equal(JSON.parse(unknown.stdout).error.code, 'app-not-ready', 'a code the launcher does not know stays app-not-ready');
  } finally { rmSync(temp, {recursive: true, force: true}); }
});

test('launcher: bad calls start no app, and a planted process-start fault is detected', () => {
  const temp = scratch('launcher-process-');
  const fakeCommand = copiedLauncher(temp);
  const fakeApp = path.join(temp, '.local/build/diff-viewer.app/Contents/MacOS/diff-viewer');
  const marker = path.join(temp, 'started');
  try {
    mkdirSync(path.dirname(fakeApp), {recursive: true});
    writeFileSync(fakeApp, `#!/bin/sh\necho $$ > "${marker}"\n`, {mode: 0o755});
    const run = (...args: string[]) => spawnSync(fakeCommand, args, {encoding: 'utf8', env: {...process.env, DIFF_VIEWER_STATE_DIR: path.join(temp, 'state')}});
    assert.equal(run('--help').status, 0);
    assert.equal(run('no-such-verb', '--format', 'json').status, 2);
    assert.equal(run('open', '--no-such-flag', '--format', 'json').status, 2);
    const noProcessStarted = () => assert.equal(existsSync(marker), false, 'bad calls did not start the app');
    noProcessStarted();
    // The fake launcher waits for the real child process to write the marker before it returns.
    writeFileSync(fakeCommand, `#!/bin/sh\n"${fakeApp}"\necho help\n`, {mode: 0o755});
    assert.equal(run('--help').status, 0);
    assert.throws(noProcessStarted, /bad calls did not start the app/, 'the planted process start is detected');
    assert(Number.isSafeInteger(Number(readFileSync(marker, 'utf8'))), 'the planted app recorded its process ID');
  } finally {
    rmSync(temp, {recursive: true, force: true});
  }
});

test('launcher-help: the help verb and JSON help for open list outputs and every error code', () => {
  const temp = scratch('launcher-help-');
  try {
    const fakeCommand = copiedLauncher(temp);
    const state = path.join(temp, 'state');
    const run = (...args: string[]) => spawnSync(fakeCommand, args, {encoding: 'utf8', env: {...process.env, DIFF_VIEWER_STATE_DIR: state}});
    const text = run('help');
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /^Usage: diff-viewer open PATH /m);
    assert.match(text.stdout, /^Outputs: repository, app \(started\|running\), pid, title, visible, and source and firstFile when --source is given\./m);
    assert.match(text.stdout, /\{error: \{code, message, next\}\}/);
    assert.match(text.stdout, /The app keeps running after open returns\. It stops on Command-Q or when its last window closes\./, 'help says how the app stops');
    assert.doesNotMatch(text.stdout, /quit its window/);
    assert.match(text.stdout, /^Version: --version names the app built in \.local\/build\. An app that is already running keeps its own build until Command-Q\.$/m, 'help says which app --version names');
    assert.match(text.stdout, /PATH may be relative, such as \./, 'help says a relative path works');
    const codes = ['bad-call', 'unknown-verb', 'unknown-flag', 'bad-format', 'bad-source', 'git-missing', 'git-failed', 'not-a-repository', 'unknown-commit', 'unavailable-source', 'missing-app', 'bad-state-dir', 'state-unavailable', 'app-not-ready', 'damaged-build'];
    const launcher = readFileSync(command, 'utf8');
    const used = [...launcher.matchAll(/fail\('([a-z-]+)'/g)].map(match => match[1]);
    assert.deepEqual([...new Set(used)].sort(), [...codes].sort(), 'the expected list names every code the launcher can print');
    for (const code of codes) assert.match(text.stdout, new RegExp(`\\b${code}\\b`), `help names ${code}`);
    const markdown = run('help', '--format', 'markdown');
    assert.equal(markdown.status, 0);
    assert.equal(markdown.stdout, '# diff-viewer\n\n' + text.stdout);
    for (const args of [['help', '--format', 'json'], ['open', '--help', '--format', 'json'], ['--help', '--format', 'json']]) {
      const result = run(...args);
      assert.equal(result.status, 0, `${args.join(' ')}: ${result.stdout} ${result.stderr}`);
      assert.equal(result.stdout.trim().split('\n').length, 1);
      assert.deepEqual(JSON.parse(result.stdout), {verbs: ['help', 'open'], help: text.stdout.replace(/\n$/, '')});
    }
    const helpHelp = run('help', '--help');
    assert.equal(helpHelp.status, 0);
    assert.match(helpHelp.stdout, /^Usage: diff-viewer help /m);
    const bogus = run('help', '--bogus', '--format', 'json');
    assert.equal(bogus.status, 2);
    assert.equal(JSON.parse(bogus.stdout).error.code, 'unknown-flag');
    assertOneNextStep(JSON.parse(bogus.stdout).error, ['help', '--bogus']);
    assert.equal(existsSync(state), false, 'help created no app state');
  } finally { rmSync(temp, {recursive: true, force: true}); }
});

test('launcher: only git\'s "not a git repository" answer gives not-a-repository; other git failures name git\'s line', () => {
  const temp = scratch('launcher-git-failed-');
  const plain = mkdtempSync('/private/tmp/diff-viewer-plain-folder-');
  try {
    const fakeCommand = copiedLauncher(temp);
    const repository = path.join(temp, 'repository');
    assert.equal(spawnSync('git', ['init', '-q', repository]).status, 0);
    writeFileSync(path.join(repository, '.git/config'), '\n[broken\n', {flag: 'a'});
    const run = (target: string) => spawnSync(fakeCommand, ['open', target, '--format', 'json'], {
      encoding: 'utf8', env: {...process.env, DIFF_VIEWER_STATE_DIR: path.join(temp, 'state')},
    });
    const broken = run(repository);
    assert.equal(broken.status, 1, broken.stdout + broken.stderr);
    assert.equal(broken.stdout.trim().split('\n').length, 1);
    const error = JSON.parse(broken.stdout).error;
    assert.equal(error.code, 'git-failed', 'a broken .git/config is a git failure, not a missing repository');
    assert.match(error.message, /bad config line/, 'the message carries git\'s own line');
    assertOneNextStep(error, ['open', 'broken config']);
    const text = spawnSync(fakeCommand, ['open', repository], {encoding: 'utf8', env: {...process.env, DIFF_VIEWER_STATE_DIR: path.join(temp, 'state')}});
    assert.equal(text.status, 1);
    assert.match(text.stderr, /bad config line/, 'text mode prints git\'s line too');
    for (const target of [plain, path.join(plain, 'missing')]) {
      const result = run(target);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.equal(JSON.parse(result.stdout).error.code, 'not-a-repository', `${target} keeps not-a-repository`);
    }
    // A relative argument such as `.` is named by its resolved absolute path, so the caller sees which folder was checked.
    const relative = (cwd: string) => spawnSync(fakeCommand, ['open', '.', '--format', 'json'], {
      cwd, encoding: 'utf8', env: {...process.env, DIFF_VIEWER_STATE_DIR: path.join(temp, 'state')},
    });
    assert.equal(JSON.parse(relative(plain).stdout).error.message, `No Git repository at ${plain}.`);
    assert.match(JSON.parse(relative(repository).stdout).error.message, new RegExp(`^git could not read ${repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `));
    assert.equal(existsSync(path.join(temp, 'state')), false, 'no app state was written');
  } finally {
    rmSync(temp, {recursive: true, force: true});
    rmSync(plain, {recursive: true, force: true});
  }
});

test('launcher: --source commit:REV is unknown-commit only for a name git cannot resolve; an unreadable commit is git-failed with git\'s line', () => {
  const temp = scratch('launcher-unreadable-');
  try {
    const fakeCommand = copiedLauncher(temp);
    const repository = committedRepository(temp, 'repository');
    const run = (revision: string) => spawnSync(fakeCommand, ['open', repository, '--source', `commit:${revision}`, '--format', 'json'], {
      encoding: 'utf8', env: {...process.env, DIFF_VIEWER_STATE_DIR: path.join(temp, 'state')},
    });
    for (const revision of ['does-not-exist', 'HEAD^{tree}', '0123456789abcdef0123456789abcdef01234567']) {
      const unknown = run(revision);
      assert.equal(unknown.status, 1, unknown.stdout + unknown.stderr);
      assert.equal(JSON.parse(unknown.stdout).error.code, 'unknown-commit', `${revision} stays unknown-commit`);
    }
    const hash = withoutHeadObject(repository);
    const unreadable = run('HEAD');
    assert.equal(unreadable.status, 1, unreadable.stdout + unreadable.stderr);
    assert.equal(unreadable.stdout.trim().split('\n').length, 1);
    const error = JSON.parse(unreadable.stdout).error;
    assert.equal(error.code, 'git-failed', `an unreadable HEAD commit is a git failure: ${unreadable.stdout}`);
    assert.match(error.message, new RegExp(`^git could not read commit HEAD \\(${hash}\\) in .*: fatal: `), 'the message names the commit and carries git\'s own line');
    assertOneNextStep(error, ['open', 'unreadable HEAD']);
    assert.equal(existsSync(path.join(temp, 'state')), false, 'no app state was written');
  } finally { rmSync(temp, {recursive: true, force: true}); }
});

test('launcher: git missing from PATH is its own error, not "not a repository"', () => {
  const temp = scratch('launcher-no-git-');
  try {
    const fakeCommand = copiedLauncher(temp);
    const repository = path.join(temp, 'repository');
    assert.equal(spawnSync('git', ['init', '-q', repository]).status, 0);
    const nodeOnly = path.join(temp, 'node-only');
    mkdirSync(nodeOnly);
    symlinkSync(process.execPath, path.join(nodeOnly, 'node'));
    const result = spawnSync(fakeCommand, ['open', repository, '--format', 'json'], {
      encoding: 'utf8', env: {...process.env, PATH: nodeOnly, DIFF_VIEWER_STATE_DIR: path.join(temp, 'state')},
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.stdout.trim().split('\n').length, 1);
    const error = JSON.parse(result.stdout).error;
    assert.equal(error.code, 'git-missing');
    assert.match(error.next[0], /git/i);
    assertOneNextStep(error, ['open', 'without git']);
  } finally { rmSync(temp, {recursive: true, force: true}); }
});

test('launcher: its own git calls set GIT_NO_LAZY_FETCH=1 and GIT_ALLOW_PROTOCOL=none, as the app does', () => {
  const temp = scratch('launcher-no-fetch-');
  try {
    const fakeCommand = copiedLauncher(temp);
    const repository = path.join(temp, 'repository');
    assert.equal(spawnSync('git', ['init', '-q', repository]).status, 0);
    assert.equal(spawnSync('git', ['-C', repository, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'first']).status, 0);
    const real = (process.env.PATH ?? '').split(':').map(each => path.join(each, 'git')).find(file => existsSync(file));
    if (!real) assert.fail('git is not on PATH');
    // A git that records the two variables of each call, then runs the real git.
    const bin = path.join(temp, 'fake-bin'), calls = path.join(temp, 'calls');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "\${GIT_NO_LAZY_FETCH-unset} \${GIT_ALLOW_PROTOCOL-unset}" >> '${calls}'\nexec '${real}' "$@"\n`, {mode: 0o755});
    const result = spawnSync(fakeCommand, ['open', repository, '--source', 'commit:HEAD', '--format', 'json'], {
      encoding: 'utf8', env: {...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, DIFF_VIEWER_STATE_DIR: path.join(temp, 'state')},
    });
    assert.equal(JSON.parse(result.stdout).error.code, 'missing-app', 'the call reached the bundle check after all its git calls');
    const lines = readFileSync(calls, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3, 'two rev-parse calls for the repository and one for the commit');
    assert.deepEqual([...new Set(lines)], ['1 none'], `each git call sets both variables (got ${JSON.stringify(lines)})`);
  } finally { rmSync(temp, {recursive: true, force: true}); }
});

test('launcher-codes: each call error gives its code and exit, starts no app, and a bad state folder is named before a missing app', () => {
  const temp = scratch('launcher-codes-');
  try {
    const fakeCommand = copiedLauncher(temp);
    const fakeApp = path.join(temp, '.local/build/diff-viewer.app/Contents/MacOS/diff-viewer');
    const marker = path.join(temp, 'started');
    const repository = committedRepository(temp, 'repository');
    const bare = path.join(temp, 'bare.git');
    assert.equal(spawnSync('git', ['init', '--bare', '-q', bare]).status, 0);
    const run = (args: string[], state = path.join(temp, 'state')) => spawnSync(fakeCommand, [...args, '--format', 'json'], {encoding: 'utf8', env: {...process.env, DIFF_VIEWER_STATE_DIR: state}});
    const expectCode = (args: string[], code: string, status: number, state?: string) => {
      const result = run(args, state);
      assert.equal(result.stdout.trim().split('\n').length, 1, `${args.join(' ')}: one line`);
      const error = JSON.parse(result.stdout).error;
      assert.deepEqual([error.code, result.status], [code, status], `${args.join(' ')}: ${result.stdout}`);
      assertOneNextStep(error, args);
    };
    // No app bundle yet: the state folder is still checked first.
    expectCode(['open', repository], 'bad-state-dir', 2, 'relative/state');
    mkdirSync(path.dirname(fakeApp), {recursive: true});
    writeFileSync(fakeApp, `#!/bin/sh\necho started > "${marker}"\n`, {mode: 0o755});
    const table: [string[], string, number][] = [
      [['open'], 'bad-call', 2],
      [['open', repository, repository], 'bad-call', 2],
      [['--version', '--bogus'], 'bad-call', 2],
      [['frobnicate'], 'unknown-verb', 2],
      [['open', bare, '--source', 'staged'], 'unavailable-source', 1],
      [['open', bare, '--source', 'unstaged'], 'unavailable-source', 1],
    ];
    for (const [args, code, status] of table) expectCode(args, code, status);
    // bad-format is a text-mode answer: a call whose first --format is not json gets no JSON.
    const badFormat = spawnSync(fakeCommand, ['open', repository, '--format', 'yaml'], {encoding: 'utf8', env: {...process.env, DIFF_VIEWER_STATE_DIR: path.join(temp, 'state')}});
    assert.deepEqual([badFormat.status, badFormat.stdout, badFormat.stderr], [2, '', 'Valid flags: --format json.\nnext: run diff-viewer --help\n'], 'bad-format');
    expectCode(['open', repository], 'bad-state-dir', 2, 'relative/state');
    assert.equal(existsSync(marker), false, 'no call error started the app');
    assert.equal(existsSync(path.join(temp, 'state')), false, 'no call error created the state folder');
  } finally { rmSync(temp, {recursive: true, force: true}); }
});
