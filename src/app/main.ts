import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, session } from 'electron';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { APP_ORIGIN, APP_URL, parseRequest, trustedSender } from './boundary.ts';
import type { Request } from './boundary.ts';
import { changedFiles, commitPage, fileDiff, openRepository, repositoryInfo, resolveCommit, resolveRevision } from './git.ts';
import type { Repository } from './git.ts';
import { forgetRecent, readRecent, rememberRecent } from './recent.ts';
import { planOpen } from './windows.ts';
import { CALL_CHANNEL, TITLE_SUFFIX, VIEW_CHANNEL } from '../domain/types.ts';
import type { AppError, FilePath, RepoInfo, RepoPath, RequestedView, Result, Source, ViewReport, WorkingKind } from '../domain/types.ts';
import { parseSourceArgument } from '../domain/source-argument.mjs';
import type { SourceArgument } from '../domain/source-argument.mjs';

const webDirectory = resolve(__dirname, '../web');
const assets = new Map([
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
  ['/renderer.js', { file: 'renderer.js', type: 'text/javascript; charset=utf-8' }],
  ['/kept-view.js', { file: 'kept-view.js', type: 'text/javascript; charset=utf-8' }],
]);
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

protocol.registerSchemesAsPrivileged([{ scheme: 'diff-viewer', privileges: { standard: true, secure: true } }]);

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value.`);
  return value;
}

function useDataDirectory(): void {
  const chosen = option('--data-dir');
  if (chosen === null) return;
  if (!isAbsolute(chosen)) throw new Error('--data-dir needs an absolute folder path.');
  mkdirSync(join(chosen, 'chromium'), { recursive: true, mode: 0o700 });
  app.setPath('userData', chosen);
  app.setPath('sessionData', join(chosen, 'chromium'));
}

/** A view a launcher asked for, until the page reports what it shows. */
type ViewRequest = { view: RequestedView; finish: (report: ViewReport) => void };
/**
 * Each window keyed by its webContents id, with the repository it opened: a repository, a failed open from --open, or none
 * yet. `folder` is the --open folder of a failed start, opened again when the page asks for the repository.
 */
const windows = new Map<number, { readonly window: BrowserWindow; repository: Result<Repository> | null; readonly folder: string | null; requested: ViewRequest | null }>();
const recentFile = () => join(app.getPath('userData'), 'recent.json');

/** Puts a repository first in the recent list. A list that cannot be saved, as in an unwritable data folder, never stops an open. */
function remember(path: RepoPath): void {
  try { rememberRecent(recentFile(), path); }
  catch (error) { console.error(`The recent list was not saved: ${messageOf(error)}`); }
}

function windowRepositories(): Map<number, RepoPath | null> {
  return new Map([...windows].map(([id, entry]) => [id, entry.repository?.ok ? entry.repository.value.path : null]));
}

function createWindow(repository: Result<Repository> | null, folder: string | null = null): BrowserWindow {
  const window = new BrowserWindow({
    width: 1320, height: 900, minWidth: 720, minHeight: 480, title: 'diff-viewer', backgroundColor: nativeTheme.shouldUseDarkColors ? '#131917' : '#fafbf8',
    webPreferences: { preload: join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false, spellcheck: false },
  });
  const id = window.webContents.id;
  windows.set(id, { window, repository, folder: repository?.ok === false ? folder : null, requested: null });
  window.on('closed', () => windows.delete(id));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.loadURL(APP_URL).catch((error: unknown) => console.error(`The app page did not load: ${messageOf(error)}`));
  return window;
}

/** focus() alone leaves a minimized window in the Dock on macOS. */
function bringForward(window: BrowserWindow | undefined): void {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/** A hand-off and the time its answer is due: 15 seconds after it arrived, however long it waits in the queue. */
type HandOff = { repository: string; readyFile: string; source: SourceArgument | null; deadline: number };
/** Hand-offs from later `diff-viewer open` calls, handled one at a time. */
const handOffQueue: HandOff[] = [];
let handOffReady = false;
let draining = false;

function validReadyFile(file: string, dataDirectory: string): boolean {
  if (!isAbsolute(file) || !/^ready-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/.test(basename(file))) return false;
  try { return realpathSync(dirname(resolve(file))) === realpathSync(dataDirectory); }
  catch { return false; }
}

/** A hand-off from a later `diff-viewer open`, with its source parsed; null when any part is not valid. */
function parseHandOff(value: unknown, dataDirectory: string): HandOff | null {
  if (typeof value !== 'object' || value === null) return null;
  const data = value as Record<string, unknown>;
  const source = data.source === null ? null : parseSourceArgument(data.source);
  if (typeof data.repository !== 'string' || !isAbsolute(data.repository) || typeof data.readyFile !== 'string' || !validReadyFile(data.readyFile, dataDirectory)) return null;
  return data.source !== null && source === null ? null : { repository: data.repository, readyFile: data.readyFile, source, deadline: deadlineFromNow() };
}

/** Why a hand-off failed, with the error code the installed command prints. */
class HandOffFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

/** Git's own `fatal:` line, or the first line of its message. */
const gitLine = (message: string) => message.split('\n').find(line => line.startsWith('fatal: ')) ?? message.split('\n')[0];

function openFailure(error: AppError, folder: string): HandOffFailure {
  switch (error.kind) {
    case 'notARepository': case 'repositoryGone': return new HandOffFailure('not-a-repository', `No Git repository at ${folder}.`);
    case 'gitFailed': return new HandOffFailure('git-failed', gitLine(error.message));
    default: return new HandOffFailure('app-not-ready', `The app could not open ${folder}.`);
  }
}

/** The error code for the problem the page shows instead of a requested view. */
function viewFailure(report: Extract<ViewReport, { ok: false }>): HandOffFailure {
  switch (report.problem) {
    case 'notARepository': case 'repositoryGone': return new HandOffFailure('not-a-repository', `The repository is no longer there: ${report.message}`);
    case 'gitFailed': return new HandOffFailure('git-failed', gitLine(report.message));
    case 'unknownCommit': return new HandOffFailure('unknown-commit', report.message);
    default: return new HandOffFailure('app-not-ready', `The requested view could not be shown: ${report.message}`);
  }
}

async function sourceFor(repo: Repository, parsed: SourceArgument | null): Promise<Source | null> {
  if (parsed === null) return null;
  if (parsed.kind !== 'commit') {
    if (repo.bare) throw new HandOffFailure('unavailable-source', `A bare repository has no ${parsed.kind} changes.`);
    return { kind: parsed.kind };
  }
  const resolved = await resolveRevision(repo, parsed.revision);
  if (resolved.ok) return { kind: 'commit', hash: resolved.value };
  // Only a name git cannot resolve is an unknown commit; a commit git cannot read keeps git's message.
  throw resolved.error.kind === 'unknownCommit' ? new HandOffFailure('unknown-commit', `No commit named ${parsed.revision} in ${repo.path}.`) : openFailure(resolved.error, repo.path);
}

/**
 * Asks a window's page for a view; settles with the page's report. A new window's page asks for it once it loads, so only
 * a page that is already running gets it sent (`send`).
 */
function requestView(window: BrowserWindow, source: Source | null, send: boolean): Promise<ViewReport> {
  const entry = windows.get(window.webContents.id);
  if (!entry) throw new HandOffFailure('app-not-ready', 'The requested window closed.');
  return new Promise(resolve => {
    const view = { id: randomUUID(), source };
    entry.requested = { view, finish: resolve };
    if (send) window.webContents.send(VIEW_CHANNEL, view);
  });
}

/**
 * The installed command stops waiting after 20 seconds. Each open must show its window and view within 15 seconds of its
 * start, or of its arrival for a hand-off that waits in the queue, so the command still reads the reason when it does not.
 * A wait with no limit would hold the hand-off queue, and every later `diff-viewer open` would time out.
 */
const OPEN_LIMIT_MS = 15_000;
const deadlineFromNow = () => Date.now() + OPEN_LIMIT_MS;
const tooSlow = (what: string) => new HandOffFailure('app-not-ready', `The ${what} did not appear within ${OPEN_LIMIT_MS / 1000} seconds.`);
/** Stops an open whose time ran out, as behind a slow open in the queue, before it opens a window the command no longer waits for. */
function inTime(deadline: number): void {
  if (Date.now() >= deadline) throw new HandOffFailure('app-not-ready', `The app was busy for ${OPEN_LIMIT_MS / 1000} seconds and did not start this open.`);
}

/**
 * Settles with the first file when the page reports the requested view. Fails with the page's own problem when it shows
 * one instead, and when the window closes first or the deadline passes.
 */
function viewSettled(window: BrowserWindow, view: Promise<ViewReport>, deadline: number): Promise<FilePath | null> {
  return new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); window.off('closed', onClosed); };
    const onClosed = () => { done(); reject(new HandOffFailure('app-not-ready', 'The requested window closed before its view appeared.')); };
    const timer = setTimeout(() => { done(); reject(tooSlow('requested view')); }, Math.max(0, deadline - Date.now()));
    window.once('closed', onClosed);
    void view.then(report => {
      done();
      if (report.ok) resolve(report.firstFile);
      else reject(viewFailure(report));
    });
  });
}

/** Tells the waiting command why its open failed, so it can stop at once and print the reason. */
function signalFailure(file: string, error: unknown): void {
  const failure = error instanceof HandOffFailure ? error : new HandOffFailure('app-not-ready', messageOf(error));
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify({ ready: false, error: { code: failure.code, message: failure.message } }) + '\n', { mode: 0o600 });
  renameSync(temporary, file);
}

/** A repository and its requested view on screen, as the ready file reports them. */
type Shown = { readonly window: BrowserWindow; readonly title: string; readonly source: Source | null; readonly firstFile: FilePath | null };

function signalReady(file: string, { window, title, source, firstFile }: Shown, appState: 'started' | 'running'): void {
  bringForward(window);
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify({ ready: true, title, visible: window.isVisible(), app: appState, pid: process.pid, ...(source ? { source, firstFile } : {}) }) + '\n', { mode: 0o600 });
  renameSync(temporary, file);
}

/**
 * Settles when the page shows a repository in its title. Fails when the page does not load, the window closes, or the
 * deadline passes, and at once with the page's own problem when `view` fails first, as when git cannot read the commits.
 */
function windowTitleReady(window: BrowserWindow, deadline: number, view: Promise<unknown>): Promise<string> {
  const current = window.getTitle();
  if (current.endsWith(TITLE_SUFFIX)) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      window.webContents.off('page-title-updated', onTitle);
      window.webContents.off('did-fail-load', onFailure);
      window.off('closed', onClosed);
    };
    const onTitle = (_event: unknown, title: string) => {
      if (!title.endsWith(TITLE_SUFFIX)) return;
      cleanup();
      resolve(title);
    };
    const onFailure = () => { cleanup(); reject(new HandOffFailure('app-not-ready', 'The requested window did not load.')); };
    const onClosed = () => { cleanup(); reject(new HandOffFailure('app-not-ready', 'The requested window closed before it was ready.')); };
    const timer = setTimeout(() => { cleanup(); reject(tooSlow('repository window')); }, Math.max(0, deadline - Date.now()));
    window.webContents.on('page-title-updated', onTitle);
    window.webContents.once('did-fail-load', onFailure);
    window.once('closed', onClosed);
    void view.catch((error: unknown) => { cleanup(); reject(error); });
  });
}

/**
 * The one open path for the first app and for hand-offs: shows `repository` in the window that already shows it, or in a
 * new window, then the requested view. Fails with a HandOffFailure that names the reason.
 */
async function showAndWait(repository: Result<Repository> | null, source: Source | null, deadline: number): Promise<Shown> {
  const plan = repository?.ok ? planOpen(windowRepositories(), -1, repository.value.path) : { kind: 'new' as const };
  const existing = plan.kind === 'focus' ? windows.get(plan.window)?.window : undefined;
  if (plan.kind === 'focus' && !existing) throw new HandOffFailure('app-not-ready', 'The repository window closed.');
  const window = existing ?? createWindow(repository);
  // Even an open without a source waits for the page's report: a page that cannot load its repository reports the problem
  // it shows, and a window that already exists may show a card over its repository.
  const view = viewSettled(window, requestView(window, source, existing !== undefined), deadline);
  const title = await windowTitleReady(window, deadline, view);
  return { window, title, source, firstFile: await view };
}

/** Shows the requested repository and view, then writes the ready file. Throws a HandOffFailure with the reason. */
async function handOff(data: HandOff): Promise<void> {
  const { deadline } = data;
  inTime(deadline);
  const opened = await openRepository(data.repository);
  if (!opened.ok) throw openFailure(opened.error, data.repository);
  // The command found the same top folder a moment ago, so a different one means the folder changed in between. That is
  // app-not-ready on purpose: its next step, running the same command again, makes the command look again and see the new state.
  if (opened.value.path !== data.repository) throw new HandOffFailure('app-not-ready', `The app found the repository at ${opened.value.path} instead of ${data.repository}.`);
  const source = await sourceFor(opened.value, data.source);
  inTime(deadline);
  remember(opened.value.path);
  signalReady(data.readyFile, await showAndWait(opened, source, deadline), 'running');
}

async function drainHandOffs(): Promise<void> {
  if (!handOffReady || draining) return;
  draining = true;
  try {
    while (handOffQueue.length) {
      const data = handOffQueue.shift()!;
      try { await handOff(data); }
      catch (error) {
        console.error(messageOf(error));
        // An answer that cannot be written must not stop the queue: the next hand-off still gets its own answer.
        try { signalFailure(data.readyFile, error); }
        catch (failure) { console.error(`The answer was not written: ${messageOf(failure)}`); }
      }
    }
  } finally { draining = false; }
}

/** Opens a folder the user chose, one window per repository; null when the repository opens or is focused in another window. */
async function open(caller: number, folder: string): Promise<Result<RepoInfo> | null> {
  const opened = await openRepository(folder);
  if (!opened.ok) return opened;
  const repo = opened.value;
  remember(repo.path);
  const plan = planOpen(windowRepositories(), caller, repo.path);
  if (plan.kind === 'focus') { bringForward(windows.get(plan.window)?.window); return null; }
  if (plan.kind === 'new') { createWindow(opened); return null; }
  const entry = windows.get(caller);
  if (entry) entry.repository = opened;
  return repositoryInfo(repo);
}

async function chooseFolder(caller: number): Promise<Result<RepoInfo> | null> {
  const parent = windows.get(caller)?.window;
  const options = { title: 'Open repository', buttonLabel: 'Open', properties: ['openDirectory'] as Array<'openDirectory'> };
  const chosen = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  return chosen.canceled || chosen.filePaths.length === 0 ? null : open(caller, chosen.filePaths[0]);
}

async function openRecent(caller: number, path: RepoPath): Promise<Result<RepoInfo> | null> {
  if (!readRecent(recentFile()).includes(path)) throw new Error('Refused: that path is not in the recent list.');
  if (!existsSync(path)) {
    forgetRecent(recentFile(), path);
    return { ok: false, error: { kind: 'repositoryGone', path } };
  }
  return open(caller, path);
}

function run(caller: number, request: Request): unknown {
  switch (request.method) {
    case 'openRepository': return chooseFolder(caller);
    case 'recent': return readRecent(recentFile());
    case 'openRecent': return openRecent(caller, request.path);
    case 'requestedView': return windows.get(caller)?.requested?.view ?? null;
    case 'viewReady': return acknowledgeView(caller, request.id, request.report);
  }
  if (request.method === 'repository') return windowRepository(caller, request.list);
  const opened = windows.get(caller)?.repository ?? null;
  if (opened === null) throw new Error('Refused: this window has no repository yet.');
  if (!opened.ok) return opened;
  const repo = opened.value;
  switch (request.method) {
    case 'commits': return commitPage(repo, request.skip);
    case 'resolveCommit': return resolveCommit(repo, request.text);
    case 'files': return changedFiles(repo, request.source);
    case 'fileDiff': return fileDiff(repo, request.source, request.path, request.showLarge, request.oldPath);
  }
}

/** The window's repository for the page. After a failed start the folder is opened again, so "Try again" sees a repair. */
async function windowRepository(caller: number, list: WorkingKind | null): Promise<Result<RepoInfo> | null> {
  const entry = windows.get(caller);
  if (entry?.repository?.ok === false && entry.folder !== null) {
    const reopened = await openRepository(entry.folder);
    if (reopened.ok) {
      remember(reopened.value.path);
      // One window per repository: when another window shows it by now, that window comes forward and this one shows the first-run card.
      const plan = planOpen(windowRepositories(), caller, reopened.value.path);
      if (plan.kind === 'focus') { bringForward(windows.get(plan.window)?.window); entry.repository = null; return null; }
    }
    entry.repository = reopened;
  }
  const opened = entry?.repository ?? null;
  return opened?.ok ? repositoryInfo(opened.value, list) : opened;
}

/** Takes the page's report of the view it was asked for, as the page shows it; a report for another view is refused. */
function acknowledgeView(caller: number, id: string, report: ViewReport): boolean {
  const entry = windows.get(caller);
  const requested = entry?.requested;
  if (!entry || !requested || requested.view.id !== id) return false;
  entry.requested = null;
  requested.finish(report);
  return true;
}

function serve(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'diff-viewer', submenu: [{ role: 'quit' }] },
    // The roles give Command-Z, Command-X, Command-C, Command-V, and Command-A to the commit hash box; macOS routes them through this menu.
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] },
  ]));
  protocol.handle('diff-viewer', request => {
    const url = new URL(request.url);
    const asset = assets.get(url.pathname);
    // Node's URL gives a custom scheme the origin 'null', so the parts are compared one by one.
    if (url.protocol !== 'diff-viewer:' || url.host !== 'app' || url.username || url.password || url.search || !asset) return new Response('Not found', { status: 404 });
    return new Response(readFileSync(join(webDirectory, asset.file)), { headers: { 'Content-Type': asset.type, 'Content-Security-Policy': CSP } });
  });
  const appSession = session.defaultSession;
  appSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  appSession.setPermissionCheckHandler(() => false);
  appSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(`${APP_ORIGIN}/`) }));
  appSession.on('will-download', event => event.preventDefault());
  ipcMain.handle(CALL_CHANNEL, (event, method: unknown, args: unknown) => {
    if (!trustedSender(windows.has(event.sender.id), event.senderFrame?.url ?? '', event.senderFrame === event.sender.mainFrame)) {
      throw new Error('Refused: this page is not the app page.');
    }
    return run(event.sender.id, parseRequest(method, args));
  });
}

/** True when some window shows a repository, so the app stays useful after a failed requested view. */
const showsRepository = () => [...windows.values()].some(entry => entry.window.getTitle().endsWith(TITLE_SUFFIX));

/**
 * Started by the installed command: open the repository and view, and write the answer to the ready file. On a failure the
 * answer names the reason at once. The app keeps running when a window shows the repository, and exits when none does.
 */
async function startForCommand(repository: Result<Repository> | null, folder: string, requested: SourceArgument | null, readyFile: string): Promise<void> {
  const deadline = deadlineFromNow();
  try {
    if (repository && !repository.ok) throw openFailure(repository.error, folder);
    const source = repository ? await sourceFor(repository.value, requested) : null;
    signalReady(readyFile, await showAndWait(repository, source, deadline), 'started');
  } catch (error) {
    console.error(messageOf(error));
    signalFailure(readyFile, error);
    if (!showsRepository()) { app.exit(1); return; }
  }
  handOffReady = true;
  void drainHandOffs();
}

/** Started by scripts/start or the harness: nobody waits on a ready file, so hand-offs start once the page loads. */
async function startPlain(repository: Result<Repository> | null, folder: string | null, requested: SourceArgument | null): Promise<void> {
  const source = repository?.ok ? await sourceFor(repository.value, requested) : null;
  const window = createWindow(repository, folder);
  if (source) void requestView(window, source, false);
  window.webContents.once('did-finish-load', () => { handOffReady = true; void drainHandOffs(); });
}

try {
  useDataDirectory();
  const folder = option('--open');
  const readyFile = option('--ready-file');
  const requestedText = option('--source');
  const dataDirectory = app.getPath('userData');
  if (readyFile !== null && !validReadyFile(readyFile, dataDirectory)) {
    throw new Error('--ready-file needs a path directly inside the app data folder.');
  }
  if (folder !== null && !isAbsolute(folder)) throw new Error('--open needs an absolute folder path. scripts/start resolves a relative path against the folder it runs from.');
  const requested = requestedText === null ? null : parseSourceArgument(requestedText);
  if (requestedText !== null && requested === null) throw new Error('Invalid --source value.');
  const locked = app.requestSingleInstanceLock({ repository: folder, readyFile, source: requestedText });
  if (!locked) {
    if (readyFile === null) console.error('diff-viewer is already running with this app data folder, so this start opened nothing. Use "Open repository…" in its window, or quit it with Command-Q first.');
    app.quit();
  } else {
    app.on('second-instance', (_event, _argv, _workingDirectory, data) => {
      const parsed = parseHandOff(data, dataDirectory);
      if (!parsed) return;
      handOffQueue.push(parsed);
      void drainHandOffs();
    });
    const repository = folder === null ? null : openRepository(folder);
    app.on('window-all-closed', () => app.quit());
    app.whenReady()
      .then(async () => {
        serve();
        const opened = repository && await repository;
        if (opened?.ok) remember(opened.value.path);
        if (readyFile !== null) await startForCommand(opened, folder ?? '', requested, readyFile);
        else await startPlain(opened, folder, requested);
      })
      .catch(error => { console.error(messageOf(error)); app.exit(1); });
  }
} catch (error) {
  console.error(messageOf(error));
  app.exit(1);
}
