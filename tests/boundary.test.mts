import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {_electron} from 'playwright';
import {parseRequest, trustedSender, APP_URL} from '../src/app/boundary.ts';
import {createFixtures} from '../scripts/fixtures.mts';
import type {DiffViewerApi, RepoPath} from '../src/domain/types.ts';
import {appEnv, root} from './electron-test.mts';

declare global {
  interface Window { diffViewer: DiffViewerApi }
  var withinLimit: <T>(probe: string, work: Promise<T>) => Promise<T>;
}

const hash = 'a'.repeat(40);
const PROBE_LIMIT_MS = 10_000;

test('boundary: well-formed requests pass and come back as typed values', () => {
  assert.deepEqual(parseRequest('openRepository', []), {method: 'openRepository'});
  assert.deepEqual(parseRequest('repository', [null]), {method: 'repository', list: null});
  assert.deepEqual(parseRequest('repository', ['unstaged']), {method: 'repository', list: 'unstaged'}, 'a refresh names the open tab, whose files come with the counts');
  assert.deepEqual(parseRequest('resolveCommit', [' 3a76F694 ']), {method: 'resolveCommit', text: '3a76F694'});
  assert.deepEqual(parseRequest('recent', []), {method: 'recent'});
  assert.deepEqual(parseRequest('openRecent', ['/private/tmp/repo']), {method: 'openRecent', path: '/private/tmp/repo'});
  assert.deepEqual(parseRequest('commits', [200]), {method: 'commits', skip: 200});
  assert.deepEqual(parseRequest('files', [{kind: 'commit', hash}]), {method: 'files', source: {kind: 'commit', hash}});
  assert.deepEqual(parseRequest('files', [{kind: 'staged'}]), {method: 'files', source: {kind: 'staged'}});
  assert.deepEqual(parseRequest('files', [{kind: 'commit', hash: 'b'.repeat(64)}]), {method: 'files', source: {kind: 'commit', hash: 'b'.repeat(64)}}, 'a SHA-256 commit');
  assert.deepEqual(parseRequest('fileDiff', [{kind: 'unstaged'}, 'notes/todo.txt', false, null]), {method: 'fileDiff', source: {kind: 'unstaged'}, path: 'notes/todo.txt', showLarge: false, oldPath: null});
  assert.deepEqual(parseRequest('fileDiff', [{kind: 'commit', hash}, 'src/<img src=x>.ts', true, null]),
    {method: 'fileDiff', source: {kind: 'commit', hash}, path: 'src/<img src=x>.ts', showLarge: true, oldPath: null});
  assert.deepEqual(parseRequest('fileDiff', [{kind: 'commit', hash}, 'lib/new.ts', false, 'src/old.ts']),
    {method: 'fileDiff', source: {kind: 'commit', hash}, path: 'lib/new.ts', showLarge: false, oldPath: 'src/old.ts'}, 'a renamed file names its old path');
  const id = '12345678-1234-4123-8123-123456789abc';
  assert.deepEqual(parseRequest('requestedView', []), {method: 'requestedView'});
  assert.deepEqual(parseRequest('viewReady', [id, {ok: true, firstFile: null}]), {method: 'viewReady', id, report: {ok: true, firstFile: null}});
  assert.deepEqual(parseRequest('viewReady', [id, {ok: true, firstFile: 'src/first.ts'}]), {method: 'viewReady', id, report: {ok: true, firstFile: 'src/first.ts'}});
  assert.deepEqual(parseRequest('viewReady', [id, {ok: false, problem: 'gitFailed', message: 'fatal: bad'}]), {method: 'viewReady', id, report: {ok: false, problem: 'gitFailed', message: 'fatal: bad'}}, 'the page reports the problem it shows');
});

