import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {_electron} from 'playwright';
import type {ElectronApplication} from 'playwright';
import {createFixtures} from '../scripts/fixtures.mts';
import {VIEW_CHANNEL} from '../src/domain/types.ts';
import {appEnv, failingLog, failingLogIn, root, standInEnv, waitFor} from './electron-test.mts';
import {scratchFolder, withoutHeadObject} from './repo-sandbox.mts';

const electronBinary = createRequire(import.meta.url)('electron') as string;


type HandOffApp = {folder: string; practice: string; history: string; data: string; app: ElectronApplication; handOff: (repository: string, source?: string) => {readyFile: string; exited: Promise<unknown>}};

/**
 * Starts the app on the practice fixture with its own data folder; handOff starts a second app there, which hands its
 * request to the running app and exits. `git`, when given, is a stand-in git script as in withStandInGit.
 */
async function withHandOffApp(body: (setup: HandOffApp) => Promise<void>, git?: (real: string, folder: string) => string): Promise<void> {
  const folder = mkdtempSync('/private/tmp/diff-viewer-hand-off-');
  const {practice, history} = createFixtures(path.join(folder, 'repos'));
  const data = path.join(folder, 'data');
  mkdirSync(data);
  const env = git ? standInEnv(folder, git) : appEnv();
  const handOff = (repository: string, source?: string) => {
    const readyFile = path.join(data, `ready-${randomUUID()}.json`);
    const child = spawn(electronBinary, [root, '--open', realpathSync(repository), '--data-dir', data, '--ready-file', readyFile, ...(source ? ['--source', source] : [])], {cwd: root, env, stdio: 'ignore'});
    const exited = new Promise(resolve => child.once('exit', resolve));
    return {readyFile, exited};
  };
  const app = await _electron.launch({args: [root, '--open', practice, '--data-dir', data], cwd: root, env, timeout: 30000});
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('.commit');
    await body({folder, practice, history, data, app, handOff});
  } finally {
    await app.close();
    rmSync(folder, {recursive: true, force: true});
  }
}

/**
 * Breaks the practice window in one of two ways: 'close-on-view' drops the next view request and closes the window,
 * as if the person closed it while the view loaded; 'no-title' never reports a repository title, as when its page shows a failure screen.
 */
function breakPracticeWindow(app: ElectronApplication, mode: 'close-on-view' | 'no-title'): Promise<void> {
  // app.evaluate runs this function inside the app, so it gets the channel name as an argument instead of the import.
  return app.evaluate(({BrowserWindow}, {how, viewChannel}) => {
    const window = BrowserWindow.getAllWindows().find(each => each.getTitle().startsWith('practice'));
    if (!window) throw new Error('no practice window');
    const contents = window.webContents;
    if (how === 'close-on-view') {
      const send = contents.send.bind(contents);
      contents.send = (channel: string, ...args: unknown[]) => {
        if (channel === viewChannel) { setImmediate(() => window.destroy()); return; }
        send(channel, ...args);
      };
      return;
    }
    window.getTitle = () => 'diff-viewer';
    const on = contents.on.bind(contents);
    contents.on = ((name: string, listener: (...args: unknown[]) => void) => name === 'page-title-updated' ? contents : on(name as 'did-finish-load', listener)) as typeof contents.on;
  }, {how: mode, viewChannel: VIEW_CHANNEL});
}

const {sandbox} = scratchFolder('hand-off-filter');

/** A repository whose unstaged list git cannot produce: a tracked file needs a required clean filter whose program is missing. */
function filterRepository(name: string): string {
  const box = sandbox(name);
  box.write('.gitattributes', '*.bin filter=lfs\n');
  box.write('data.bin', 'version 1\n');
  box.commit('Start');
  box.git('config', 'filter.lfs.required', 'true');
  box.git('config', 'filter.lfs.clean', '/nonexistent/git-lfs clean %f');
  box.write('data.bin', 'version 2\n');
  return realpathSync(box.folder);
}

const answer = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as {ready: boolean; error?: {code: string; message: string}};