test('boundary: bad messages are refused', () => {
  const bad: [unknown, unknown][] = [
    ['run', []], ['repository', []], ['repository', [1]], ['repository', ['commits']], ['repository', [null, null]], ['repository', 'x'], ['commits', []], ['commits', [-1]], ['commits', [1.5]], ['commits', ['3']], ['commits', [Number.NaN]], ['commits', [10_000_001]],
    ['files', [{kind: 'commit', hash: 'A'.repeat(40)}]], ['files', [{kind: 'commit', hash: 'a'.repeat(39)}]], ['files', [{kind: 'commit', hash: 'a'.repeat(41)}]], ['files', [{kind: 'commit', hash: 'a'.repeat(65)}]], ['files', [{kind: 'commit', hash: '--all'}]],
    ['files', [{kind: 'commit', hash, extra: 1}]], ['files', [{kind: 'staged', hash}]], ['files', [{kind: 'unstaged', path: 'a'}]], ['files', [{kind: 'working'}]], ['files', [{}]], ['files', [null]], ['files', [[hash]]],
    ['fileDiff', [{kind: 'commit', hash}, '/etc/passwd', false, null]], ['fileDiff', [{kind: 'commit', hash}, '../outside', false, null]], ['fileDiff', [{kind: 'commit', hash}, 'a//b', false, null]],
    ['fileDiff', [{kind: 'commit', hash}, 'a\0b', false, null]], ['fileDiff', [{kind: 'commit', hash}, '', false, null]], ['fileDiff', [{kind: 'commit', hash}, 'x'.repeat(4097), false, null]],
    ['fileDiff', [{kind: 'commit', hash}, 'a.ts', 'yes', null]], ['fileDiff', [{kind: 'commit', hash}, 'a.ts']], ['fileDiff', [{kind: 'commit', hash}, 'a.ts', false]],
    ['fileDiff', [{kind: 'commit', hash}, 'a.ts', false, '../outside']], ['fileDiff', [{kind: 'commit', hash}, 'a.ts', false, '/etc/passwd']], ['fileDiff', [{kind: 'commit', hash}, 'a.ts', false, 7]],
    ['openRepository', ['/tmp']], ['recent', [1]], ['resolveCommit', []], ['resolveCommit', [1234]], ['resolveCommit', ['a'.repeat(257)]],
    ['openRecent', []], ['openRecent', ['relative/repo']], ['openRecent', ['/a\0b']], ['openRecent', ['/' + 'x'.repeat(4096)]], ['openRecent', [{path: '/tmp'}]],
    ['requestedView', [1]], ['viewReady', []], ['viewReady', ['bad-id', {ok: true, firstFile: null}]], ['viewReady', ['12345678-1234-4123-8123-123456789abc', null]],
    ...[{ok: true, firstFile: '../outside'}, {ok: true, firstFile: '/absolute'}, {ok: true, firstFile: 3}, {ok: true}, {ok: true, firstFile: null, extra: 1}, {ok: 'yes', firstFile: null},
      {ok: false, problem: 'madeUp', message: 'x'}, {ok: false, problem: 'gitFailed', message: 7}, {ok: false, problem: 'gitFailed', message: 'x'.repeat(4097)}, {ok: false, problem: 'gitFailed'},
      'src/first.ts'].map((report): [string, unknown[]] => ['viewReady', ['12345678-1234-4123-8123-123456789abc', report]]),
    ['toString', []], ['__proto__', []], ['constructor', []],
  ];
  for (const [method, args] of bad) assert.throws(() => parseRequest(method, args), /Refused/, JSON.stringify([method, args]));
});

test('boundary: only the app page in an app window may call', () => {
  assert.equal(trustedSender(true, APP_URL, true), true);
  assert.equal(trustedSender(false, APP_URL, true), false);
  assert.equal(trustedSender(true, APP_URL, false), false);
  assert.equal(trustedSender(true, 'https://example.invalid/index.html', true), false);
});

test('boundary: inside real windows the page has no Node access, main refuses bad calls, and each repository keeps one window', async () => {
  const folder = mkdtempSync('/private/tmp/diff-viewer-boundary-');
  const {practice, history} = createFixtures(path.join(folder, 'repos'));
  const gone = path.join(folder, 'deleted-repository');
  mkdirSync(path.join(folder, 'data'));
  writeFileSync(path.join(folder, 'data', 'recent.json'), JSON.stringify([gone, history]));
  const app = await _electron.launch({args: [root, '--open', practice, '--data-dir', path.join(folder, 'data')], cwd: root, env: appEnv(), timeout: 30000});
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('.commit');
    const editRoles = await app.evaluate(({Menu}) => Menu.getApplicationMenu()?.items.find(item => item.label === 'Edit')?.submenu?.items.map(item => item.role ?? item.type) ?? []);
    for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectall']) assert.ok(editRoles.includes(role as never), `the Edit menu has the ${role} item, so its keyboard shortcut works in the commit hash box (roles: ${editRoles.join(', ')})`);
    const globals = await page.evaluate(() => ({require: typeof (window as unknown as {require?: unknown}).require, process: typeof (window as unknown as {process?: unknown}).process, api: Object.keys(window.diffViewer).sort()}));
    assert.deepEqual(globals, {require: 'undefined', process: 'undefined', api: ['commits', 'fileDiff', 'files', 'onRequestedView', 'openRecent', 'openRepository', 'recent', 'repository', 'requestedView', 'resolveCommit', 'viewReady']});
    const answers = await page.evaluate(async () => {
      const api = window.diffViewer as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const tries: [string, unknown[]][] = [['commits', [-1]], ['files', [{kind: 'commit', hash: 'HEAD'}]], ['fileDiff', [{kind: 'commit', hash: 'a'.repeat(40)}, '../../etc/passwd', false]], ['files', [{kind: 'staged', hash: 'a'.repeat(40)}]],
        ['openRecent', ['/private/tmp']], ['resolveCommit', [42]]];
      return Promise.all(tries.map(([name, args]) => api[name](...args).then(() => 'accepted', (error: Error) => error.message)));
    });
    for (const answer of answers) assert.match(answer, /Refused/);

    // The global check above covers isolation and Node: without isolation the preload cannot expose window.diffViewer.
    const sandboxed = await app.evaluate(({app: electronApp, BrowserWindow}) => {
      const pid = BrowserWindow.getAllWindows()[0].webContents.getOSProcessId();
      return electronApp.getAppMetrics().find(metric => metric.pid === pid)?.sandboxed;
    });
    assert.equal(sandboxed, true, 'the page runs in a sandboxed process');
    assert.equal(await page.evaluate(() => window.open('diff-viewer://app/index.html')), null, 'the page cannot open a new window');
    // The stylesheet is an app file the request filter lets through, so only the navigation block keeps the page in place.
    // The wait ends on main's will-navigate event for that address, so a slow navigation cannot pass unseen.
    await app.evaluate((_electron, limit) => {
      globalThis.withinLimit = (probe, work) => {
        let timer: NodeJS.Timeout;
        const late = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`probe "${probe}" gave no result within ${limit} ms`)), limit); });
        return Promise.race([work, late]).finally(() => clearTimeout(timer));
      };
    }, PROBE_LIMIT_MS);
    await app.evaluate(({BrowserWindow}) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      (globalThis as unknown as {navigation: Promise<string>}).navigation = new Promise(resolve => contents.once('will-navigate', (_event, url) => resolve(url)));
    });
    await page.evaluate(() => { location.href = 'diff-viewer://app/styles.css'; });
    assert.equal(await app.evaluate(() => withinLimit('will-navigate', (globalThis as unknown as {navigation: Promise<string>}).navigation)), 'diff-viewer://app/styles.css', 'the page tried to navigate');
    await page.waitForTimeout(200);
    assert.equal(page.url(), APP_URL, 'the page cannot navigate away from the app page');
    assert.equal(app.windows().length, 1, 'no new window opened');
    // Positive controls: a hidden window main did not set up, without each guard, shows each probe can see the unsafe state.
    const control = await app.evaluate(async ({app: electronApp, BrowserWindow}, url) => {
      const destroyChildOnceScriptResultIsBack = async (created: Promise<Electron.BrowserWindow>) => (await withinLimit('did-create-window', created)).destroy();
      const navigateOnceScriptResultIsBack = `setTimeout(() => { location.href = 'diff-viewer://app/styles.css'; }, 0); true`;
      const window = new BrowserWindow({show: false, webPreferences: {sandbox: false, contextIsolation: true, nodeIntegration: false}});
      try {
        await withinLimit('load the page', window.loadURL(url));
        const sandboxed = electronApp.getAppMetrics().find(metric => metric.pid === window.webContents.getOSProcessId())?.sandboxed ?? null;
        const created = new Promise<Electron.BrowserWindow>(resolve => window.webContents.once('did-create-window', resolve));
        const opened = await withinLimit('window.open', window.webContents.executeJavaScript(`window.open('${url}') !== null`)) as boolean;
        await destroyChildOnceScriptResultIsBack(created);
        const navigated = new Promise<string>(resolve => window.webContents.once('did-navigate', (_event, address) => resolve(address)));
        await withinLimit('start the navigation', window.webContents.executeJavaScript(navigateOnceScriptResultIsBack));
        return {sandboxed, opened, navigatedTo: await withinLimit('did-navigate', navigated)};
      } finally { window.destroy(); }
    }, APP_URL);
    assert.deepEqual(control, {sandboxed: false, opened: true, navigatedTo: 'diff-viewer://app/styles.css'}, 'control: without the guards the probes see an unsandboxed page, a new window, and a navigation');
    // A download is cancelled by main's will-download guard; a session without the guard is the control.
    const downloads = await app.evaluate(async ({BrowserWindow, session}) => {
      const attempt = (probe: string, contents: Electron.WebContents, url: string) => withinLimit(probe, new Promise<boolean>(resolve => {
        contents.session.once('will-download', (event, item) => {
          const prevented = event.defaultPrevented;
          if (!prevented) item.cancel();
          resolve(prevented);
        });
        contents.downloadURL(url);
      }));
      const app = await attempt('will-download in the app window', BrowserWindow.getAllWindows()[0].webContents, 'diff-viewer://app/styles.css');
      const window = new BrowserWindow({show: false, webPreferences: {session: session.fromPartition('download-control'), sandbox: true}});
      try { return {app, control: await attempt('will-download in the control window', window.webContents, 'data:text/plain,control')}; }
      finally { window.destroy(); }
    });
    assert.deepEqual(downloads, {app: true, control: false}, 'main cancels a download from the app window; control: a session without the guard does not');
    // A window main did not create, with the same preload and page, is refused by the sender check.
    const stranger = await app.evaluate(async ({BrowserWindow}, {preload, url}) => {
      const window = new BrowserWindow({show: false, webPreferences: {preload, sandbox: true, contextIsolation: true}});
      try {
        await withinLimit('load the page in a stranger window', window.loadURL(url));
        return await withinLimit('call from a stranger window', window.webContents.executeJavaScript('window.diffViewer.recent().then(() => "accepted", error => error.message)')) as string;
      } finally { window.destroy(); }
    }, {preload: path.join(root, 'dist/src/app/preload.js'), url: APP_URL});
    assert.match(stranger, /Refused: this page is not the app page/, 'a call from a window main did not create is refused');
    const valid = await page.evaluate(() => window.diffViewer.commits(0));
    assert.equal(valid.ok && valid.value.commits.length, 12, 'a valid call still works after the refusals');
    const newest = valid.ok ? valid.value.commits[0] : null;
    const pasted = await page.evaluate(text => window.diffViewer.resolveCommit(text), newest?.hash.slice(0, 7) ?? '');
    assert.deepEqual(pasted, {ok: true, value: newest}, 'a pasted short hash resolves through the preload');
    const recent = await page.evaluate(() => window.diffViewer.recent());
    assert.deepEqual(recent, [realpathSync(practice), gone, history], 'the repository opened with --open is first in the recent list, and a deleted one stays');
    const reopened = await page.evaluate(target => window.diffViewer.openRecent(target as RepoPath), gone);
    assert.deepEqual(reopened, {ok: false, error: {kind: 'repositoryGone', path: gone}});
    assert.deepEqual(await page.evaluate(() => window.diffViewer.recent()), [realpathSync(practice), history], 'opening the deleted repository drops it from the recent list');

    const second = app.waitForEvent('window');
    assert.equal(await page.evaluate(target => window.diffViewer.openRecent(target as RepoPath), history), null, 'a second repository opens in a new window');
    const historyPage = await second;
    await historyPage.waitForSelector('.commit');
    assert.equal(await historyPage.evaluate(() => window.diffViewer.repository().then(info => info?.ok && info.value.commits.commits.length)), 200, 'the new window shows the 250-commit repository');
    assert.equal(await historyPage.evaluate(target => window.diffViewer.openRecent(target as RepoPath), realpathSync(practice)), null, 'reopening the first repository focuses its window');
    assert.equal(app.windows().length, 2, 'one window per repository');
    const again = await page.evaluate(target => window.diffViewer.openRecent(target as RepoPath), realpathSync(practice));
    assert.equal(again && again.ok && again.value.name, 'practice', 'the window already showing a repository reloads it');
  } finally {
    await app.close();
    rmSync(folder, {recursive: true, force: true});
  }
});