/** A later open of another repository still gets a ready answer, so the queue was not blocked. */
async function laterOpenWorks(handOff: HandOffApp['handOff'], repository: string): Promise<void> {
  const later = handOff(repository);
  assert.equal(await waitFor(() => existsSync(later.readyFile), 15000), true, 'a later open still gets its answer');
  assert.equal(answer(later.readyFile).ready, true);
  await later.exited;
}

test('hand-off: a window closed before its requested view appears does not block later opens', () => withHandOffApp(async ({practice, history, app, handOff}) => {
  const first = handOff(history);
  assert.equal(await waitFor(() => existsSync(first.readyFile), 15000), true, 'a second repository opens through a hand-off');
  await first.exited;
  await breakPracticeWindow(app, 'close-on-view');
  const dropped = handOff(practice, 'unstaged');
  await dropped.exited;
  assert.equal(await waitFor(() => app.windows().length === 1, 15000), true, 'the practice window closed');
  assert.equal(await waitFor(() => existsSync(dropped.readyFile), 15000), true, 'the dropped request gets an answer');
  const droppedAnswer = answer(dropped.readyFile);
  assert.deepEqual([droppedAnswer.ready, droppedAnswer.error?.code], [false, 'app-not-ready'], `the answer names the failure: ${JSON.stringify(droppedAnswer)}`);
  await laterOpenWorks(handOff, history);
}));

test('hand-off: a plain open of a minimized repository window restores it and answers at once', () => withHandOffApp(async ({practice, app, handOff}) => {
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().find(each => each.getTitle().startsWith('practice'))?.minimize());
  assert.equal(await waitFor(() => false, 500), false);
  const started = Date.now();
  const again = handOff(practice);
  assert.equal(await waitFor(() => existsSync(again.readyFile), 15000), true, 'the minimized window answers');
  const elapsed = Date.now() - started;
  assert.equal(answer(again.readyFile).ready, true, `the answer is ready: ${JSON.stringify(answer(again.readyFile))}`);
  assert.ok(elapsed < 5000, `the answer came in ${elapsed} ms, without waiting for the 15-second limit`);
  const restored = await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().find(each => each.getTitle().startsWith('practice'))?.isMinimized());
  assert.equal(restored, false, 'the window is no longer minimized');
  await again.exited;
}));

test('hand-off: a failed open and a window that never shows its repository answer with a reason, and later opens still work', () => withHandOffApp(async ({folder, practice, history, app, handOff}) => {
  const plain = path.join(folder, 'plain');
  mkdirSync(plain);
  const notRepository = handOff(plain);
  assert.equal(await waitFor(() => existsSync(notRepository.readyFile), 10000), true, 'a folder that is not a repository gets an answer');
  assert.deepEqual(answer(notRepository.readyFile).error?.code, 'not-a-repository');
  assert.equal(answer(notRepository.readyFile).ready, false);
  await notRepository.exited;
  await breakPracticeWindow(app, 'no-title');
  const stuck = handOff(practice);
  const started = Date.now();
  assert.equal(await waitFor(() => existsSync(stuck.readyFile), 20000), true, 'a window that never shows its repository still gets an answer before the command stops waiting');
  const stuckAnswer = answer(stuck.readyFile);
  assert.deepEqual([stuckAnswer.ready, stuckAnswer.error?.code], [false, 'app-not-ready'], `the answer names the failure: ${JSON.stringify(stuckAnswer)}`);
  assert.ok(Date.now() - started < 20000, 'the answer came before the command\'s 20-second wait ends');
  await stuck.exited;
  await laterOpenWorks(handOff, history);
}));

test('hand-off: a requested view git cannot list answers git-failed at once, and the running app keeps working', () => withHandOffApp(async ({history, app, handOff}) => {
  const started = Date.now();
  const failed = handOff(filterRepository('running'), 'unstaged');
  assert.equal(await waitFor(() => existsSync(failed.readyFile), 15000), true, 'the failed view gets an answer');
  const elapsed = Date.now() - started;
  const failedAnswer = answer(failed.readyFile);
  assert.deepEqual([failedAnswer.ready, failedAnswer.error?.code], [false, 'git-failed'], `the answer names git's failure: ${JSON.stringify(failedAnswer)}`);
  assert.match(failedAnswer.error?.message ?? '', /lfs/, 'the message is git\'s own');
  assert.ok(elapsed < 5000, `the answer came in ${elapsed} ms, without waiting for the 15-second limit`);
  await failed.exited;
  assert.equal(app.windows().length, 2, 'the window that shows the failed view stays open beside the practice window');
  await laterOpenWorks(handOff, history);
}));

type FirstApp = {readyFile: string; child: ChildProcess; exited: Promise<number | null>; started: number};

const STILL_RUNNING = 'still running after 20 s';
const exitWithinLimit = <T,>(exit: Promise<T>) => Promise.race([exit, new Promise<typeof STILL_RUNNING>(resolve => setTimeout(() => resolve(STILL_RUNNING), 20000))]);

/**
 * Starts a first app, as the installed command does, on the repository that `prepare` returns for a fresh scratch folder.
 * It answers through its ready file. The app is stopped and the folder removed afterwards.
 */
async function withFirstApp(prepare: (folder: string) => {repository: string; env?: Record<string, string>; source?: string}, body: (first: FirstApp) => Promise<void>): Promise<void> {
  const folder = mkdtempSync('/private/tmp/diff-viewer-hand-off-');
  try {
    const data = path.join(folder, 'data');
    mkdirSync(data);
    const readyFile = path.join(data, `ready-${randomUUID()}.json`);
    const {repository, env = appEnv(), source} = prepare(folder);
    const started = Date.now();
    const child = spawn(electronBinary, [root, '--open', realpathSync(repository), '--data-dir', data, '--ready-file', readyFile, ...(source ? ['--source', source] : [])], {cwd: root, env, stdio: 'ignore'});
    const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
    try {
      assert.equal(await waitFor(() => existsSync(readyFile), 20000), true, 'the first app answers before the command stops waiting');
      await body({readyFile, child, exited, started});
    } finally {
      if (child.exitCode === null) child.kill();
      // An app that is still exiting writes to its data folder, so the folder goes only after the exit.
      if (await exitWithinLimit(exited) === STILL_RUNNING) {
        child.kill('SIGKILL');
        await exitWithinLimit(exited);
      }
    }
  } finally {
    rmSync(folder, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  }
}

test('hand-off: a first app whose requested view git cannot list answers git-failed at once and keeps running', () => withFirstApp(
  () => ({repository: filterRepository('first'), source: 'unstaged'}),
  async ({readyFile, child, started}) => {
    const elapsed = Date.now() - started;
    const first = answer(readyFile);
    assert.deepEqual([first.ready, first.error?.code], [false, 'git-failed'], `the answer names git's failure: ${JSON.stringify(first)}`);
    assert.ok(elapsed < 10000, `the answer came in ${elapsed} ms, including the app start, without waiting for the 15-second limit`);
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.equal(child.exitCode, null, 'the app keeps running, because its window shows the repository');
  }));

test('hand-off: a first app given a folder that is not a repository writes not-a-repository to its ready file and exits', () => withFirstApp(
  folder => {
    const plain = path.join(folder, 'plain');
    mkdirSync(plain);
    return {repository: plain};
  },
  async ({readyFile, exited, started}) => {
    const first = answer(readyFile);
    assert.deepEqual([first.ready, first.error?.code], [false, 'not-a-repository'], `the answer names the failure: ${JSON.stringify(first)}`);
    assert.ok(Date.now() - started < 10000, 'the answer came without waiting for the 15-second limit');
    assert.equal(await exitWithinLimit(exited), 1, 'the first app exits after it answers');
  }));

/** Git's message from the stand-in git that fails `git log`. */
const PLANTED = /^fatal: planted log failure$/;

function assertPlantedFailureAtOnce(readyFile: string, started: number): void {
  const elapsed = Date.now() - started;
  const first = answer(readyFile);
  assert.deepEqual([first.ready, first.error?.code], [false, 'git-failed'], `the answer names git's failure: ${JSON.stringify(first)}`);
  assert.match(first.error?.message ?? '', PLANTED, 'the message is git\'s own fatal line');
  assert.ok(elapsed < 10000, `the answer came in ${elapsed} ms, including the app start, without waiting for the 15-second limit`);
}

test('hand-off: a first app whose commits git cannot read answers git-failed with git\'s message at once and exits', () => withFirstApp(
  // Every `git log` fails, so the repository opens but the page shows a failure card and the title never names it.
  folder => ({repository: createFixtures(path.join(folder, 'repos')).practice, env: standInEnv(folder, failingLog)}),
  async ({readyFile, exited, started}) => {
    assertPlantedFailureAtOnce(readyFile, started);
    // The command reads the answer and returns; it does not wait for the exit. Electron's exit waits for its GPU process,
    // which can take about 15 s to start while the screen is locked, so the exit gets 20 s.
    const code = await exitWithinLimit(exited);
    assert.equal(code, 1, 'the first app exits, because no window shows a repository');
  }));

test('hand-off: a git failure with a long message answers git-failed with git\'s fatal line at once', () => withFirstApp(
  folder => ({
    repository: createFixtures(path.join(folder, 'repos')).practice,
    env: standInEnv(folder, real => `#!/bin/sh\nfor arg in "$@"; do [ "$arg" = log ] && { i=0; while [ $i -lt 200 ]; do echo 'warning: ignoring broken ref refs/heads/some-long-branch-name' >&2; i=$((i+1)); done; echo 'fatal: planted log failure' >&2; exit 128; }; done\nexec '${real}' "$@"\n`),
  }),
  async ({readyFile, started}) => {
    assertPlantedFailureAtOnce(readyFile, started);
  }));

test('hand-off: a second start with no one waiting says the app is already running, instead of ending in silence', () => withHandOffApp(async ({practice, data}) => {
  const second = spawn(electronBinary, [root, '--open', realpathSync(practice), '--data-dir', data], {cwd: root, env: appEnv(), stdio: ['ignore', 'ignore', 'pipe']});
  let stderr = '';
  second.stderr.on('data', chunk => { stderr += String(chunk); });
  const code = await exitWithinLimit(new Promise(resolve => second.once('close', resolve)));
  if (code === STILL_RUNNING) second.kill('SIGKILL');
  assert.equal(code, 0, 'the second start exits with code 0');
  assert.match(stderr, /already running/, 'stderr names the reason');
}));

test('hand-off: a first app asked for commit:HEAD whose commit git cannot read answers git-failed with git\'s line at once', () => withFirstApp(
  folder => {
    const {practice} = createFixtures(path.join(folder, 'repos'));
    withoutHeadObject(practice);
    return {repository: practice, source: 'commit:HEAD'};
  },
  async ({readyFile, exited, started}) => {
    const first = answer(readyFile);
    assert.deepEqual([first.ready, first.error?.code], [false, 'git-failed'], `an unreadable commit is a git failure: ${JSON.stringify(first)}`);
    assert.match(first.error?.message ?? '', /^git could not read commit HEAD \([0-9a-f]{40}\) in .*: fatal: /, 'the message names the commit and carries git\'s own line');
    assert.ok(Date.now() - started < 10000, 'the answer came without waiting for the 15-second limit');
    assert.equal(await exitWithinLimit(exited), 1, 'the first app exits, because no window shows a repository');
  }));

test('hand-off: a first app whose window never shows its repository answers app-not-ready at its 15 s limit and exits', () => withFirstApp(
  // Every `git log` hangs, so the page never loads the commits and the window title never names the repository.
  folder => ({repository: createFixtures(path.join(folder, 'repos')).practice, env: standInEnv(folder, real => `#!/bin/sh\nfor arg in "$@"; do [ "$arg" = log ] && exec sleep 40; done\nexec '${real}' "$@"\n`)}),
  async ({readyFile, exited, started}) => {
    const elapsed = Date.now() - started;
    const first = answer(readyFile);
    assert.deepEqual([first.ready, first.error?.code], [false, 'app-not-ready'], `the answer names the time-out: ${JSON.stringify(first)}`);
    assert.ok(elapsed >= 14000 && elapsed < 20000, `the answer came in ${elapsed} ms: at the 15 s limit, before the command's 20 s wait ends`);
    const code = await exitWithinLimit(exited);
    assert.equal(code, 1, 'the first app exits, because no window shows a repository');
  }));

/** Part of the path of a repository whose `git log` fails in the running app; other repositories load as usual. */
const LOG_FAILS = 'log-fails';

test('hand-off: a running app answers git-failed at once for a repository whose commits git cannot read, also when its window is already open', () => withHandOffApp(async ({history, app, handOff}) => {
  const box = sandbox(LOG_FAILS);
  box.write('a.txt', 'one\n');
  box.commit('Start');
  for (const which of ['new window', 'open window']) {
    const started = Date.now();
    const failed = handOff(box.folder);
    assert.equal(await waitFor(() => existsSync(failed.readyFile), 20000), true, `${which}: the open gets an answer`);
    const elapsed = Date.now() - started;
    const failedAnswer = answer(failed.readyFile);
    assert.deepEqual([failedAnswer.ready, failedAnswer.error?.code], [false, 'git-failed'], `${which}: the answer names git's failure: ${JSON.stringify(failedAnswer)}`);
    assert.match(failedAnswer.error?.message ?? '', PLANTED, `${which}: the message is git's own fatal line`);
    assert.ok(elapsed < 5000, `${which}: the answer came in ${elapsed} ms, without waiting for the 15-second limit`);
    await failed.exited;
  }
  assert.equal(app.windows().length, 2, 'the window with the failure card stays open beside the practice window');
  await laterOpenWorks(handOff, history);
}, failingLogIn(LOG_FAILS)));

test('hand-off: a recent list that cannot be saved, or an answer that cannot be written, does not stop later opens', () => withHandOffApp(async ({data, practice, history, app, handOff}) => {
  // A folder where the recent list's file belongs makes each save of the list fail.
  rmSync(path.join(data, 'recent.json'));
  mkdirSync(path.join(data, 'recent.json'));
  const unsaved = handOff(history);
  assert.equal(await waitFor(() => existsSync(unsaved.readyFile), 15000), true, 'the open gets an answer');
  assert.equal(answer(unsaved.readyFile).ready, true, `the open works without saving the recent list: ${JSON.stringify(answer(unsaved.readyFile))}`);
  await unsaved.exited;
  // The practice window never reports its title, so this open fails at the 15-second limit; a folder where its answer's
  // temporary file belongs makes the answer fail to write too.
  await breakPracticeWindow(app, 'no-title');
  const unwritten = handOff(practice);
  mkdirSync(`${unwritten.readyFile}.tmp`);
  await unwritten.exited;
  await new Promise(resolve => setTimeout(resolve, 1000));
  const queued = handOff(history);
  assert.equal(await waitFor(() => existsSync(queued.readyFile), 25000), true, 'an open queued behind the unwritable answer still gets its answer');
  assert.equal(answer(queued.readyFile).ready, true);
  await queued.exited;
  assert.equal(existsSync(unwritten.readyFile), false, 'control: the unwritable answer was never written');
}));

/** Part of the path of a repository whose first git call in the running app takes 17 s, longer than an open's 15 s limit. */
const SLOW_OPEN = 'slow-open';

test('hand-off: an open queued behind a slow one answers by its own 15 s limit, and no window opens late', () => withHandOffApp(async ({history, app, handOff}) => {
  const box = sandbox(SLOW_OPEN);
  box.write('a.txt', 'one\n');
  box.commit('Start');
  const slow = handOff(box.folder);
  await waitFor(() => false, 1000);
  const queued = handOff(history);
  assert.equal(await waitFor(() => existsSync(queued.readyFile), 20000), true, 'the queued open gets an answer while its command still waits');
  const queuedAnswer = answer(queued.readyFile);
  assert.deepEqual([queuedAnswer.ready, queuedAnswer.error?.code], [false, 'app-not-ready'], `the queued open's time ran out behind the slow one: ${JSON.stringify(queuedAnswer)}`);
  assert.equal(await waitFor(() => existsSync(slow.readyFile), 5000), true, 'the slow open gets an answer');
  assert.deepEqual(answer(slow.readyFile).error?.code, 'app-not-ready', 'the slow open passed its own limit');
  await Promise.all([slow.exited, queued.exited]);
  assert.equal(app.windows().length, 1, 'no window opened for an open whose time ran out');
  await laterOpenWorks(handOff, history);
}, (real, folder) => `#!/bin/sh\ncase "$*" in *'${SLOW_OPEN}'*) [ -e '${folder}/slept' ] || { touch '${folder}/slept'; sleep 17; };; esac\nexec '${real}' "$@"\n`));
