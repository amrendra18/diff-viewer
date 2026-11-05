import {_electron} from 'playwright';
import type {ElectronApplication, Page} from 'playwright';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {loadavg} from 'node:os';
import path from 'node:path';
import {APP_ORIGIN, APP_URL} from '../src/app/boundary.ts';
import {GIT_COMMANDS, GIT_OPTIONS, GIT_SETTINGS, STATUS_ARGUMENTS} from '../src/app/git-settings.ts';
import {languageFor} from '../src/app/highlight.ts';
import {LARGE_FILE_BYTES, LARGE_FILE_LINES, TITLE_SUFFIX} from '../src/domain/types.ts';
import type {DiffViewerApi} from '../src/domain/types.ts';
import {build} from './build.mts';
import {
  ACCENTED_SUBJECT, APP_CHANGES, BIG_FILE, BIG_FILE_EDITS, createCleanPractice, DENSE_FILE, createFixtures, createPractice, HOSTILE_FILE, HTML_SUBJECT, NEWEST_SUBJECT, NOTES_FILE, SLOW_CPP_FILE, SLOW_CPP_LINES, SMALL_FILE,
  SPECIAL_EDIT_SUBJECT, SPECIAL_TARGETS_SUBJECT, STEP_FILES, STEP_SUBJECT, SUBMODULE_COMMITS, SYMLINK_TARGETS, TABLE_FILE_LINES,
} from './fixtures.mts';
import type {Fixtures} from './fixtures.mts';
import {fingerprint} from './fingerprint.mts';
import {isAlive, sampleOwnedDescendants} from './owned-processes.mts';
import {BUNDLE, BUNDLE_EXECUTABLE, checkoutIdentity, packageApp} from './package.mts';
import {isolatedGit, isolatedGitOut, personalGitOut, realGit} from './isolated-git.mts';
import {frontAppName, journeyFailure, screenCheck} from './screen.mts';

declare global {
  interface Window { diffViewer: DiffViewerApi }
}

const root = path.resolve(import.meta.dirname, '..');
const FEATURES = [
  'open-repository', 'commit-diff', 'special-files', 'highlighting', 'hostile-text', 'not-a-repository', 'recent-repositories', 'dark-mode',
  'bare-repository', 'window-per-repository', 'collapse-pane', 'next-previous-file', 'working-changes', 'repository-removed', 'read-only-repository', 'user-git-config',
  'app-bundle', 'launcher-open', 'launcher-twice', 'launcher-source',
] as const;
type Feature = typeof FEATURES[number];
const FULL_ONLY: readonly Feature[] = ['app-bundle'];
const FAULTS = ['rows', 'env', 'launcher-write', 'launcher-git-write', 'ignored-read'];
const SAMPLES = 5;
/** The files of the special fixture's newest commit: the big, dense, notes, and small modules. */
const SPECIAL_EDIT_FILES = 4;
const BAR = {commitList: 300, fileList: 300, diff: 500, fixtureDiff: 700} as const;
/** The page skips a focus refresh within 1 s of the last one (src/web/renderer.ts); the harness waits longer before it focuses the window again. */
const FOCUS_GAP_MS = 1200;
const FOCUS_TRIES = 3;
const FOCUS_WAIT_MS = 3000;
const MAX_LOAD = 6;
/** Each real-repository flag and the environment variable that gives the same path when the flag is absent. */
const REAL_REPOSITORY_FLAGS = {'--history-repo': 'DIFF_VIEWER_HISTORY_REPO', '--file-repo': 'DIFF_VIEWER_FILE_REPO'} as const;
const ELECTRON = path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const CONTROL_URL = 'http://127.0.0.1:9/read-only-control';
const PAGE_PROBE_URL = 'http://127.0.0.1:9/from-page';
const REPOSITORY_TITLE = `practice${TITLE_SUFFIX}`;
const SPECIAL_TITLE = `special${TITLE_SUFFIX}`;
const GITHUB = {light: {keyword: '#D73A49', comment: '#6A737D'}, dark: {keyword: '#F97583', comment: '#6A737D'}} as const;
const PAPER = {light: '#FAFBF8', dark: '#131917'} as const;

type Row = {name: string; status: 'proven' | 'failed' | 'skipped'; reason?: string};
type Timing = {samples: number[]; median: number; bar: number | null; scope: string};
type Options = {level: 'fast' | 'full'; selected: Feature[]; skipped: Feature[]; historyRepo: string | null; fileRepo: string | null};

function usage(): string {
  return [
    'scripts/verify [fast|full] [--feature NAME] [--history-repo PATH] [--file-repo PATH]',
    `fast: every feature except ${FULL_ONLY.join(', ')}, in the Electron app run from this checkout. The launcher features build and sign the app bundle first.`,
    'full: fast plus app-bundle (scripts/package builds .local/build/diff-viewer.app, codesign checks it, and the bundle opens and highlights a file).',
    `Features: ${FEATURES.join(', ')} (app-bundle at the full level only).`,
    '--history-repo PATH (or DIFF_VIEWER_HISTORY_REPO=PATH): also measure bars 1 and 2 on this real repository (opened read-only with --open).',
    '--file-repo PATH (or DIFF_VIEWER_FILE_REPO=PATH): also measure bar 3 on the largest highlighted file under 5,000 lines in this real repository.',
    'A flag wins over its environment variable.',
    'Bars 1 to 3 fail the feature that measures them when a median is at or over the bar (300 and 300 ms; bar 3 is 700 ms on the fixture file and 500 ms on a real file; see verify/features/README.md).',
    'Exit codes: 0 every selected feature proven, 1 a feature failed, 2 usage error, 3 the doctor found the environment not ready and nothing was launched,',
    'or the screen locked during the run (a journey failed while lsappinfo named loginwindow in front; the journeys after it are not run). A failed feature wins over a lock.',
    'Evidence: .local/verify/<UTC time>/ with summary.md, summary.json, index.html, screens/, traces/, logs/. The last output line names it.',
    'summary.json and summary.md name the commit (revision) and whether the checkout had uncommitted changes (modified) when the run started.',
    'Planted fault: DIFF_VIEWER_VERIFY_FAULT=rows swaps the expected sides of change rows; scripts/verify fast --feature commit-diff must then exit 1.',
    'Planted fault: DIFF_VIEWER_VERIFY_FAULT=env launches the app with the whole inherited environment; the trace scan must then fail the same run.',
    'Planted faults: DIFF_VIEWER_VERIFY_FAULT=launcher-write changes a fixture file, and launcher-git-write changes shared Git metadata; launcher-open must then fail.',
    'Planted fault: DIFF_VIEWER_VERIFY_FAULT=ignored-read adds an ignored path to the app listing; read-only-repository must fail and name the path.',
    'Every run ends with the trace scan: each traces/*.zip must hold no variable of the shell that started the run, outside PATH and HOME (row "traces hold no shell environment").',
    'Feature map: verify/features/README.md',
  ].join('\n');
}

function parseArguments(): Options {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(usage()); process.exit(0); }
  let level = 'fast';
  if (args[0] && !args[0].startsWith('--')) level = args.shift()!;
  const values = new Map<string, string>();
  const problems: string[] = [];
  while (args.length) {
    const flag = args.shift()!;
    const value = args[0] && !args[0].startsWith('--') ? args.shift()! : undefined;
    if (!['--feature', '--history-repo', '--file-repo'].includes(flag)) problems.push(`Unknown argument: ${flag}`);
    else if (value === undefined) problems.push(`${flag} needs a value.`);
    else values.set(flag, value);
  }
  const feature = values.get('--feature');
  const real = (flag: keyof typeof REAL_REPOSITORY_FLAGS) => values.get(flag) ?? (process.env[REAL_REPOSITORY_FLAGS[flag]] || undefined);
  const fault = process.env.DIFF_VIEWER_VERIFY_FAULT;
  problems.push(...[
    level !== 'fast' && level !== 'full' ? `Unknown level: ${level}` : '',
    feature !== undefined && !(FEATURES as readonly string[]).includes(feature) ? `Unknown feature: ${feature}` : '',
    feature !== undefined && level === 'fast' && (FULL_ONLY as readonly string[]).includes(feature) ? `${feature} runs at the full level only.` : '',
    fault && !FAULTS.includes(fault) ? `Unknown DIFF_VIEWER_VERIFY_FAULT: ${fault}. Supported: ${FAULTS.join(', ')}.` : '',
    ...Object.entries(REAL_REPOSITORY_FLAGS).map(([flag, variable]) => {
      const folder = real(flag as keyof typeof REAL_REPOSITORY_FLAGS);
      return folder !== undefined && (!path.isAbsolute(folder) || !existsSync(path.join(folder, '.git'))) ? `${flag} (or ${variable}) needs the absolute path of a repository with a .git folder.` : '';
    }),
  ].filter(Boolean));
  if (problems.length) { console.error(problems.join('\n') + '\n\n' + usage()); process.exit(2); }
  const selected = feature ? [feature as Feature] : FEATURES.filter(name => level === 'full' || !FULL_ONLY.includes(name));
  const skipped = feature ? [] : FEATURES.filter(name => !selected.includes(name));
  return {level: level as 'fast' | 'full', selected, skipped, historyRepo: real('--history-repo') ?? null, fileRepo: real('--file-repo') ?? null};
}

const options = parseArguments();
const fault = process.env.DIFF_VIEWER_VERIFY_FAULT ?? null;
const evidence = path.join(root, '.local/verify', new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'));
for (const folder of ['screens', 'traces', 'logs', 'state']) mkdirSync(path.join(evidence, folder), {recursive: true});
const rows: Row[] = [];
const measurements: Record<string, Timing | string> = {};
const observations: Record<string, unknown> = {};
const loadBeforeMeasuring: Record<string, {load: number; waitedSeconds: number}> = {};
const actions: {at: string; action: string; result: unknown}[] = [];
const unexpected: string[] = [];
const owned = new Set<number>();
const closing: Promise<void>[] = [];
const cleanup: {ownedProcesses: number; stillRunning: number[]; stopped: number[]; errors: string[]} = {ownedProcesses: 0, stillRunning: [], stopped: [], errors: []};
let fixtures: Fixtures;

function log(action: string, result: unknown): void { actions.push({at: new Date().toISOString(), action, result}); }
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const round = (value: number) => Math.round(value * 10) / 10;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const short = (hash: string) => hash.slice(0, 7);
const MAIN_ANSWER_MS = 500;
const MAIN_BLOCK_MS = 800;
/** Elements that repository text would create if it were ever parsed as HTML. */
const countMarkup = (page: Page) => page.evaluate(() => document.querySelectorAll('b, img, iframe, object, embed, script:not([src])').length);
const rgb = (hex: string) => `rgb(${[1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16)).join(', ')})`;

/** Records the samples, then fails the calling feature when the median is at or over the bar. */
function timing(name: string, bar: number | null, samples: number[], scope: string): void {
  const value = {samples: samples.map(round), median: round(median(samples)), bar, scope};
  measurements[name] = value;
  if (bar !== null) assert(value.median < bar, `${name}: median ${value.median} ms is not under the ${bar} ms bar (samples ${value.samples.join(', ')})`);
}

async function calm(label: string): Promise<void> {
  let waited = 0;
  while (loadavg()[0] > MAX_LOAD && waited < 300) { await sleep(10000); waited += 10; }
  loadBeforeMeasuring[label] = {load: round(loadavg()[0]), waitedSeconds: waited};
}

function nodeInRange(version: string, range: string): boolean {
  const match = /^>=(\d+\.\d+\.\d+) <(\d+)$/.exec(range);
  if (!match) throw new Error(`package.json engines.node must have the form ">=A.B.C <D", not "${range}".`);
  const [, least, below] = match;
  return version.localeCompare(least, 'en', {numeric: true}) >= 0 && Number(version.split('.')[0]) < Number(below);
}

function doctor(): {ready: boolean; rows: {name: string; ok: boolean; detail: string}[]} {
  const checks: {name: string; ok: boolean; detail: string}[] = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push({name, ok, detail});
  const screen = screenCheck(frontAppName());
  check('screen', screen.ok, screen.detail);
  check('platform', process.platform === 'darwin' && process.arch === 'arm64', `${process.platform}/${process.arch}; the app targets macOS on Apple silicon.`);
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {engines: {node: string}; dependencies: Record<string, string>; devDependencies: Record<string, string>};
  check('Node', nodeInRange(process.versions.node, pkg.engines.node), `${process.versions.node}; package.json needs ${pkg.engines.node}.`);
  const git = harnessGit(['--version']);
  check('git', git.status === 0, git.status === 0 ? git.stdout.trim() : 'Install git.');
  for (const [name, version] of Object.entries({...pkg.dependencies, ...pkg.devDependencies})) {
    const file = path.join(root, 'node_modules', name, 'package.json');
    const installed = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as {version: string}).version : 'missing';
    check(name, installed === version, `${installed}; package.json pins ${version}. Run npm ci --ignore-scripts.`);
  }
  check('Electron binary', existsSync(ELECTRON), 'Run the Electron install step in README.md, under "Install".');
  // app-bundle and the three launcher features build and sign the bundle, so they need codesign at either level.
  if (options.selected.some(feature => feature === 'app-bundle' || feature.startsWith('launcher-'))) {
    const codesign = spawnSync('codesign', ['--help'], {encoding: 'utf8'});
    check('codesign', codesign.error === undefined, 'Needed for the ad-hoc signature of the app bundle.');
  }
  if (checks.every(row => row.ok)) {
    try { build(); check('build', true, 'dist/ rebuilt from this checkout.'); }
    catch (error) { check('build', false, error instanceof Error ? error.message : String(error)); }
  }
  return {ready: checks.every(row => row.ok), rows: checks};
}

const ALLOWED_ENV = ['PATH', 'HOME'];
const allowedEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  ...Object.fromEntries(ALLOWED_ENV.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]])), ...extra,
});
const appEnv = (extra: Record<string, string> = {}): Record<string, string> => fault === 'env'
  ? {...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE')), ...extra}
  : allowedEnv(extra);

const harnessGit = (args: readonly string[], {env, input}: {env?: Record<string, string>; input?: string} = {}) => isolatedGit(args, {base: allowedEnv(), env, input});

const gitOut = (folder: string, ...args: string[]): string => isolatedGitOut(['-C', folder, ...args], {base: allowedEnv(), env: {GIT_OPTIONAL_LOCKS: '0'}}).trim();

const gitAsTheAppReads = (folder: string, ...args: string[]): string => personalGitOut(['-C', folder, ...args], {base: allowedEnv()}).trim();

type Launched = {app: ElectronApplication; page: Page; startedAt: number};
type SeenRequest = {url: string; error: string | null};

/** Main's onBeforeRequest cancels every request outside the app origin. These listeners sit beside it and record each request it let through or cancelled. */
function watchRequests(app: ElectronApplication): Promise<void> {
  return app.evaluate(({session}) => {
    const seen: {url: string; error: string | null}[] = [];
    (globalThis as {seenRequests?: unknown}).seenRequests = seen;
    const filter = {urls: ['<all_urls>']};
    session.defaultSession.webRequest.onCompleted(filter, details => seen.push({url: details.url, error: null}));
    session.defaultSession.webRequest.onErrorOccurred(filter, details => seen.push({url: details.url, error: details.error}));
  });
}

const seenRequests = (app: ElectronApplication): Promise<SeenRequest[]> => app.evaluate(() => [...(globalThis as {seenRequests?: {url: string; error: string | null}[]}).seenRequests ?? []]);

function watchPage(page: Page, label: string, logFile: string): void {
  page.on('pageerror', error => unexpected.push(`${label}: ${error.message}`));
  page.on('dialog', dialog => { unexpected.push(`${label}: a ${dialog.type()} dialog opened with "${dialog.message()}"`); void dialog.dismiss(); });
  page.on('console', message => appendFileSync(logFile, `[page ${message.type()}] ${message.text()}\n`));
}

type LaunchOptions = {executable?: string; appEntry?: string; env?: Record<string, string>; dataDir?: string | null; readyFile?: string; source?: string};

/** Starts the app with `--open repository`, or with no repository when it is null. */
async function launch(label: string, repository: string | null, options: LaunchOptions = {}): Promise<Launched> {
  const appArgs = [...(repository === null ? [] : ['--open', repository]), ...(options.dataDir === null ? [] : ['--data-dir', options.dataDir ?? path.join(evidence, 'state', label)]), ...(options.readyFile ? ['--ready-file', options.readyFile] : []), ...(options.source ? ['--source', options.source] : [])];
  const startedAt = Date.now();
  const {executable} = options;
  const app = await _electron.launch({...(executable ? {executablePath: executable, args: appArgs} : {args: [options.appEntry ?? root, ...appArgs]}), cwd: root, env: appEnv(options.env), timeout: 30000});
  const pid = app.process().pid;
  assert(pid, 'the app process started');
  owned.add(pid);
  sampleOwnedDescendants(owned);
  const logFile = path.join(evidence, 'logs', `${label}.log`);
  app.process().stderr?.on('data', chunk => appendFileSync(logFile, chunk));
  app.process().stdout?.on('data', chunk => appendFileSync(logFile, chunk));
  await watchRequests(app);
  await isolateFromUser(app);
  const page = await app.firstWindow();
  watchPage(page, label, logFile);
  app.on('window', added => watchPage(added, `${label} (second window)`, logFile));
  log('launch', {label, pid, repository: repository && path.relative(root, repository), executable: executable ? path.relative(root, executable) : 'electron from node_modules'});
  return {app, page, startedAt};
}

/**
 * Keeps the keys and pointer of the person at the Mac away from the app under test. The harness focuses app windows, so keys and
 * clicks meant for another app can land in them: a Space scrolls the diff, and Space or Enter re-opens the focused file or
 * commit. Playwright's input reaches the page through the DevTools protocol, which passes neither Electron's
 * before-input-event nor the window's own mouse handling, so blocking both leaves only the harness's input. Main writes one
 * line per blocked key press to the app's log, without the key.
 */
function isolateFromUser(app: ElectronApplication): Promise<void> {
  return app.evaluate(({app: electronApp, BrowserWindow}) => {
    const guard = (window: InstanceType<typeof BrowserWindow>) => {
      window.setIgnoreMouseEvents(true);
      window.webContents.on('before-input-event', (event, input) => {
        event.preventDefault();
        if (input.type === 'keyDown') console.log('harness: blocked a key press from outside the harness');
      });
    };
    for (const window of BrowserWindow.getAllWindows()) guard(window);
    electronApp.on('browser-window-created', (_event, window) => guard(window));
  });
}

function close(launched: Launched): Promise<void> {
  sampleOwnedDescendants(owned);
  // Electron can take about 15 s to exit after quit (GPU process teardown), so most closes run in the background and cleanup waits for them.
  const closed = launched.app.close().catch(error => { cleanup.errors.push(error instanceof Error ? error.message : String(error)); });
  closing.push(closed);
  return closed;
}

/**
 * Records, in the page, each window focus and blur, key press, pointer event on the divider, diff-area scroll, file request
 * (`aria-busy`), diff panel swap, and file-list redraw, with the time since the journey started. A failed journey saves them
 * as logs/<label>-events.json.
 */
function recordPageEvents(page: Page): Promise<void> {
  return page.evaluate(() => {
    const started = performance.now(), events: unknown[] = [];
    (window as unknown as {harnessEvents: unknown[]}).harnessEvents = events;
    const note = (kind: string, detail: unknown = null) => events.push({ms: Math.round(performance.now() - started), kind, detail});
    const diff = document.getElementById('diff')!, files = document.getElementById('files')!;
    window.addEventListener('focus', () => note('window focus'));
    window.addEventListener('blur', () => note('window blur'));
    // Named keys and the brackets the harness presses are kept; any other character is not, in case it is someone's typing.
    const keyName = (key: string) => key === ' ' ? 'Space' : key.length > 1 || key === '[' || key === ']' ? key : 'a character';
    document.addEventListener('keydown', event => note('keydown', {key: keyName(event.key), target: (event.target as Element).id || (event.target as Element).tagName}), true);
    diff.addEventListener('scroll', () => note('diff scroll', {top: diff.scrollTop, max: diff.scrollHeight - diff.clientHeight}));
    const split = document.getElementById('pane-split')!;
    for (const kind of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture']) {
      window.addEventListener(kind, event => {
        const pointer = event as PointerEvent;
        if (pointer.target === split || kind !== 'pointermove') note(kind, {x: Math.round(pointer.clientX), y: Math.round(pointer.clientY), buttons: pointer.buttons, onDivider: pointer.target === split, divider: split.getAttribute('aria-valuenow')});
      }, true);
    }
    new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes') note('diff busy', diff.hasAttribute('aria-busy'));
        else note('diff panel', (diff.firstElementChild as HTMLElement | null)?.dataset.path ?? diff.firstElementChild?.className ?? null);
      }
    }).observe(diff, {childList: true, attributes: true, attributeFilter: ['aria-busy']});
    new MutationObserver(() => note('file list', [...files.querySelectorAll('.file')].map(node => `${node.getAttribute('data-path')} ${node.querySelector('.stat')?.textContent ?? ''}`))).observe(files, {childList: true});
  });
}

/**
 * Runs a journey on a fresh app and closes the app afterwards without waiting for it to exit. With `trace`, a Playwright
 * trace runs too; a failed journey keeps it as traces/<label>.zip, with its page events and a screenshot.
 */
async function withApp(label: string, repository: string | null, journey: (launched: Launched) => Promise<void>, options: LaunchOptions & {trace?: boolean} = {}): Promise<void> {
  const launched = await launch(label, repository, options);
  const {page} = launched;
  try {
    if (options.trace) {
      await recordPageEvents(page);
      await page.context().tracing.start({screenshots: true, snapshots: true});
    }
    await journey(launched);
    if (options.trace) await page.context().tracing.stop();
  } catch (error) {
    if (options.trace) {
      const kept = [
        page.context().tracing.stop({path: path.join(evidence, 'traces', `${label}.zip`)}),
        page.evaluate(() => (window as unknown as {harnessEvents?: unknown[]}).harnessEvents ?? []).then(events => writeFileSync(path.join(evidence, 'logs', `${label}-events.json`), JSON.stringify(events, null, 1) + '\n')),
        shot(page, `${label}-failed`),
      ];
      for (const result of await Promise.allSettled(kept)) if (result.status === 'rejected') cleanup.errors.push(`${label} failure evidence: ${String(result.reason)}`);
    }
    throw error;
  } finally { void close(launched); }
}

const shot = (page: Page, name: string) => page.screenshot({path: path.join(evidence, 'screens', `${name}.png`)});
const text = (page: Page, selector: string) => page.locator(selector).first().evaluate(node => (node as HTMLElement).innerText.replace(/\s+/g, ' ').trim());
const commitButton = (page: Page, subject: string) => page.locator('#commits .commit', {has: page.getByText(subject, {exact: true})});
const fileButton = (page: Page, file: string) => page.locator(`#files .file[data-path="${file.replace(/["\\]/g, '\\$&')}"]`);
const fileRows = (page: Page) => page.locator('#files .file').evaluateAll(nodes => nodes.map(node => `${node.querySelector('.chip')?.textContent} ${node.querySelector('.name')?.textContent}`));
const changeRows = (page: Page) => page.locator('#diff tr.chg').evaluateAll(nodes => nodes.map(node => [node.querySelector('td.cd.l')?.textContent, node.querySelector('td.cd.r')?.textContent]));
const sideLabels = async (page: Page) => (await page.locator('#diff thead th').allInnerTexts()).map(label => label.replace(/\s+/g, ' ').trim());

function waitForCommits(page: Page, count: number | null = null): Promise<unknown> {
  return page.waitForFunction(expected => {
    const shown = document.querySelectorAll('#commits .commit').length;
    return expected === null ? shown > 0 : shown === expected;
  }, count, {timeout: 30000});
}

/** Waits until the diff area shows `file` and no request for it is still open. */
function waitForFile(page: Page, file: string): Promise<unknown> {
  return page.waitForFunction(expected => document.querySelector('#diff > [data-path]')?.getAttribute('data-path') === expected && !document.getElementById('diff')!.hasAttribute('aria-busy'), file, {timeout: 30000});
}

async function openCommit(page: Page, subject: string, files: number): Promise<void> {
  await commitButton(page, subject).click();
  await page.waitForFunction(count => document.querySelectorAll('#files .file').length === count && document.querySelector('#diff > [data-path]') && !document.getElementById('diff')!.hasAttribute('aria-busy'), files, {timeout: 30000});
}

async function openFile(page: Page, file: string): Promise<void> {
  await fileButton(page, file).click();
  await waitForFile(page, file);
}

const waitForCard = (page: Page, title: string) => page.waitForFunction(expected => document.querySelector('#start .card h2')?.textContent === expected, title, {timeout: 30000});

/** Clicks inside the page and returns the milliseconds until `done` matches at least `min` elements and two frames have painted. */
function timedClick(page: Page, click: string, done: string, min: number): Promise<number> {
  return page.evaluate(async ({click, done, min}) => {
    const started = performance.now();
    const target = document.querySelector<HTMLElement>(click);
    if (!target) throw new Error(`Nothing to click at ${click}`);
    target.click();
    await new Promise<void>((resolve, reject) => {
      const tick = () => {
        if (document.querySelectorAll(done).length >= min) resolve();
        else if (performance.now() - started > 30000) reject(new Error(`${done} did not appear within the 30 s test watchdog.`));
        else requestAnimationFrame(tick);
      };
      tick();
    });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return performance.now() - started;
  }, {click, done, min});
}

type FileShown = {ms: number; rows: number; changes: number; colored: number};

/** Clicks a file row and returns the milliseconds until a new diff table for that file is in the page and two frames have painted. */
function timedFileClick(page: Page, file: string): Promise<FileShown> {
  return page.evaluate(async file => {
    const panel = () => document.querySelector<HTMLElement>('#diff > [data-path]');
    const before = panel();
    const started = performance.now();
    const button = [...document.querySelectorAll<HTMLElement>('#files .file')].find(node => node.dataset.path === file);
    if (!button) throw new Error(`No file row for ${file}`);
    button.click();
    await new Promise<void>((resolve, reject) => {
      const tick = () => {
        const now = panel();
        if (now && now !== before && now.dataset.path === file && now.querySelector('table.diff tbody tr')) resolve();
        else if (performance.now() - started > 30000) reject(new Error(`${file} did not show within the 30 s test watchdog.`));
        else requestAnimationFrame(tick);
      };
      tick();
    });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const shown = panel()!;
    return {ms: performance.now() - started, rows: shown.querySelectorAll('tbody tr').length, changes: shown.querySelectorAll('tr[data-kind="change"]').length, colored: shown.querySelectorAll('td.cd span[style*="--tl"]').length};
  }, file);
}

type Switch = {header: string | null; rail: string; panel: string | null; loading: boolean; firstLine: string | null};

/** Records, after every change inside the workspace, which file the header, the rail, and the diff area name. */
function watchFileSwitches(page: Page): Promise<void> {
  return page.evaluate(() => {
    const seen: Switch[] = [];
    (window as unknown as {fileSwitches: Switch[]}).fileSwitches = seen;
    const read = () => {
      const head = document.getElementById('file-head')!, panel = document.querySelector<HTMLElement>('#diff > [data-path]');
      seen.push({
        header: head.hidden ? null : head.querySelector('.path')?.textContent ?? null, rail: document.getElementById('rail-file')!.textContent ?? '',
        panel: panel?.dataset.path ?? null, loading: Boolean(panel?.querySelector('.loading-line')), firstLine: panel?.querySelector('tbody td.cd.r')?.textContent ?? null,
      });
    };
    new MutationObserver(read).observe(document.getElementById('workspace')!, {subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden']});
  });
}

const fileSwitches = (page: Page) => page.evaluate(() => (window as unknown as {fileSwitches: Switch[]}).fileSwitches);

async function expectOpenRepository(page: Page, label: string): Promise<void> {
  await waitForCommits(page);
  assert.equal(await text(page, '#commits-tab'), 'Commits 12', 'the Commits tab shows 12');
  assert.equal(await page.locator('#commits .commit').count(), 12);
  assert.equal(await page.locator('#commits .commit .subj').first().innerText(), NEWEST_SUBJECT, 'the newest commit is first');
  assert.equal(await page.locator('#repo-name').innerText(), 'practice');
  assert.equal(await page.locator('#branch').innerText(), 'main');
  assert.equal(await commitButton(page, HTML_SUBJECT).locator('.subj').innerText(), HTML_SUBJECT, 'the HTML subject shows as plain text');
  assert((await page.locator('#commits .commit .subj').allInnerTexts()).includes(ACCENTED_SUBJECT), `the subject "${ACCENTED_SUBJECT}" shows as UTF-8 text`);
  const created = {markup: await countMarkup(page), ...await page.evaluate(() => ({scripts: document.scripts.length, require: typeof (window as unknown as {require?: unknown}).require, process: typeof (window as unknown as {process?: unknown}).process}))};
  assert.deepEqual(created, {markup: 0, scripts: 1, require: 'undefined', process: 'undefined'}, 'no element was created from repository text and the page has no Node access');
  await shot(page, label);
  log('open-repository checks', {label, commits: 12, newest: NEWEST_SUBJECT});
}

/** Five launches; each records the page's own marks from the repository request to the painted commit list. */
async function measureCommitList(label: string, repository: string, includeStart: boolean): Promise<void> {
  const total = Number(gitOut(repository, 'rev-list', '--count', 'HEAD'));
  const expected = {rows: Math.min(total, 200), count: total > 200 ? '200+' : String(total)};
  const start: number[] = [], list: number[] = [];
  await calm(label);
  for (let sample = 1; sample <= SAMPLES; sample++) {
    const launched = await launch(`${label}-${sample}`, repository);
    try {
      const {page} = launched;
      await page.waitForFunction(() => performance.getEntriesByName('commits-shown').length > 0, null, {timeout: 30000});
      // Chromium adds paint entries after the frame is presented, which can trail the page's own marks.
      await page.waitForFunction(() => performance.getEntriesByType('paint').length > 0, null, {timeout: 10000});
      const marks = await page.evaluate(() => {
        const paints = performance.getEntriesByType('paint');
        const paint = paints.find(entry => entry.name === 'first-paint') ?? paints.find(entry => entry.name === 'first-contentful-paint');
        return {
          firstPaintEpoch: paint ? performance.timeOrigin + paint.startTime : null,
          listMs: performance.getEntriesByName('commits-shown')[0].startTime - performance.getEntriesByName('repository-requested')[0].startTime,
          rows: document.querySelectorAll('#commits .commit').length,
          count: document.getElementById('commit-count')?.textContent,
        };
      });
      assert.deepEqual({rows: marks.rows, count: marks.count}, expected, `${label}: the first page shows ${expected.rows} commits`);
      assert(marks.firstPaintEpoch, 'the window reported a first paint');
      start.push(marks.firstPaintEpoch - launched.startedAt);
      list.push(marks.listMs);
      if (sample === 1) await shot(page, `${label}-commits`);
    } finally { void close(launched); }
  }
  const scope = `Page asks main for the repository (mark repository-requested) to ${expected.rows} commit rows rendered and two frames painted (mark commits-shown). ${label === 'history' ? '250-commit history fixture' : `${repository}, ${total} commits`}.`;
  if (includeStart) timing('appStartToFirstPaintMs', null, start, 'Launch call in the harness (process spawn) to the window\'s first paint, read from the page\'s paint timing. Electron from node_modules, 250-commit history fixture.');
  timing(label === 'history' ? 'bar1CommitListMs' : 'bar1CommitListRealMs', BAR.commitList, list, scope);
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer().on('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => { if (address && typeof address === 'object') done(address.port); else fail(new Error('No free local port.')); });
    });
  });
}

/** Runs scripts/start from `cwd` and returns the window title once a repository has loaded, read from the app's local DevTools endpoint. */
async function startScriptTitle(label: string, cwd: string, open: string): Promise<string> {
  const port = await freePort();
  const child = spawn(path.join(root, 'scripts/start'), ['--open', open, '--data-dir', path.join(evidence, 'state', label), `--remote-debugging-port=${port}`], {cwd, env: allowedEnv(), stdio: ['ignore', 'pipe', 'pipe']});
  assert(child.pid, 'scripts/start started');
  owned.add(child.pid);
  const logFile = path.join(evidence, 'logs', `${label}.log`);
  child.stdout.on('data', chunk => appendFileSync(logFile, chunk));
  child.stderr.on('data', chunk => appendFileSync(logFile, chunk));
  const exited = new Promise(done => child.on('exit', done));
  try {
    for (const deadline = Date.now() + 60000; Date.now() < deadline;) {
      sampleOwnedDescendants(owned);
      if (child.exitCode !== null) throw new Error(`${label}: scripts/start exited ${child.exitCode} before a repository loaded; see logs/${label}.log`);
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json() as Promise<{type: string; title: string}[]>, () => []);
      const loaded = pages.find(page => page.type === 'page' && page.title.endsWith(TITLE_SUFFIX));
      if (loaded) return loaded.title;
      await sleep(250);
    }
    throw new Error(`${label}: no repository loaded within 60 s; see logs/${label}.log`);
  } finally {
    child.kill('SIGTERM');
    await Promise.race([exited, sleep(40000)]);
  }
}

async function expectStartScript(): Promise<void> {
  const relative = await startScriptTitle('start-relative', fixtures.practice, '.');
  const absolute = await startScriptTitle('start-absolute', root, fixtures.practice);
  const direct = spawnSync(ELECTRON, [root, '--open', 'practice', '--data-dir', path.join(evidence, 'state', 'electron-relative')], {cwd: path.dirname(fixtures.practice), env: allowedEnv(), encoding: 'utf8', timeout: 30000});
  observations.startScript = {
    expectedTitle: REPOSITORY_TITLE,
    relative: {ranFrom: path.relative(root, fixtures.practice), open: '.', title: relative},
    absolute: {ranFrom: '.', open: path.relative(root, fixtures.practice), title: absolute},
    electronWithRelativeOpen: {exit: direct.status, stderr: direct.stderr.trim().split('\n').filter(line => line.includes('--open'))},
  };
  log('scripts/start with relative and absolute --open', observations.startScript);
  assert.equal(relative, REPOSITORY_TITLE, 'scripts/start --open . run from inside the practice repository opens that repository');
  assert.equal(absolute, REPOSITORY_TITLE, 'scripts/start --open with the absolute path opens the same repository');
  assert.equal(direct.status, 1, 'Electron started directly with a relative --open exits 1');
  assert.match(direct.stderr, /--open needs an absolute folder path/, 'and says why');
}

/** Opens the 250-commit history fixture, clicks "Show older commits", and checks that the two pages hold every commit once, in git's order. */
async function expectOlderCommits(): Promise<void> {
  const expected = gitOut(fixtures.history, 'rev-list', 'HEAD').split('\n');
  const listState = async (page: Page) => ({count: await text(page, '#commit-count'), rows: await page.locator('#commits .commit').count(), olderButtons: await page.locator('#commits .more').count()});
  await withApp('older-commits', fixtures.history, async ({page}) => {
    await waitForCommits(page, 200);
    const firstPage = await listState(page);
    await page.locator('#commits .more').click();
    await waitForCommits(page, expected.length);
    const bothPages = await listState(page);
    const shown = await page.locator('#commits .commit').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-hash')));
    const firstMismatch = shown.findIndex((hash, index) => hash !== expected[index]);
    observations.olderCommits = {
      expected: {firstPage: {count: '200+', rows: 200, olderButtons: 1}, bothPages: {count: String(expected.length), rows: expected.length, olderButtons: 0}, order: 'git rev-list HEAD'},
      observed: {firstPage, bothPages, firstMismatch: firstMismatch === -1 ? null : {row: firstMismatch + 1, shown: shown[firstMismatch], expected: expected[firstMismatch]}},
    };
    await shot(page, 'older-commits');
    assert.deepEqual(firstPage, {count: '200+', rows: 200, olderButtons: 1}, 'the first page shows 200 commits, "200+", and "Show older commits"');
    assert.deepEqual(bothPages, {count: String(expected.length), rows: expected.length, olderButtons: 0}, `"Show older commits" adds the last ${expected.length - 200} commits and then goes away`);
    assert.deepEqual(shown, expected, 'the two pages list every commit once, in the order of git rev-list HEAD');
  });
}

async function openRepository(): Promise<void> {
  await withApp('open-repository', fixtures.practice, ({page}) => expectOpenRepository(page, 'open-repository'));
  await expectStartScript();
  await expectOlderCommits();
  await measureCommitList('history', fixtures.history, true);
  if (options.historyRepo) await measureCommitList('history-repo', options.historyRepo, false);
  else measurements.bar1CommitListRealMs = 'not measured: no --history-repo or DIFF_VIEWER_HISTORY_REPO given';
}

/** Clicks the newest commit and src/app.ts, and checks the side-by-side rows, the labels, the hidden-lines bar, and an empty line. */
async function expectCommitDiff(page: Page, repository: string, label: string): Promise<void> {
  await waitForCommits(page, 12);
  const [head, parent] = gitOut(repository, 'rev-parse', 'HEAD', 'HEAD~1').split('\n');
  assert.equal(await commitButton(page, NEWEST_SUBJECT).locator('.mono').innerText(), short(head), 'the newest commit row shows its short hash');
  await openCommit(page, NEWEST_SUBJECT, 4);
  const files = await fileRows(page);
  assert.deepEqual(files, ['A added.ts', 'M app.ts', 'R old-name.ts→new-name.ts', 'D remove-me.ts'], 'the newest commit lists its 4 files');
  await openFile(page, 'src/app.ts');
  assert.equal(await text(page, '#file-head .path'), 'src/app.ts');
  const changes = await changeRows(page);
  const expected = APP_CHANGES.map(change => fault === 'rows' ? [change.new, change.old] : [change.old, change.new]);
  for (const [left, right] of expected) {
    assert(changes.some(([l, r]) => l === left && r === right), `change row shows old text on the left and new text on the right: ${JSON.stringify([left, right])} in ${JSON.stringify(changes)}`);
  }
  assert.deepEqual(await sideLabels(page), [`Parent ${short(parent)}`, `Commit ${short(head)}`], 'the left side is the parent and the right side is the commit');
  const gaps = (await page.locator('#diff tr.gap').allInnerTexts()).map(value => value.replace(/\s+/g, ' ').trim());
  assert.deepEqual(gaps, ['Show 46 hidden lines lines 7 to 52'], 'the unchanged run between the two edits shows as one hidden-lines bar');
  const empty = await page.evaluate(() => {
    const row = (number: number) => [...document.querySelectorAll<HTMLElement>('#diff tbody tr[data-kind="context"]')].find(tr => tr.querySelector('td.ln.l')?.textContent === String(number));
    const cell = row(2)?.querySelector('td.cd.r');
    return {text: cell?.textContent, children: cell?.childNodes.length, fullHeight: Boolean(cell && cell.getBoundingClientRect().height >= parseFloat(getComputedStyle(cell).lineHeight))};
  });
  assert.deepEqual(empty, {text: '', children: 0, fullHeight: true}, 'line 2, an empty line that main sends with no tokens, shows as an empty row one full line high');
  await page.locator('#diff tr.gap button').click();
  const numbers = await page.locator('#diff tbody td.ln.r:not(.empty)').allTextContents();
  assert.deepEqual(numbers.map(Number), Array.from({length: 57}, (_, index) => index + 1), 'Show 46 hidden lines puts lines 7 to 52 in place, so the right side runs 1 to 57 without a gap');
  await shot(page, `${label}-app-ts`);
  log('newest commit and src/app.ts', {label, files, changes, gaps});
}

/** Bar 2: five commit clicks, each waiting for the first file's diff to settle before the next. */
async function measureFileList(page: Page, name: string, scope: string): Promise<void> {
  const hashes = await page.locator('#commits .commit').evaluateAll(nodes => nodes.slice(0, 5).map(node => (node as HTMLElement).dataset.hash!));
  const samples: number[] = [];
  await calm(name);
  for (const hash of hashes) {
    samples.push(await timedClick(page, `#commits .commit[data-hash="${hash}"]`, '#files .file', 1));
    await page.waitForFunction(() => !document.getElementById('diff')!.hasAttribute('aria-busy'), null, {timeout: 30000});
  }
  timing(name, BAR.fileList, samples, scope);
}

/**
 * Bar 3 on the 4,999-line TypeScript file edited in 50 places, after a click from the small file in the same commit.
 * The same clicks check that, at every change of the file header, the rail and the rows below it belong to the same file.
 */
async function measureBigFile(): Promise<void> {
  await withApp('bar3-big-file', fixtures.special, async ({page}) => {
    await waitForCommits(page, 3);
    await openCommit(page, SPECIAL_EDIT_SUBJECT, SPECIAL_EDIT_FILES);
    await waitForFile(page, BIG_FILE);
    await watchFileSwitches(page);
    await calm('bar3DiffMs');
    const samples: number[] = [];
    let shown: FileShown | null = null;
    for (let sample = 1; sample <= SAMPLES; sample++) {
      await timedFileClick(page, SMALL_FILE);
      shown = await timedFileClick(page, BIG_FILE);
      samples.push(shown.ms);
    }
    await shot(page, 'commit-diff-big-file');
    const contents = Object.fromEntries([BIG_FILE, SMALL_FILE].map(file => [file, gitOut(fixtures.special, 'show', `HEAD:${file}`)]));
    const mismatchedIn = (entries: Switch[]) => entries.filter(entry => entry.header !== entry.panel || entry.rail !== path.basename(entry.panel ?? '') || (entry.firstLine !== null && !contents[entry.panel ?? '']?.includes(entry.firstLine)));
    const switches = await fileSwitches(page);
    const named = switches.filter(entry => entry.header !== null);
    const mismatched = mismatchedIn(named);
    observations.fileSwitches = {recorded: switches.length, withHeader: named.length, loadingPanels: named.filter(entry => entry.loading).length, mismatched: mismatched.slice(0, 5)};
    assert.deepEqual(mismatched, [], 'at every change of the file header, the rail and the first row below it belong to the same file');
    await page.evaluate(file => { document.querySelector('#file-head .path')!.textContent = file; }, SMALL_FILE);
    const planted = mismatchedIn((await fileSwitches(page)).slice(switches.length));
    observations.fileSwitchesControl = {planted: `the harness wrote ${SMALL_FILE} into the header above ${BIG_FILE}`, expected: 1, observed: planted.length, record: planted[0] ?? null};
    assert.equal(planted.length, 1, 'positive control: the observer reports the one header the harness set to another file');
    assert(named.some(entry => entry.loading && entry.panel === BIG_FILE), 'the big file was slow enough to show its loading panel, so the check covered a slow diff');
    assert.equal(shown?.changes, BIG_FILE_EDITS, `the big file shows its ${BIG_FILE_EDITS} changed lines`);
    assert(shown && shown.colored > 1000, `the big file is highlighted (${shown?.colored} colored runs)`);
    observations.bar3BigFile = {file: BIG_FILE, rows: shown?.rows, changes: shown?.changes, coloredRuns: shown?.colored};
    timing('bar3DiffMs', BAR.fixtureDiff, samples, `Click on ${BIG_FILE} (4,999 lines, ${BIG_FILE_EDITS} edits, TypeScript) after ${SMALL_FILE} to the highlighted rows rendered and two frames painted, measured inside the page. The highlighter had already started on the commit's first file.`);
    // The densest file the size limits let through: 4,999 full lines of statements, exactly LARGE_FILE_BYTES bytes.
    await calm('bar3DenseDiffMs');
    const dense: number[] = [];
    let denseShown: FileShown | null = null;
    for (let sample = 1; sample <= SAMPLES; sample++) {
      await timedFileClick(page, SMALL_FILE);
      denseShown = await timedFileClick(page, DENSE_FILE);
      dense.push(denseShown.ms);
    }
    observations.bar3DenseFile = {file: DENSE_FILE, bytes: LARGE_FILE_BYTES, rows: denseShown?.rows, changes: denseShown?.changes, coloredRuns: denseShown?.colored};
    assert.equal(denseShown?.changes, 1, 'the dense file shows its one changed line');
    // One change shows 7 rows and the rest stays hidden, so about 20 colored runs per row are on screen.
    assert(denseShown && denseShown.colored > 50, `the dense file is highlighted (${denseShown?.colored} colored runs)`);
    timing('bar3DenseDiffMs', null, dense, `Recorded with no bar, because no size limit keeps dense code under bar 3: click on ${DENSE_FILE} (4,999 lines of statements, ${LARGE_FILE_BYTES} bytes, the size limit, 1 edit, TypeScript) after ${SMALL_FILE} to the highlighted rows rendered and two frames painted, measured inside the page.`);
  });
}

/** The largest file under the 5,000-line limit that has a highlighting language, and the newest commit (not a merge) that changed it. */
function largestHighlightedFile(repository: string): {file: string; lines: number; commit: string} {
  const counted = gitOut(repository, 'grep', '-I', '-c', '', 'HEAD', '--').split('\n').map(line => {
    const at = line.lastIndexOf(':');
    return {file: line.slice('HEAD:'.length, at), lines: Number(line.slice(at + 1))};
  });
  // The app hides a file over LARGE_FILE_BYTES too, so bar 3 measures only files under both limits.
  const sizes = harnessGit(['-C', repository, 'cat-file', '--batch-check=%(objectsize)'], {input: counted.map(entry => `HEAD:${entry.file}`).join('\n') + '\n', env: {GIT_OPTIONAL_LOCKS: '0'}});
  assert.equal(sizes.status, 0, `git cat-file --batch-check in ${repository}: ${sizes.stderr}`);
  const bytes = sizes.stdout.trim().split('\n').map(Number);
  const candidates = counted.filter((entry, index) => entry.lines < LARGE_FILE_LINES && bytes[index] < LARGE_FILE_BYTES && languageFor(entry.file) !== 'text').sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file));
  // The app hides a file when either version is too large, so the version before the measured commit must fit too.
  for (const entry of candidates) {
    const commit = gitOut(repository, 'log', '-1', '--no-merges', '--format=%H', 'HEAD', '--', entry.file);
    const before = harnessGit(['-C', repository, 'cat-file', '--batch-check=%(objectsize)'], {input: `${commit}^:${entry.file}\n`, env: {GIT_OPTIONAL_LOCKS: '0'}});
    const size = Number(before.stdout.trim());
    if (before.status === 0 && (Number.isNaN(size) || size < LARGE_FILE_BYTES)) return {...entry, commit};
  }
  assert.fail(`${repository} has no highlighted file under ${LARGE_FILE_LINES} lines and ${LARGE_FILE_BYTES} bytes in both versions`);
}

async function measureRealFile(repository: string): Promise<void> {
  const target = largestHighlightedFile(repository);
  await withApp('bar3-file-repo', repository, async ({page}) => {
    await waitForCommits(page);
    await page.locator('#paste').fill(target.commit.slice(0, 12));
    await page.locator('#paste').press('Enter');
    await page.waitForFunction(hash => document.querySelector('#commit-meta .mono')?.textContent === hash && document.querySelector('#diff > [data-path]') && !document.getElementById('diff')!.hasAttribute('aria-busy'), target.commit, {timeout: 30000});
    await calm('bar3DiffRealMs');
    const samples: number[] = [];
    let shown: FileShown | null = null;
    for (let sample = 1; sample <= SAMPLES; sample++) {
      shown = await timedFileClick(page, target.file);
      samples.push(shown.ms);
    }
    await shot(page, 'commit-diff-file-repo');
    observations.bar3FileRepo = {repository, ...target, rows: shown?.rows, changes: shown?.changes, coloredRuns: shown?.colored};
    assert(shown && shown.colored > 0, `${target.file} is highlighted`);
    timing('bar3DiffRealMs', BAR.diff, samples, `Click on ${target.file} (${target.lines} lines at HEAD) in commit ${short(target.commit)} of ${repository} to the highlighted rows rendered and two frames painted. The same file clicked 5 times.`);
  });
}

async function commitDiff(): Promise<void> {
  const launched = await launch('commit-diff', fixtures.practice);
  const {page} = launched;
  await page.context().tracing.start({screenshots: true, snapshots: true});
  try {
    await expectCommitDiff(page, fixtures.practice, 'commit-diff');
    await measureFileList(page, 'bar2FileListMs', 'Click on a commit row to its file list rendered and two frames painted, measured inside the page. Practice fixture, the 5 newest commits.');
  } finally {
    await page.context().tracing.stop({path: path.join(evidence, 'traces', 'commit-diff.zip')}).catch(error => cleanup.errors.push(String(error)));
    void close(launched);
  }
  await measureBigFile();
  if (options.historyRepo) {
    const repository = options.historyRepo;
    await withApp('bar2-history-repo', repository, async ({page}) => {
      await waitForCommits(page);
      await measureFileList(page, 'bar2FileListRealMs', `Click on a commit row to its file list rendered and two frames painted. ${repository}, the 5 newest commits.`);
    });
  } else measurements.bar2FileListRealMs = 'not measured: no --history-repo or DIFF_VIEWER_HISTORY_REPO given';
  if (options.fileRepo) await measureRealFile(options.fileRepo);
  else measurements.bar3DiffRealMs = 'not measured: no --file-repo or DIFF_VIEWER_FILE_REPO given';
}

async function specialFiles(): Promise<void> {
  const {practice, special} = fixtures;
  await withApp('special-files', practice, async ({page}) => {
    await waitForCommits(page, 12);
    await openCommit(page, 'Change the logo', 1);
    assert.equal(await text(page, '#diff .notice .big'), 'Binary file, not shown');
    assert.equal(await text(page, '#diff .notice .fact'), '256 bytes → 256 bytes', 'a binary file shows its old and new sizes');

    await openCommit(page, 'Add the generated table', 1);
    assert.match(await text(page, '#diff .notice'), new RegExp(`Large file hidden table\\.txt has ${TABLE_FILE_LINES.toLocaleString('en-US')} lines, over the 5,000-line limit\\.`), 'a file over 5,000 lines stays collapsed');
    await shot(page, 'special-files-large');
    const showAnyway: number[] = [];
    const tableHash = await commitButton(page, 'Add the generated table').getAttribute('data-hash');
    for (let sample = 1; sample <= SAMPLES; sample++) {
      if (sample > 1) await page.locator(`#commits .commit[data-hash="${tableHash}"]`).click();
      await page.locator('#show-large').waitFor({state: 'visible', timeout: 10000});
      showAnyway.push(await timedClick(page, '#show-large', '#diff tr[data-kind]', TABLE_FILE_LINES));
    }
    assert.equal(await page.locator('#diff tr[data-kind="change"]').count(), TABLE_FILE_LINES, '"Show anyway" shows every line of the 5,001-line file');
    timing('showAnyway5001Ms', null, showAnyway, 'Click on "Show anyway" for the added 5,001-line plain text file to 5,001 rows rendered and two frames painted. Bar 4 sets the limit, not a time.');

    await openCommit(page, NEWEST_SUBJECT, 4);
    await openFile(page, 'src/new-name.ts');
    assert.equal(await text(page, '#file-head .path'), 'src/old-name.ts→src/new-name.ts', 'a renamed file names its old and new path');
    assert.deepEqual(await changeRows(page), [['  return text.trim();', '  return text.trim().toLowerCase();']], 'the rename shows its content change');

    const merge = gitOut(practice, 'log', '--merges', '-1', '--format=%H');
    const [first, second] = gitOut(practice, 'rev-parse', `${merge}^1`, `${merge}^2`).split('\n');
    await openCommit(page, `Merge branch 'search'`, 1);
    assert.equal(await text(page, '#banner'), `Merge commit. Compared with first parent ${short(first)} (Fix a typo in the README). Second parent ${short(second)} is not shown.`);
    assert.deepEqual(await sideLabels(page), [`First parent ${short(first)}`, `Commit ${short(merge)}`]);
    assert.deepEqual(await fileRows(page), ['A search.ts'], 'the merge lists what it brought in against its first parent');
    await shot(page, 'special-files-merge');

    const rootCommit = gitOut(practice, 'rev-list', '--max-parents=0', 'HEAD');
    await openCommit(page, 'Start the notes app', 6);
    assert.equal(await text(page, '#banner'), 'First commit. It has no parent, so every file shows as added.');
    assert.deepEqual(await sideLabels(page), ['No parent', `Commit ${short(rootCommit)}`]);
    assert.deepEqual((await fileRows(page)).map(row => row[0]), ['A', 'A', 'A', 'A', 'A', 'A'], 'every file of the first commit is added');
  });
  await withApp('special-files-targets', special, async ({page}) => {
    await waitForCommits(page, 3);
    await openCommit(page, SPECIAL_TARGETS_SUBJECT, 3);
    assert.deepEqual(await fileRows(page), ['M link', 'M run.sh', 'M lib']);
    assert.equal(await text(page, '#diff .notice .big'), 'Symbolic link');
    assert.equal(await text(page, '#diff .notice .fact'), `${SYMLINK_TARGETS[0]} → ${SYMLINK_TARGETS[1]}`, 'a symlink shows its old and new target');
    await openFile(page, 'run.sh');
    assert.equal(await text(page, '#diff .notice .big'), 'File mode 100644 → 100755', 'a mode-only change names both modes');
    await openFile(page, 'vendor/lib');
    assert.equal(await text(page, '#diff .notice .big'), `Submodule: ${short(SUBMODULE_COMMITS[0])} → ${short(SUBMODULE_COMMITS[1])}`, 'a submodule shows its old and new commit');
    await shot(page, 'special-files-submodule');
  });
}

type Colors = {keyword: string | null; comment: string[]; commentText: string | null; added: {text: string; background: string} | null; removed: {text: string; background: string} | null; addWord: string; delWord: string; addLine: string; firstRow: string | null};

/** Computed colors in src/notes.ts: line 17 holds a keyword and a changed number, line 11 sits inside a block comment opened on line 1. */
function readColors(page: Page): Promise<Colors> {
  return page.evaluate(() => {
    const row = (number: number) => [...document.querySelectorAll<HTMLElement>('#diff tbody tr')].find(tr => tr.querySelector('td.ln.r')?.textContent === String(number))!;
    const tint = (variable: string) => {
      const probe = document.createElement('i');
      probe.style.setProperty('background', `var(${variable})`);
      document.body.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    };
    const word = (cell: Element | null) => {
      const mark = cell?.querySelector<HTMLElement>('.w');
      return mark ? {text: mark.textContent ?? '', background: getComputedStyle(mark).backgroundColor} : null;
    };
    const code = row(17), comment = row(11);
    const keyword = [...code.querySelectorAll('td.cd.r span')].find(span => span.textContent?.startsWith('export'));
    return {
      keyword: keyword ? getComputedStyle(keyword).color : null,
      comment: [...new Set([...comment.querySelectorAll('td.cd.r span')].map(span => getComputedStyle(span).color))],
      commentText: comment.querySelector('td.cd.r')?.textContent ?? null,
      added: word(code.querySelector('td.cd.r')), removed: word(code.querySelector('td.cd.l')),
      addWord: tint('--add-word'), delWord: tint('--del-word'), addLine: getComputedStyle(code.querySelector('td.cd.r')!).backgroundColor,
      firstRow: document.querySelector<HTMLElement>('#diff tbody tr')?.innerText.replace(/\s+/g, ' ').trim() ?? null,
    };
  });
}

async function setTheme(launched: Launched, theme: 'light' | 'dark'): Promise<void> {
  await launched.app.evaluate(({nativeTheme}, source) => { nativeTheme.themeSource = source; }, theme);
  await launched.page.waitForFunction(paper => getComputedStyle(document.body).backgroundColor === paper, rgb(PAPER[theme]), {timeout: 10000});
}

async function highlighting(): Promise<void> {
  await withApp('highlighting', fixtures.special, async launched => {
    const {page} = launched;
    // Playwright pins prefers-color-scheme to light; null hands it back to the system theme that nativeTheme sets.
    await page.emulateMedia({colorScheme: null});
    await setTheme(launched, 'light');
    await waitForCommits(page, 3);
    await openCommit(page, SPECIAL_EDIT_SUBJECT, SPECIAL_EDIT_FILES);
    await openFile(page, NOTES_FILE);
    const light = await readColors(page);
    await shot(page, 'highlighting-light');
    await setTheme(launched, 'dark');
    const dark = await readColors(page);
    await shot(page, 'highlighting-dark');
    observations.highlighting = {light, dark};
    assert.equal(light.firstRow, 'Show 7 hidden lines lines 1 to 7', 'the line that opens the block comment is outside the hunk');
    assert.equal(light.commentText, ' * const fresh = "not code";');
    assert.deepEqual(light.comment, [rgb(GITHUB.light.comment)], 'a line inside a block comment opened above the hunk is colored as a comment, not as code');
    assert.equal(light.keyword, rgb(GITHUB.light.keyword), 'the keyword export carries the github-light keyword color');
    assert.deepEqual(light.added, {text: '20', background: light.addWord}, 'the changed word on the new side carries the added-word tint');
    assert.deepEqual(light.removed, {text: '10', background: light.delWord}, 'the changed word on the old side carries the removed-word tint');
    assert.notEqual(light.addWord, light.addLine, 'the word tint differs from the changed line tint');
    assert.equal(dark.keyword, rgb(GITHUB.dark.keyword), 'in dark mode the keyword carries the github-dark keyword color');
    assert.deepEqual(dark.comment, [rgb(GITHUB.dark.comment)]);
    assert.deepEqual(dark.added, {text: '20', background: dark.addWord});
    assert.notEqual(dark.addWord, light.addWord, 'the word tint changes with the theme');
  });
}

/** Checks every place the practice repository's hostile text appears: subject, file name, file header, rail, and file content. */
async function expectHostileText(page: Page, label: string): Promise<void> {
  await waitForCommits(page, 12);
  await commitButton(page, HTML_SUBJECT).click();
  await waitForFile(page, HOSTILE_FILE);
  const shown = {
    subject: await text(page, '#subject'), listed: await text(page, '#files .file .name'), header: await text(page, '#file-head .path'),
    rail: await page.locator('#rail-file').textContent(), title: await page.title(), rows: await changeRows(page),
  };
  assert.deepEqual(shown, {
    subject: HTML_SUBJECT, listed: HOSTILE_FILE, header: HOSTILE_FILE, rail: HOSTILE_FILE, title: REPOSITORY_TITLE,
    rows: [['export const hostile = "<script>alert(1)</script>";', 'export const hostile = "<script>alert(2)</script>";']],
  }, 'the HTML subject, the hostile file name, and its content show as plain text');
  const created = {markup: await countMarkup(page), scripts: await page.evaluate(() => document.scripts.length)};
  assert.deepEqual(created, {markup: 0, scripts: 1}, 'no element was created from the hostile file name, subject, or content');
  await page.evaluate(() => document.getElementById('subject')!.append(document.createElement('img')));
  const planted = await countMarkup(page);
  await page.evaluate(() => document.querySelector('#subject img')!.remove());
  observations.markupCounter = {check: {expected: 0, observed: created.markup}, positiveControl: {planted: 'one <img> appended to #subject by the harness', expected: 1, observed: planted}};
  assert.equal(planted, 1, 'positive control: the same counter sees one <img> the harness put next to the subject');
  await shot(page, `${label}-hostile`);
  log('hostile text', {label, shown});
}

function mainAnswers(page: Page, until: {file: string} | {ms: number}): Promise<{ms: number; answers: number; longest: number}> {
  return page.evaluate(async until => {
    const started = performance.now(), answers: number[] = [];
    const finished = () => 'ms' in until ? performance.now() - started >= until.ms
      : document.querySelector<HTMLElement>('#diff > [data-path]')?.dataset.path === until.file && !document.getElementById('diff')!.hasAttribute('aria-busy');
    if ('file' in until) [...document.querySelectorAll<HTMLElement>('#files .file')].find(node => node.dataset.path === until.file)!.click();
    while (!finished()) {
      const asked = performance.now();
      await window.diffViewer.recent();
      answers.push(performance.now() - asked);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return {ms: performance.now() - started, answers: answers.length, longest: Math.max(...answers)};
  }, until);
}

async function expectSlowFile({app, page}: Launched): Promise<void> {
  const whileBusy = await mainAnswers(page, {file: SLOW_CPP_FILE});
  const colored = () => page.locator('#diff td.cd span[style*="--tl"]').count();
  const shown = {rows: await page.locator('#diff td.cd.r').allTextContents(), colored: await colored()};
  const probeStartedBeforeBlock = mainAnswers(page, {ms: 1500});
  await sleep(200);
  await app.evaluate((_electron, ms) => { const end = Date.now() + ms; while (Date.now() < end); }, MAIN_BLOCK_MS);
  const control = await probeStartedBeforeBlock;
  await mainAnswers(page, {file: HOSTILE_FILE});
  const coloredAfter = await colored();
  const stated = readFileSync(path.join(evidence, 'logs', 'hostile-text.log'), 'utf8').includes(`Highlighting ${SLOW_CPP_FILE} as cpp failed, shown as plain text: it took over 2000 ms`);
  observations.slowHighlight = {file: SLOW_CPP_FILE, whileBusy, shownRows: shown.rows.length, colored: shown.colored, coloredAfter, stated, positiveControl: {planted: `main blocked for ${MAIN_BLOCK_MS} ms by the harness`, longest: control.longest}};
  assert.deepEqual(shown, {rows: SLOW_CPP_LINES, colored: 0}, 'the slow file shows all its lines as plain text');
  assert.ok(whileBusy.ms >= 2000 && whileBusy.ms < 6000, `the slow file showed after the 2 s deadline and soon after it, in ${Math.round(whileBusy.ms)} ms`);
  assert.ok(whileBusy.answers >= 15, `main answered ${whileBusy.answers} times while the file highlighted, at least 15 expected`);
  assert.ok(whileBusy.longest < MAIN_ANSWER_MS, `main's longest answer while the file highlighted took ${Math.round(whileBusy.longest)} ms, under ${MAIN_ANSWER_MS} ms expected`);
  assert.ok(control.longest >= MAIN_ANSWER_MS, `positive control: the probe sees a blocked main (longest answer ${Math.round(control.longest)} ms)`);
  assert.ok(stated, `the app's log names the slow file and the deadline`);
  assert.ok(coloredAfter > 0, 'the next file has colors, so a fresh worker took over');
  await shot(page, 'hostile-text-slow-file');
}

async function expectQuitWhileSlow(): Promise<void> {
  const launched = await launch('hostile-text-quit', fixtures.practice);
  await waitForCommits(launched.page, 12);
  await commitButton(launched.page, HTML_SUBJECT).click();
  await waitForFile(launched.page, HOSTILE_FILE);
  await launched.page.evaluate(file => [...document.querySelectorAll<HTMLElement>('#files .file')].find(node => node.dataset.path === file)!.click(), SLOW_CPP_FILE);
  await sleep(500);
  const stillBusy = await launched.page.evaluate(() => document.getElementById('diff')!.hasAttribute('aria-busy'));
  const child = launched.app.process(), started = performance.now();
  await close(launched);
  observations.quitWhileSlow = {stillBusy, quitMs: round(performance.now() - started), exitCode: child.exitCode, signal: child.signalCode};
  assert.equal(stillBusy, true, 'the worker was still inside the slow file when the quit started');
  assert.equal(child.exitCode, 0, 'the app exited by itself after the quit');
}

async function hostileText(): Promise<void> {
  await withApp('hostile-text', fixtures.practice, async launched => {
    await expectHostileText(launched.page, 'hostile-text');
    await expectSlowFile(launched);
  });
  await expectQuitWhileSlow();
}

async function notARepository(): Promise<void> {
  const plain = realpathSync(mkdtempSync('/private/tmp/diff-viewer-plain-'));
  writeFileSync(path.join(plain, 'notes.txt'), 'A plain folder.\n');
  try {
    const dataDir = path.join(evidence, 'state', 'not-a-repository-first-run');
    mkdirSync(dataDir, {recursive: true});
    writeFileSync(path.join(dataDir, 'recent.json'), JSON.stringify([plain]));
    await withApp('not-a-repository-first-run', null, async ({page}) => {
      await waitForCard(page, 'Open a git repository');
      assert.match(await page.locator('#start .card p').first().innerText(), /It only reads the repository\. It never stages, edits, or commits\.$/, 'the first-run card claims no more than README "What the app reads and stores"');
      assert.equal(await page.evaluate(() => window.diffViewer.repository()), null, 'a window started without a repository gets null from repository()');
      assert.equal(await page.locator('#workspace').isHidden(), true);
      await page.locator('#start .recent button').waitFor();
      const listed = await page.locator('#start .recent button').evaluateAll(nodes => nodes.map(node => [...node.children].map(child => child.textContent)));
      assert.deepEqual(listed, [[path.basename(plain), plain]], 'the first-run screen lists the recent folder');
      await shot(page, 'not-a-repository-first-run');
      await page.locator('#start .recent button').click();
      await waitForCard(page, 'This folder is not a git repository');
      assert.equal(await text(page, '#start .err-box .mono'), plain);
      assert.equal(await page.locator('#start button', {hasText: 'Choose another folder…'}).count(), 1);
    }, {dataDir});
    await withApp('not-a-repository-open', plain, async ({page}) => {
      await waitForCard(page, 'This folder is not a git repository');
      assert.equal(await text(page, '#start .err-box .mono'), plain, 'the card names the folder');
      assert.deepEqual(await page.evaluate(() => window.diffViewer.repository()), {ok: false, error: {kind: 'notARepository', path: plain}}, 'repository() answers with the error, not null');
      await shot(page, 'not-a-repository-open');
    });
  } finally { rmSync(plain, {recursive: true, force: true}); }
}

async function recentRepositories(): Promise<void> {
  const dataDir = path.join(evidence, 'state', 'recent-repositories');
  const gone = path.join(evidence, 'fixtures-recent', 'gone');
  createPractice(gone);
  const opened = [gone, fixtures.special, fixtures.practice].map(folder => realpathSync(folder));
  assert(!existsSync(dataDir), 'the first start gets a --data-dir folder that does not exist yet');
  for (const [index, folder] of [gone, fixtures.special].entries()) {
    const launched = await launch(`recent-${index + 1}`, folder, {dataDir});
    try { await waitForCommits(launched.page); }
    finally { await close(launched); }
    if (index === 0) assert.deepEqual(JSON.parse(readFileSync(path.join(dataDir, 'recent.json'), 'utf8')), [opened[0]], 'the first start created its data folder and wrote recent.json');
  }
  rmSync(gone, {recursive: true, force: true});
  await withApp('recent-3', fixtures.practice, async ({page}) => {
    await waitForCommits(page, 12);
    assert.deepEqual(JSON.parse(readFileSync(path.join(dataDir, 'recent.json'), 'utf8')), [...opened].reverse(), 'recent.json lists the three repositories, newest first');
    await openCommit(page, 'Fix a typo in the README', 1);
    await openFile(page, 'README.md');
    await page.locator('#repo-button').click();
    await page.locator('#recent-menu').waitFor({state: 'visible'});
    const items = await page.locator('#recent-menu button').evaluateAll(nodes => nodes.map(node => ({name: node.querySelector('.name')?.textContent, path: node.querySelector('.path')?.textContent, current: Boolean(node.querySelector('.check'))})));
    assert.deepEqual(items, [...opened].reverse().map((folder, index) => ({name: path.basename(folder), path: folder, current: index === 0})), 'the menu lists every opened repository newest first and marks the open one');
    await shot(page, 'recent-repositories-menu');
    await page.locator('#recent-menu button', {hasText: 'gone'}).click();
    await waitForCard(page, 'This repository is no longer there');
    assert.equal(await text(page, '#start .err-box .mono'), opened[0], 'the card names the deleted repository');
    // Main drops the path before it answers the page, so the file is current once the card shows.
    assert.deepEqual(JSON.parse(readFileSync(path.join(dataDir, 'recent.json'), 'utf8')), [opened[2], opened[1]], 'choosing the deleted repository drops it from recent.json');
    await shot(page, 'recent-repositories-gone');
    await page.locator('#start button', {hasText: 'Back to practice'}).click();
    await page.locator('#workspace').waitFor({state: 'visible'});
    assert.equal(await page.locator('#start').isHidden(), true, '"Back to practice" hides the card');
    assert.match(await text(page, '#commits .commit[aria-current="true"]'), /Fix a typo in the README/, 'the same commit is still selected');
    await waitForFile(page, 'README.md');
  }, {dataDir});
}

async function darkMode(): Promise<void> {
  await withApp('dark-mode', fixtures.practice, async launched => {
    const {page} = launched;
    await page.emulateMedia({colorScheme: null});
    await setTheme(launched, 'light');
    await openCommit(page, NEWEST_SUBJECT, 4);
    await openFile(page, 'src/app.ts');
    const keyword = () => page.evaluate(() => {
      const span = [...document.querySelectorAll('#diff td.cd.r span')].find(node => node.textContent?.startsWith('export'));
      return span ? getComputedStyle(span).color : null;
    });
    await page.evaluate(() => { (window as unknown as {sameDocument: boolean}).sameDocument = true; });
    const before = await keyword();
    await setTheme(launched, 'dark');
    const dark = {keyword: await keyword(), ink: await page.evaluate(() => getComputedStyle(document.body).color), sameDocument: await page.evaluate(() => (window as unknown as {sameDocument?: boolean}).sameDocument)};
    await shot(page, 'dark-mode');
    await setTheme(launched, 'light');
    const after = await keyword();
    observations.darkMode = {before, dark, after};
    assert.equal(before, rgb(GITHUB.light.keyword));
    assert.deepEqual(dark, {keyword: rgb(GITHUB.dark.keyword), ink: rgb('#DDE6E0'), sameDocument: true}, 'switching the system to dark turns the window and the token colors dark without reloading the page');
    assert.equal(after, rgb(GITHUB.light.keyword), 'switching back restores the light colors');
  });
}

async function bareRepository(): Promise<void> {
  await withApp('bare-repository', fixtures.bare, async ({page}) => {
    await waitForCommits(page, 12);
    assert.deepEqual([await text(page, '#repo-name'), await text(page, '#branch'), await text(page, '#commits-tab')], ['practice.git', 'main', 'Commits 12'], 'a bare repository opens with its commits');
    await openCommit(page, NEWEST_SUBJECT, 4);
    await openFile(page, 'src/app.ts');
    const changes = await changeRows(page);
    for (const change of APP_CHANGES) assert(changes.some(([left, right]) => left === change.old && right === change.new), `the bare repository shows ${change.new}`);
    await shot(page, 'bare-repository');
  });
}

async function windowPerRepository(): Promise<void> {
  const dataDir = path.join(evidence, 'state', 'window-per-repository');
  mkdirSync(dataDir, {recursive: true});
  writeFileSync(path.join(dataDir, 'recent.json'), JSON.stringify([realpathSync(fixtures.special)]));
  await withApp('window-per-repository', fixtures.practice, async ({app, page}) => {
    await waitForCommits(page, 12);
    const opened = app.waitForEvent('window');
    await page.locator('#repo-button').click();
    await page.locator('#recent-menu button', {hasText: 'special'}).click();
    const second = await opened;
    await waitForCommits(second, 3);
    assert.deepEqual([await page.title(), await second.title(), app.windows().length], [REPOSITORY_TITLE, SPECIAL_TITLE, 2], 'a second repository opens in its own window and the first window keeps its repository');
    await app.evaluate(({BrowserWindow}) => {
      const focused: string[] = [];
      (globalThis as {focused?: string[]}).focused = focused;
      for (const window of BrowserWindow.getAllWindows()) window.on('focus', () => focused.push(window.getTitle()));
    });
    await second.locator('#repo-button').click();
    await second.locator('#recent-menu button', {hasText: 'practice'}).click();
    let focused: string[] = [];
    for (let tries = 0; tries < 20 && !focused.includes(REPOSITORY_TITLE); tries++) {
      await sleep(250);
      focused = await app.evaluate(() => (globalThis as {focused?: string[]}).focused ?? []);
    }
    observations.windowPerRepository = {windows: app.windows().length, focusEvents: focused};
    assert.equal(app.windows().length, 2, 'reopening the first repository opens no third window');
    assert(focused.includes(REPOSITORY_TITLE), `reopening the first repository focuses its window (focus events: ${JSON.stringify(focused)})`);
    assert.equal(await second.title(), SPECIAL_TITLE, 'the window that asked keeps its own repository');
    const practiceWindow = (title: string) => app.evaluate(({BrowserWindow}, title) => {
      const window = BrowserWindow.getAllWindows().find(candidate => candidate.getTitle() === title)!;
      return {minimized: window.isMinimized(), visible: window.isVisible(), focused: window.isFocused()};
    }, title);
    await app.evaluate(({BrowserWindow}, title) => BrowserWindow.getAllWindows().find(window => window.getTitle() === title)!.minimize(), REPOSITORY_TITLE);
    for (let tries = 0; tries < 20 && !(await practiceWindow(REPOSITORY_TITLE)).minimized; tries++) await sleep(250);
    const minimized = await practiceWindow(REPOSITORY_TITLE);
    await second.locator('#repo-button').click();
    await second.locator('#recent-menu button', {hasText: 'practice'}).click();
    let restored = await practiceWindow(REPOSITORY_TITLE);
    for (let tries = 0; tries < 20 && !(restored.visible && restored.focused && !restored.minimized); tries++) {
      await sleep(250);
      restored = await practiceWindow(REPOSITORY_TITLE);
    }
    observations.windowPerRepository = {...observations.windowPerRepository as object, minimized, restored, windowsAfterRestore: app.windows().length};
    assert.equal(minimized.minimized, true, 'the harness minimized the practice window');
    assert.deepEqual(restored, {minimized: false, visible: true, focused: true}, 'reopening a minimized repository restores, shows, and focuses its window');
    assert.equal(app.windows().length, 2, 'restoring opens no third window');
    await second.screenshot({path: path.join(evidence, 'screens', 'window-per-repository-second.png')});
  }, {dataDir});
}

const paneState = (page: Page) => page.evaluate(() => ({
  collapsed: document.getElementById('workspace')!.hasAttribute('data-collapsed'), pane: !document.getElementById('pane')!.hidden, rail: !document.getElementById('rail')!.hidden,
  split: document.getElementById('pane-split')!.getAttribute('aria-valuenow'), basis: document.getElementById('pane-bottom')!.style.getPropertyValue('flex-basis'),
}));

async function collapsePane(): Promise<void> {
  await withApp('collapse-pane', fixtures.practice, async ({page}) => {
    await waitForCommits(page, 12);
    await openCommit(page, NEWEST_SUBJECT, 4);
    const head = gitOut(fixtures.practice, 'rev-parse', 'HEAD');
    const divider = (await page.locator('#pane-split').boundingBox())!;
    await page.mouse.move(divider.x + 150, divider.y + 1);
    await page.mouse.down();
    await page.mouse.move(divider.x + 150, divider.y + 100, {steps: 5});
    await page.mouse.up();
    const dragged = await paneState(page);
    assert.notEqual(dragged.split, '55', 'dragging the divider moves it');
    const open = {collapsed: false, pane: true, rail: false, split: dragged.split, basis: `${dragged.split}%`};
    const closed = {...open, collapsed: true, pane: false, rail: true};
    await page.locator('#pane .side-btn').click();
    assert.deepEqual(await paneState(page), closed, 'the sidebar button collapses the pane to the rail');
    assert.deepEqual([await text(page, '#rail-source'), await text(page, '#rail-file'), await page.locator('#rail-info').getAttribute('title')],
      [short(head), 'added.ts', `Commit ${short(head)}, src/added.ts (file 1 of 4). Show sidebar (⌘B)`], 'the rail names the commit and the file');
    await shot(page, 'collapse-pane-rail');
    await page.keyboard.press('Meta+b');
    assert.deepEqual(await paneState(page), open, 'Command-B opens the pane with the divider where it was dragged');
    await page.keyboard.press('Meta+b');
    assert.deepEqual(await paneState(page), closed, 'Command-B collapses it again');
    await page.locator('#rail-info').click();
    assert.deepEqual(await paneState(page), open, 'clicking the rail opens the pane');
    await openCommit(page, 'Add the format helper', 1);
    assert.deepEqual(await paneState(page), open, 'the divider keeps its position after another commit is chosen');
  });
}

async function nextPreviousFile(): Promise<void> {
  await withApp('next-previous-file', fixtures.practice, async ({page}) => {
    await waitForCommits(page, 12);
    await openCommit(page, NEWEST_SUBJECT, 4);
    const steps: [string, string][] = [[']', 'src/app.ts'], [']', 'src/new-name.ts'], [']', 'src/remove-me.ts'], ['[', 'src/new-name.ts'], ['[', 'src/app.ts'], ['[', 'src/added.ts']];
    for (const [key, file] of steps) {
      await page.keyboard.press(key);
      await waitForFile(page, file);
    }
    await page.evaluate(() => {
      (window as unknown as {busy: number}).busy = 0;
      new MutationObserver(() => { (window as unknown as {busy: number}).busy++; }).observe(document.getElementById('diff')!, {attributes: true, attributeFilter: ['aria-busy']});
    });
    await page.keyboard.press('[');
    await sleep(300);
    assert.equal(await page.evaluate(() => (window as unknown as {busy: number}).busy), 0, '[ on the first file asks for nothing');
    await page.keyboard.press('Meta+b');
    await page.keyboard.press(']');
    await waitForFile(page, 'src/app.ts');
    assert.equal(await text(page, '#rail-file'), 'app.ts', '] works while the pane is collapsed, and the rail follows');
    await page.keyboard.press('Meta+b');
    assert.equal(await page.locator('#paste').getAttribute('placeholder'), 'Paste a commit hash, then press Return', 'the hash box says how to look up a pasted hash');
    await page.locator('#paste').click();
    await page.keyboard.type('][');
    await sleep(300);
    assert.deepEqual([await page.locator('#paste').inputValue(), await page.evaluate(() => (window as unknown as {busy: number}).busy), await text(page, '#file-head .path')],
      ['][', 2, 'src/app.ts'], 'typing ] and [ in the hash box types them and moves no file');
    await shot(page, 'next-previous-file');
  }, {trace: true});
  await withApp('next-previous-file-show-anyway', fixtures.step, async ({page}) => {
    await waitForCommits(page, 1);
    await openCommit(page, STEP_SUBJECT, 3);
    const head = short(gitOut(fixtures.step, 'rev-parse', 'HEAD'));
    const place = async () => [await text(page, '#file-head .path'), await page.locator('#rail-info').getAttribute('title')];
    const [large, next] = STEP_FILES;
    await page.locator('#show-large').click();
    await page.waitForFunction(() => document.querySelector('#diff > [data-path] table.diff') && !document.getElementById('diff')!.hasAttribute('aria-busy'), null, {timeout: 30000});
    assert.deepEqual(await place(), [large, `Commit ${head}, ${large} (file 1 of 3). Show sidebar (⌘B)`], 'after "Show anyway" the rail still places the large file as file 1 of 3');
    await page.keyboard.press(']');
    await waitForFile(page, next);
    assert.deepEqual(await place(), [next, `Commit ${head}, ${next} (file 2 of 3). Show sidebar (⌘B)`], '] after "Show anyway" opens the next file, and the rail reads file 2 of 3');
    await page.keyboard.press('[');
    await waitForFile(page, large);
    assert.deepEqual(await place(), [large, `Commit ${head}, ${large} (file 1 of 3). Show sidebar (⌘B)`], '[ goes back to the large file, file 1 of 3');
    assert.equal(await page.locator('#show-large').count(), 1, 'the large file is hidden again until "Show anyway"');
    await shot(page, 'next-previous-file-show-anyway');
  }, {trace: true});
}

const tabTexts = (page: Page) => page.locator('.tabs .tab:not([hidden])').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).innerText.replace(/\s+/g, ' ').trim()));
const LIST_SETTLED = '#files .file, #files .col-empty';

/** Waits until the file list holds `count` rows (the empty-list line for 0) and the diff area has settled. */
function waitForList(page: Page, count: number): Promise<unknown> {
  return page.waitForFunction(expected => {
    const settled = !document.getElementById('diff')!.hasAttribute('aria-busy');
    const rows = document.querySelectorAll('#files .file').length;
    return settled && (expected === 0 ? rows === 0 && Boolean(document.querySelector('#files .col-empty')) : rows === expected && Boolean(document.querySelector('#diff > [data-path]')));
  }, count, {timeout: 30000});
}

async function openTab(page: Page, tab: 'staged' | 'unstaged' | 'commits', files: number | null): Promise<void> {
  await page.locator(`#${tab}-tab`).click();
  if (files !== null) await waitForList(page, files);
}

/**
 * Moves the system focus away from the app window and back, as a switch to an editor and back does. Playwright emulates a
 * page that always has focus, which hides real focus changes from the page, so the emulation is turned off first. A try
 * counts only when main reports the window focused and the page saw a focus event; macOS does not always deliver one.
 */
async function refocus(app: ElectronApplication, page: Page, label: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setFocusEmulationEnabled', {enabled: false});
  await cdp.detach();
  await sleep(FOCUS_GAP_MS);
  const isFocused = () => app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].isFocused());
  const tries: {front: string | null; focusedBefore: boolean; focused: boolean; pageSawFocus: boolean; ms: number}[] = [];
  for (let attempt = 1; attempt <= FOCUS_TRIES; attempt++) {
    const front = frontAppName(), focusedBefore = await isFocused(), started = Date.now();
    await page.evaluate(() => {
      const seen = window as unknown as {harnessSawFocus: boolean};
      seen.harnessSawFocus = false;
      window.addEventListener('focus', () => { seen.harnessSawFocus = true; }, {once: true});
    });
    await app.evaluate(({BrowserWindow}) => {
      const [window] = BrowserWindow.getAllWindows();
      window.blur();
      window.focus();
    });
    let focused = false, pageSawFocus = false;
    while (!(focused && pageSawFocus) && Date.now() - started < FOCUS_WAIT_MS) {
      await sleep(50);
      [focused, pageSawFocus] = [await isFocused(), await page.evaluate(() => (window as unknown as {harnessSawFocus: boolean}).harnessSawFocus)];
    }
    tries.push({front, focusedBefore, focused, pageSawFocus, ms: Date.now() - started});
    if (focused && pageSawFocus) break;
  }
  ((observations.refocus ??= []) as unknown[]).push({label, tries});
  const last = tries[tries.length - 1];
  if (!(last.focused && last.pageSawFocus)) {
    throw new Error(`${label}: the window did not get focus after ${FOCUS_TRIES} tries of blur() and focus(). Front app now: ${frontAppName() ?? 'none named'}. `
      + `BrowserWindow.isFocused(): ${await isFocused()}. Tries: ${JSON.stringify(tries)}`);
  }
}

/** Git run by the harness, standing in for the user's own git, to change a fixture copy from outside the app. */
function outsideGit(folder: string, ...args: string[]): void {
  isolatedGitOut(['-C', folder, ...args], {base: allowedEnv()});
}

function editLines(file: string, edit: (lines: string[]) => string[]): void {
  writeFileSync(file, edit(readFileSync(file, 'utf8').replace(/\n$/, '').split('\n')).join('\n') + '\n');
}

const divider = (page: Page) => page.locator('#pane-split').getAttribute('aria-valuenow');

/** Marks the diff panel on screen, so the harness can tell whether a refresh replaced it. */
const markPanel = (page: Page) => page.evaluate(() => { (document.querySelector('#diff > [data-path]') as unknown as {harnessMark: boolean}).harnessMark = true; });
const panelMarked = (page: Page) => page.evaluate(() => Boolean((document.querySelector('#diff > [data-path]') as unknown as {harnessMark?: boolean} | null)?.harnessMark));
const diffScroll = (page: Page) => page.evaluate(() => { const area = document.getElementById('diff')!; return {top: area.scrollTop, max: area.scrollHeight - area.clientHeight}; });

const listedPaths = async (page: Page) => (await page.locator('#files .file').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-path') ?? ''))).sort();

/** Git's own staged and unstaged path lists, read the way AGENTS.md rule 2 allows, for comparison with the app's tabs. */
function gitWorkingPaths(repository: string): {staged: string[]; unstaged: string[]} {
  const fields = gitAsTheAppReads(repository, 'diff-index', '--cached', '-M', '--ita-invisible-in-index', '--name-status', '-z', 'HEAD').split('\0').filter(Boolean);
  const staged: string[] = [];
  for (let index = 0; index < fields.length;) {
    const letter = fields[index++][0];
    if (letter === 'R' || letter === 'C') index++;
    const file = fields[index++];
    if (letter !== 'U') staged.push(file);
  }
  const tracked = gitAsTheAppReads(repository, 'diff-files', '--numstat', '-z').split('\0').filter(Boolean).map(record => record.split('\t').slice(2).join('\t'));
  const untracked = gitAsTheAppReads(repository, 'ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean).map(file => file.replace(/\/$/, ''));
  return {staged: staged.sort(), unstaged: [...new Set([...tracked, ...untracked])].sort()};
}

/**
 * Bar 2 for the staged and unstaged lists: five clicks on each tab, alternating, each until the list or its empty line is
 * painted. Then each tab's paths are compared with git's own listing.
 */
async function measureWorkingLists(page: Page, label: string, repository: string, scope: string): Promise<void> {
  const staged: number[] = [], unstaged: number[] = [];
  const git = gitWorkingPaths(repository);
  // A bar timed on an empty list says so, so a real repository with no changes does not stand for a long list.
  const listed = (count: number) => count ? `The list held ${count} ${count === 1 ? 'file' : 'files'}.` : 'Measured on an empty list: the repository had no such changes.';
  if (!label) assert(git.staged.length > 0 && git.unstaged.length > 0, 'the practice fixture has staged and unstaged files, so bar 2 is timed on lists that are not empty');
  await calm(`bar2WorkingLists${label}`);
  for (let sample = 1; sample <= SAMPLES; sample++) {
    for (const [tab, samples] of [['staged', staged], ['unstaged', unstaged]] as const) {
      samples.push(await timedClick(page, `#${tab}-tab`, LIST_SETTLED, 1));
      await page.waitForFunction(() => !document.getElementById('diff')!.hasAttribute('aria-busy'), null, {timeout: 30000});
    }
  }
  timing(`bar2StagedList${label}Ms`, BAR.fileList, staged, `Click on the Staged tab to its file list (or "No staged changes") rendered and two frames painted, measured inside the page. ${scope} ${listed(git.staged.length)}`);
  timing(`bar2UnstagedList${label}Ms`, BAR.fileList, unstaged, `Click on the Unstaged tab to its file list (or "No unstaged changes") rendered and two frames painted, measured inside the page. ${scope} ${listed(git.unstaged.length)}`);
  const shown: Record<string, string[]> = {};
  for (const tab of ['staged', 'unstaged'] as const) {
    await page.locator(`#${tab}-tab`).click();
    await page.waitForFunction(settled => Boolean(document.querySelector(settled)) && !document.getElementById('diff')!.hasAttribute('aria-busy'), LIST_SETTLED, {timeout: 30000});
    shown[tab] = await listedPaths(page);
  }
  ((observations.workingListsMatchGit ??= {}) as Record<string, unknown>)[label || 'Fixture'] = {staged: git.staged.length, unstaged: git.unstaged.length};
  assert.deepEqual(shown, git, `${label || 'fixture'}: the Staged and Unstaged tabs list the same paths as git diff-index --cached, git diff-files --numstat, and git ls-files --others`);
}

async function workingChanges(): Promise<void> {
  // Bar 2 runs first, so its numbers exist even when a later focus step fails.
  await withApp('working-changes-bar2', fixtures.practice, async ({page}) => {
    await waitForCommits(page, 12);
    await measureWorkingLists(page, '', fixtures.practice, 'Practice fixture: 2 staged files; 2 unstaged files, one untracked, and one stat-dirty file git must re-read.');
  });
  for (const [label, repository] of [['HistoryRepo', options.historyRepo], ['FileRepo', options.fileRepo]] as const) {
    if (!repository) { measurements[`bar2WorkingLists${label}Ms`] = `not measured: no ${label === 'HistoryRepo' ? '--history-repo' : '--file-repo'} given`; continue; }
    await withApp(`working-changes-${label}`, repository, async ({page}) => {
      await waitForCommits(page);
      await measureWorkingLists(page, label, repository, `${repository}, opened read-only.`);
    });
  }
  const repository = path.join(evidence, 'fixtures-working', 'practice');
  createPractice(repository);
  await withApp('working-changes', repository, async ({app, page}) => {
    await waitForCommits(page, 12);
    assert.deepEqual(await tabTexts(page), ['Staged 2', 'Unstaged 2', 'Commits 12'], 'the tabs Staged, Unstaged, and Commits show their counts');
    const box = (await page.locator('#pane-split').boundingBox())!;
    await page.mouse.move(box.x + 150, box.y + 1);
    await page.mouse.down();
    await page.mouse.move(box.x + 150, box.y + 80, {steps: 5});
    await page.mouse.up();
    const dragged = await divider(page);
    assert.notEqual(dragged, '55', 'dragging the divider moves it');

    await openTab(page, 'staged', 2);
    assert.deepEqual(await fileRows(page), ['M README.md', 'A staged-new.ts'], 'Staged lists the 2 staged files');
    assert.deepEqual([await text(page, '#selection'), await text(page, '#subject'), await text(page, '#commit-meta')],
      ['Staged · 2 files', 'Staged changes', '2 files ready for the next commit Last commit compared with what is staged'], 'the staged summary');
    assert.equal(await text(page, '#working-panel'), '2 files +2−0 Last commit compared with what is staged. Refresh', 'the Staged tab\'s panel');
    assert.deepEqual(await sideLabels(page), ['Last commit', 'Staged'], 'staged column labels');
    assert.deepEqual(await page.locator('#diff tr.add td.cd.r').allTextContents(), ['Staged line.'], 'README.md shows its staged line');
    assert.equal(await divider(page), dragged, 'the divider keeps its place on the Staged tab');
    await shot(page, 'working-changes-staged');
    await page.keyboard.press(']');
    await waitForFile(page, 'src/staged-new.ts');
    await page.keyboard.press('[');
    await waitForFile(page, 'README.md');

    await openTab(page, 'unstaged', 2);
    assert.deepEqual(await fileRows(page), ['M CHANGELOG.md', 'A todo.txt'], 'Unstaged lists the edited file and the untracked file; src/format.ts, touched but unchanged, is not listed');
    assert.equal(await fileButton(page, 'notes/todo.txt').locator('.tag').innerText(), 'untracked');
    assert.deepEqual([await text(page, '#subject'), await text(page, '#commit-meta')], ['Unstaged changes', '2 files changed, 1 untracked Staged or committed files compared with the working folder']);
    assert.deepEqual(await sideLabels(page), ['Staged or last commit', 'Working folder']);
    await page.keyboard.press(']');
    await waitForFile(page, 'notes/todo.txt');
    assert.deepEqual([await sideLabels(page), await text(page, '#file-head .word'), await page.locator('#diff tr.add td.cd.r').allTextContents()],
      [['Not in git yet', 'Working folder'], 'Untracked, new file', ['Untracked note.']], 'an untracked file shows as new');
    assert.equal(await divider(page), dragged, 'the divider keeps its place on the Unstaged tab');
    await shot(page, 'working-changes-unstaged');

    const appFile = path.join(repository, 'src/app.ts');
    editLines(appFile, rows => rows.map((row, index) => index === 2 || index === 54 ? `${row} // edited outside` : row));
    await refocus(app, page, 'working-changes outside edit');
    await page.waitForFunction(() => document.getElementById('unstaged-count')?.textContent === '3' && document.querySelectorAll('#files .file').length === 3, null, {timeout: 30000});
    assert.equal(await text(page, '#file-head .path'), 'notes/todo.txt', 'a focus refresh after an outside edit lists the edited file and keeps the open one');
    await openFile(page, 'src/app.ts');
    await page.locator('#diff tr.gap button').first().click();
    await page.evaluate(() => { document.getElementById('diff')!.scrollTop = 250; });
    const before = await diffScroll(page);
    assert(before.top > 0, `the expanded app.ts scrolls (scroll ${JSON.stringify(before)})`);
    await markPanel(page);
    appendFileSync(path.join(repository, 'notes/todo.txt'), 'Second note.\n');
    await refocus(app, page, 'working-changes unchanged open file');
    await page.waitForFunction(() => document.querySelector('#files .file[data-path="notes/todo.txt"] .stat')?.textContent === '+2−0', null, {timeout: 30000});
    await page.waitForFunction(() => !document.getElementById('diff')!.hasAttribute('aria-busy'), null, {timeout: 30000});
    const unchanged = {marked: await panelMarked(page), scroll: (await diffScroll(page)).top, gaps: await page.locator('#diff tr.gap').count(), file: await text(page, '#file-head .path')};
    assert.deepEqual(unchanged, {marked: true, scroll: before.top, gaps: 0, file: 'src/app.ts'}, 'a refresh that leaves the open file as it was keeps the same rows, the expanded lines, and the scroll position');

    editLines(appFile, rows => [...rows, ...Array.from({length: 60}, (_, index) => `export const added${index} = ${index};`)]);
    await page.locator('#refresh').click();
    await page.waitForFunction(() => document.querySelector('#files .file[data-path="src/app.ts"] .stat')?.textContent === '+62−2', null, {timeout: 30000});
    await page.waitForFunction(() => !document.getElementById('diff')!.hasAttribute('aria-busy'), null, {timeout: 30000});
    const after = {marked: await panelMarked(page), scroll: await diffScroll(page), file: await text(page, '#file-head .path'), added: await page.locator('#diff tr.add').count()};
    observations.workingRefresh = {before, unchanged, after};
    assert.deepEqual([after.marked, after.file, after.added], [false, 'src/app.ts', 60], 'the Refresh button shows the open file\'s new diff');
    assert(after.scroll.max >= before.top && after.scroll.top === before.top, `the new diff of the open file keeps the scroll position (${JSON.stringify(after.scroll)}, wanted top ${before.top})`);
    await shot(page, 'working-changes-refreshed');

    const todo = path.join(repository, 'notes/todo.txt'), todoMode = statSync(todo).mode & 0o777;
    chmodSync(todo, 0);
    await page.locator('#refresh').click();
    await page.waitForFunction(() => document.querySelector('#files .file[data-path="notes/todo.txt"] .stat')?.textContent === 'not counted', null, {timeout: 30000});
    await page.waitForFunction(() => !document.getElementById('diff')!.hasAttribute('aria-busy'), null, {timeout: 30000});
    const unreadable = {notices: await page.locator('#diff .notice').count(), file: await text(page, '#file-head .path'), added: await page.locator('#diff tr.add').count()};
    assert.deepEqual(unreadable, {notices: 0, file: 'src/app.ts', added: 60}, 'an unreadable untracked file leaves the list working: src/app.ts stays open with its 60 added rows');
    await fileButton(page, 'notes/todo.txt').click();
    await page.waitForFunction(() => document.querySelector('#diff .notice .big')?.textContent === 'This file could not be read', null, {timeout: 30000});
    chmodSync(todo, todoMode);
    appendFileSync(todo, 'Third note.\n');
    await page.locator('#refresh').click();
    await page.waitForFunction(() => document.querySelector('#files .file[data-path="notes/todo.txt"] .stat')?.textContent === '+3−0', null, {timeout: 30000});
    await page.waitForFunction(() => !document.getElementById('diff')!.hasAttribute('aria-busy'), null, {timeout: 30000});
    const recovered = {notices: await page.locator('#diff .notice').count(), file: await text(page, '#file-head .path'), added: await page.locator('#diff tr.add').count()};
    observations.workingUnreadable = {unreadable, recovered};
    assert.deepEqual(recovered, {notices: 0, file: 'notes/todo.txt', added: 3}, 'a Refresh after the unreadable untracked file is readable again shows that open file\'s diff and no error notice');

    // A refresh that fails on the Unstaged tab: with .git/index unreadable, git cannot list the unstaged files.
    const index = path.join(repository, '.git/index'), indexMode = statSync(index).mode & 0o777;
    chmodSync(index, 0);
    await page.locator('#refresh').click();
    await page.waitForFunction(() => document.querySelector('#diff .notice .big')?.textContent === 'Git could not read this repository', null, {timeout: 30000});
    const failedRefresh = {notice: await text(page, '#diff .notice .big'), added: await page.locator('#diff tr.add').count()};
    chmodSync(index, indexMode);
    await page.locator('#refresh').click();
    // Without the recovery the error notice stays, so this wait ends by timeout and the assertion below names what is on screen.
    await page.waitForFunction(() => !document.querySelector('#diff .notice') && document.querySelectorAll('#diff tr.add').length === 3 && !document.getElementById('diff')!.hasAttribute('aria-busy'), null, {timeout: 10000}).catch(() => undefined);
    const afterFailedRefresh = {notices: await page.locator('#diff .notice').count(), file: await text(page, '#file-head .path'), added: await page.locator('#diff tr.add').count()};
    observations.workingRefreshFailure = {during: failedRefresh, after: afterFailedRefresh};
    assert.deepEqual(afterFailedRefresh, {notices: 0, file: 'notes/todo.txt', added: 3}, 'on the Unstaged tab, a Refresh after .git/index is readable again shows the open file\'s diff and removes the error');

    outsideGit(repository, 'reset', '--quiet', '--hard');
    outsideGit(repository, 'clean', '--quiet', '-fd');
    await page.locator('#working-panel button').click();
    await waitForList(page, 0);
    assert.deepEqual([await tabTexts(page), await text(page, '#files .col-empty'), await text(page, '#diff .notice .big'), await text(page, '#commit-meta')],
      [['Staged 0', 'Unstaged 0', 'Commits 12'], 'No unstaged changes.', 'No unstaged changes', 'Nothing changed Staged or committed files compared with the working folder'], 'a clean working folder');
    await shot(page, 'working-changes-clean');
    await openTab(page, 'staged', 0);
    assert.deepEqual([await text(page, '#files .col-empty'), await text(page, '#diff .notice .big')], ['No staged changes.', 'No staged changes']);
    await openTab(page, 'commits', null);
    await page.waitForFunction(() => document.querySelector('#diff .notice .big')?.textContent === 'Choose a commit', null, {timeout: 10000});
    assert.deepEqual([await divider(page), await page.locator('#commit-panel').isVisible()], [dragged, true], 'back on Commits, the divider is where it was dragged');

    let untracked = 0;
    /** What the diff area shows: its notice, the open file, and the change rows. */
    const diffShown = async () => ({
      ...await page.evaluate(() => ({
        notice: document.querySelector('#diff .notice .big')?.textContent ?? null,
        file: document.getElementById('file-head')!.hidden ? null : (document.querySelector('#file-head .path') as HTMLElement).innerText,
      })),
      rows: await changeRows(page),
    });
    /**
     * Makes .git/index unreadable for one Refresh: the Staged and Unstaged counts turn to "?" while the Commits tab keeps
     * its view. Then restores it, adds an untracked file so the next Refresh shows it worked, and returns both views.
     */
    const failThenRecover = async () => {
      chmodSync(index, 0);
      await page.locator('#refresh').click();
      await page.waitForFunction(() => document.getElementById('staged-count')?.textContent === '?' && document.getElementById('unstaged-count')?.textContent === '?'
        && !document.getElementById('diff')!.hasAttribute('aria-busy') && !document.getElementById('refresh')!.hasAttribute('aria-busy'), null, {timeout: 30000});
      const during = await diffShown();
      chmodSync(index, indexMode);
      writeFileSync(path.join(repository, `after-error-${++untracked}.txt`), 'Written after the failed refresh.\n');
      await page.locator('#refresh').click();
      await page.waitForFunction(expected => document.getElementById('unstaged-count')?.textContent === expected, String(untracked), {timeout: 30000});
      // The tab's own redraw follows the new counts; without it an error notice stays, so this wait ends by timeout and the assertion below names what is on screen.
      await page.waitForFunction(() => !document.querySelector('#diff .notice .err-box') && !document.getElementById('diff')!.hasAttribute('aria-busy'), null, {timeout: 10000}).catch(() => undefined);
      return {during, after: await diffShown()};
    };
    const chooseCommit = {notice: 'Choose a commit', file: null, rows: []};
    assert.deepEqual(await failThenRecover(), {during: chooseCommit, after: chooseCommit},
      'on the Commits tab with no commit chosen, an unreadable .git/index leaves "Choose a commit" with no error, before and after it is readable again');
    await openCommit(page, NEWEST_SUBJECT, 4);
    await openFile(page, 'src/app.ts');
    const commitRows = await changeRows(page);
    assert(commitRows.length > 0, 'the newest commit\'s src/app.ts has change rows');
    const {during: commitDuring, after: recoveredCommit} = await failThenRecover();
    assert.equal(commitDuring.notice, 'Git could not read this repository', 'on the Commits tab with a commit open, Refresh shows git\'s error while .git/index is unreadable, because git diff-tree reads the index');
    assert.deepEqual(recoveredCommit, {notice: null, file: 'src/app.ts', rows: commitRows},
      'on the Commits tab with a commit open, a Refresh after .git/index is readable again shows the open file\'s diff and no error notice');
    await shot(page, 'working-changes-commit-recovered');

    // Sub-feature 7: a merge conflict, built with the user's own git on the harness's copy, shows once in Unstaged with "U" and a notice.
    const identity = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid'];
    const readme = path.join(repository, 'README.md');
    outsideGit(repository, 'branch', 'conflict-side');
    writeFileSync(readme, '# Notes\n\nMain side.\n');
    outsideGit(repository, ...identity, 'commit', '--quiet', '-m', 'Main side', '--', 'README.md');
    outsideGit(repository, 'checkout', '--quiet', 'conflict-side');
    writeFileSync(readme, '# Notes\n\nOther side.\n');
    outsideGit(repository, ...identity, 'commit', '--quiet', '-m', 'Other side', '--', 'README.md');
    outsideGit(repository, 'checkout', '--quiet', 'main');
    assert.throws(() => outsideGit(repository, ...identity, 'merge', '--quiet', 'conflict-side'), /exited 1/, 'the merge stops on a conflict');
    assert.equal(gitOut(repository, 'ls-files', '--unmerged', '--', 'README.md').split('\n').length, 3, 'git holds README.md as unmerged');
    await page.locator('#refresh').click();
    await openTab(page, 'staged', 0);
    await openTab(page, 'unstaged', untracked + 1);
    assert.deepEqual((await fileRows(page)).sort(), ['A after-error-1.txt', 'A after-error-2.txt', 'U README.md'], 'the conflicted file is one Unstaged row with the chip "U"');
    await openFile(page, 'README.md');
    const conflict = {word: await text(page, '#file-head .word'), banner: await text(page, '#diff .banner'), markers: await page.locator('#diff td.cd.r', {hasText: '<<<<<<< HEAD'}).count()};
    assert.deepEqual(conflict, {word: 'Unmerged, has a merge conflict', markers: 1,
      banner: 'This file has a merge conflict. Left: your side before the merge. Right: the working folder, with the conflict markers.'}, 'the conflicted file shows its notice and the conflict markers');
    observations.workingConflict = conflict;
    await shot(page, 'working-changes-conflict');
    outsideGit(repository, 'merge', '--abort');
    await page.locator('#refresh').click();
    await waitForList(page, untracked);
    assert.deepEqual((await fileRows(page)).sort(), ['A after-error-1.txt', 'A after-error-2.txt'], 'after the merge is aborted, the conflict row is gone');
  }, {trace: true});
}

async function repositoryRemoved(): Promise<void> {
  const moved = path.join(evidence, 'fixtures-removed', 'moved'), deleted = path.join(evidence, 'fixtures-removed', 'deleted');
  createPractice(moved);
  createPractice(deleted);
  await withApp('repository-removed-moved', moved, async ({page}) => {
    await waitForCommits(page, 12);
    await openTab(page, 'unstaged', 2);
    const shownPath = realpathSync(moved);
    renameSync(moved, `${moved}-elsewhere`);
    await page.locator('#refresh').click();
    await waitForCard(page, 'This repository is no longer there');
    assert.equal(await text(page, '#start .err-box .mono'), shownPath, 'the Refresh button after a move shows the card with the old path');
    await shot(page, 'repository-removed-moved');
  });
  await withApp('repository-removed-deleted', deleted, async ({app, page}) => {
    await waitForCommits(page, 12);
    await openCommit(page, NEWEST_SUBJECT, 4);
    const shownPath = realpathSync(deleted);
    rmSync(deleted, {recursive: true, force: true});
    await refocus(app, page, 'repository-removed deleted');
    await waitForCard(page, 'This repository is no longer there');
    assert.equal(await text(page, '#start .err-box .mono'), shownPath, 'a focus refresh after a delete shows the card');
    await shot(page, 'repository-removed-deleted');
  });
}

/** Writes a `git` on PATH that appends each argument list to `log` and runs the real git. */
function gitRecorder(folder: string): {dir: string; log: string} {
  const real = realGit();
  mkdirSync(folder, {recursive: true});
  const log = path.join(folder, 'calls.bin');
  writeFileSync(path.join(folder, 'git'), `#!/bin/sh\nprintf '%s\\0' "$#" "$@" >> '${log}'\nexec '${real}' "$@"\n`, {mode: 0o755});
  writeFileSync(log, '');
  return {dir: folder, log};
}

/** The git command of each recorded call: the first word after the global options. */
function recordedCommands(log: string): string[] {
  const fields = readFileSync(log, 'utf8').split('\0');
  const commands: string[] = [];
  for (let index = 0; index < fields.length - 1;) {
    const args = fields.slice(index + 1, index + 1 + Number(fields[index]));
    index += 1 + args.length;
    let at = 0;
    while (at < args.length && args[at].startsWith('-')) at += args[at] === '-c' || args[at] === '-C' ? 2 : 1;
    commands.push(args[at] ?? '(none)');
  }
  return commands;
}

/** AGENTS.md rule 2's list of allowed git commands, read from the rule itself. */
function ruleTwoCommands(): string[] {
  const rule = /Allowed git commands: ([^.]*)\./.exec(readFileSync(path.join(root, 'AGENTS.md'), 'utf8'))?.[1] ?? '';
  return [...rule.matchAll(/`([a-z-]+)`/g)].map(match => match[1]);
}

const outsideRuleTwo = (commands: readonly string[]) => [...new Set(commands.filter(command => !ruleTwoCommands().includes(command)))];

async function readOnlyRepository(): Promise<void> {
  const repository = path.join(evidence, 'fixtures-read-only', 'app'), control = path.join(evidence, 'fixtures-read-only', 'control');
  createPractice(repository);
  createPractice(control);
  appendFileSync(path.join(repository, '.git/info/exclude'), '\nignored-probe.txt\n');
  writeFileSync(path.join(repository, 'ignored-probe.txt'), 'The app must not read this ignored file.\n');
  const before = fingerprint(repository);
  const recorder = gitRecorder(path.join(evidence, 'state', 'git-recorder'));
  const launched = await launch('read-only-repository', repository, {env: {PATH: `${recorder.dir}:${process.env.PATH ?? ''}`}});
  const {app, page} = launched;
  let requests: SeenRequest[] = [], controlRequests: SeenRequest[] = [], afterProbe: SeenRequest[] = [];
  let policy: {served: string | null; meta: string | null; probe: {outcome: string; violations: string[]}} | null = null;
  let diskReads: Record<string, unknown> = {};
  try {
    await waitForCommits(page, 12);
    await openCommit(page, NEWEST_SUBJECT, 4);
    await openFile(page, 'src/app.ts');
    await openTab(page, 'staged', 2);
    const unstagedPaths = await page.evaluate(async () => {
      const answer = await window.diffViewer.files({kind: 'unstaged'});
      return answer.ok ? answer.value.map(file => file.path) : [];
    });
    observations.readOnlyIgnoredFault = {expected: 'ignored-probe.txt absent', observed: unstagedPaths};
    assert(!unstagedPaths.includes('ignored-probe.txt' as never), `ignored-probe.txt was read from disk and listed: ${unstagedPaths.join(', ')}`);
    await openTab(page, 'unstaged', 2);
    await openFile(page, 'notes/todo.txt');
    diskReads = await page.evaluate(async () => {
      const source = {kind: 'unstaged'} as const;
      const listed = await window.diffViewer.files(source);
      const changed = await window.diffViewer.fileDiff(source, 'CHANGELOG.md' as never, false);
      const untracked = await window.diffViewer.fileDiff(source, 'notes/todo.txt' as never, false);
      const ignored = await window.diffViewer.fileDiff(source, 'ignored-probe.txt' as never, false);
      return {
        listed: listed.ok ? listed.value.map(file => file.path) : [],
        changed: changed.ok ? changed.value.kind : changed.error.kind,
        untracked: untracked.ok ? untracked.value.kind : untracked.error.kind,
        ignored: ignored.ok ? ignored.value.kind : ignored.error.kind,
      };
    });
    assert.deepEqual(diskReads, {listed: ['CHANGELOG.md', 'notes/todo.txt'], changed: 'text', untracked: 'text', ignored: 'unknownFile'}, 'listed changed and untracked files are readable; the planted ignored file is refused');
    await page.locator('#refresh').click();
    await page.waitForFunction(() => !document.getElementById('diff')!.hasAttribute('aria-busy'), null, {timeout: 30000});
    await sleep(500);
    await shot(page, 'read-only-repository');
    requests = await seenRequests(app);
    const served = await app.evaluate(async ({session}, url) => (await session.defaultSession.fetch(url)).headers.get('content-security-policy'), APP_URL);
    const meta = await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? null);
    const probe = await page.evaluate(async url => {
      const violations: string[] = [];
      document.addEventListener('securitypolicyviolation', event => violations.push(event.effectiveDirective));
      const outcome = await fetch(url).then(() => 'answered', (error: Error) => error.name);
      await new Promise(resolve => setTimeout(resolve, 200));
      return {outcome, violations: [...new Set(violations)]};
    }, PAGE_PROBE_URL);
    policy = {served, meta, probe};
    afterProbe = await seenRequests(app);
    await app.evaluate(({BrowserWindow}, url) => { void new BrowserWindow({show: false}).loadURL(url).catch(() => undefined); }, CONTROL_URL);
    for (let tries = 0; tries < 40 && !controlRequests.length; tries++) {
      await sleep(250);
      controlRequests = (await seenRequests(app)).filter(request => request.url === CONTROL_URL);
    }
  } finally { await close(launched); }
  const after = fingerprint(repository);
  const controlBefore = fingerprint(control);
  const statusCommand = [...GIT_SETTINGS.flatMap(setting => ['-c', setting]), ...GIT_OPTIONS, '-C', control, 'status', ...STATUS_ARGUMENTS];
  const status = harnessGit(statusCommand);
  const controlAfter = fingerprint(control);
  const external = requests.filter(request => !request.url.startsWith(`${APP_ORIGIN}/`));
  const commands = recordedCommands(recorder.log);
  const planted = ['diff', 'show'];
  const gitCalls = {
    recorded: commands.length, byCommand: Object.fromEntries([...new Set(commands)].map(name => [name, commands.filter(command => command === name).length])),
    ruleTwo: ruleTwoCommands(), appList: [...GIT_COMMANDS], outsideRuleTwo: outsideRuleTwo(commands), positiveControl: {planted, flagged: outsideRuleTwo(planted)},
  };
  observations.readOnlyRepository = {
    app: {
      repository: path.relative(root, repository), staleIndexEntry: 'src/format.ts (time changed, content not)', before, after, expected: 'same', observed: before === after ? 'same' : 'changed',
      drove: ['open', `click "${NEWEST_SUBJECT}"`, 'click app.ts', 'click Staged', 'click Unstaged', 'click todo.txt', 'click Refresh', 'quit and wait for exit'],
    },
    gitCalls,
    diskReads: {expected: {listed: ['CHANGELOG.md', 'notes/todo.txt'], changed: 'text', untracked: 'text', ignored: 'unknownFile'}, observed: diskReads},
    control: {repository: path.relative(root, control), command: ['git', ...statusCommand.map(part => part === control ? path.relative(root, control) : part)], environment: 'GIT_OPTIONAL_LOCKS not set', exit: status.status, before: controlBefore, after: controlAfter, expected: 'changed', observed: controlBefore === controlAfter ? 'same' : 'changed'},
    network: {requestsSeen: requests.map(request => request.url), outsideAppOrigin: external, expected: 0, observed: external.length},
    contentSecurityPolicy: {...policy, probeUrl: PAGE_PROBE_URL, probeReachedNetworkLayer: afterProbe.some(request => request.url === PAGE_PROBE_URL)},
    networkControl: {url: CONTROL_URL, from: 'a hidden test-only window the harness opened in main', expected: 1, observed: controlRequests.length, error: controlRequests[0]?.error ?? null},
  };
  log('read-only repository', observations.readOnlyRepository);
  assert(requests.some(request => request.url === APP_URL), 'the request listeners were in place before the page loaded');
  assert.deepEqual([...gitCalls.ruleTwo].sort(), [...GIT_COMMANDS].sort(), 'the app\'s list of git commands is AGENTS.md rule 2\'s list');
  for (const name of ['diff-index', 'diff-files', 'ls-files', 'check-attr']) assert(commands.includes(name), `the recorder saw the staged and unstaged reads (${name})`);
  assert.deepEqual(gitCalls.outsideRuleTwo, [], `every recorded git call is on the rule 2 list (${JSON.stringify(gitCalls.byCommand)})`);
  assert.deepEqual(gitCalls.positiveControl.flagged, planted, 'positive control: the same check flags git diff and git show');
  assert.equal(after, before, 'the app left the repository, .git included, byte-for-byte unchanged');
  assert.equal(status.status, 0, 'the control git status ran');
  assert.notEqual(controlAfter, controlBefore, 'positive control: the app\'s own status command, run without GIT_OPTIONAL_LOCKS=0, rewrites a second build of the fixture');
  assert.deepEqual(external, [], 'no request left the app origin at the network layer');
  assert(policy?.served?.includes(`default-src 'none'`) && policy.served.includes(`connect-src 'none'`), `the served page carries a Content-Security-Policy header with default-src and connect-src 'none' (got ${policy?.served})`);
  assert.equal(policy.meta, policy.served, 'the page\'s Content-Security-Policy meta tag matches the header');
  assert.deepEqual(policy.probe, {outcome: 'TypeError', violations: ['connect-src']}, 'a fetch from the page is stopped by the policy inside the page');
  assert.equal(afterProbe.some(request => request.url === PAGE_PROBE_URL), false, 'the stopped page fetch never reached the network layer');
  assert.deepEqual(controlRequests.map(request => request.error), ['net::ERR_BLOCKED_BY_CLIENT'], 'positive control: a request from a test-only window is counted, and main cancels it');
}

/** A disposable compiled-app fault: it makes the app list, count, and read an ignored file. */
async function readOnlyWithFault(): Promise<void> {
  if (fault !== 'ignored-read') return readOnlyRepository();
  const file = path.join(root, 'dist/src/app/git.js');
  const original = readFileSync(file, 'utf8');
  const needle = "return (await git(repo.path, 'ls-files', ['--others', '--exclude-standard', '-z', ...limitTo(only)])).split('\\0').filter(Boolean);";
  assert(original.includes(needle), 'the compiled untracked listing has the expected fault insertion point');
  writeFileSync(file, original.replace(needle, `${needle.slice(0, -1)}.concat('ignored-probe.txt');`));
  try { await readOnlyRepository(); }
  finally { writeFileSync(file, original); }
}

const USER_GIT_CONFIG = [
  '[log]', '\tshowSignature = true', '\tdecorate = full',
  '[i18n]', '\tlogOutputEncoding = ISO-8859-1',
  '[diff]', '\trenameLimit = 1', '\tsuppressBlankEmpty = true', '\tnoprefix = true',
  '[status]', '\trenames = false', '\trenameLimit = 1',
  '[core]', '\tabbrev = 12',
  '[color]', '\tui = always',
].join('\n') + '\n';

function gitHome(name: string, config: string): Record<string, string> {
  const home = path.join(evidence, 'state', name);
  mkdirSync(path.join(home, '.config', 'git'), {recursive: true});
  writeFileSync(path.join(home, '.config', 'git', 'config'), config);
  return {HOME: home, XDG_CONFIG_HOME: path.join(home, '.config')};
}

async function userGitConfig(): Promise<void> {
  const hostile = gitHome('git-home-user', USER_GIT_CONFIG), plain = gitHome('git-home-plain', '');
  const [head, parent] = gitOut(fixtures.practice, 'rev-parse', 'HEAD', 'HEAD~1').split('\n');
  const commands = {
    log: ['log', '-z', '--format=%H%x00%P%x00%an%x00%aI%x00%s', '--max-count=201', 'HEAD', '--'],
    changes: ['diff-tree', '-r', '-M', '--no-commit-id', '--raw', '--numstat', '-z', parent, head],
  };
  // A control: git with only core.quotepath, core.fsmonitor, and color.ui pinned. It shows what the user config does to the app's commands without the other pins.
  const unpinned = (home: Record<string, string>, args: string[]) => spawnSync('git', ['-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', '-c', 'color.ui=false', '-C', fixtures.practice, ...args], {encoding: 'latin1', env: allowedEnv({...home, GIT_OPTIONAL_LOCKS: '0'})}).stdout;
  const withoutPins = Object.fromEntries(Object.entries(commands).map(([name, args]) => [name, unpinned(plain, args) === unpinned(hostile, args) ? 'same' : 'changed']));
  observations.userGitConfig = {config: USER_GIT_CONFIG, home: path.relative(root, hostile.HOME), withoutPins: {expected: {log: 'changed', changes: 'changed'}, observed: withoutPins}, newestCommitSigned: gitOut(fixtures.practice, 'cat-file', 'commit', 'HEAD').includes('\ngpgsig ')};
  log('user git config control', observations.userGitConfig);
  assert.deepEqual(withoutPins, {log: 'changed', changes: 'changed'}, 'positive control: this config changes what git prints for the app\'s log and diff-tree commands when nothing pins it');
  const launched = await launch('user-git-config', fixtures.practice, {env: hostile});
  try {
    await expectOpenRepository(launched.page, 'user-git-config');
    await expectCommitDiff(launched.page, fixtures.practice, 'user-git-config');
    await expectHostileText(launched.page, 'user-git-config');
  } finally { void close(launched); }
}

async function launcherOpen(): Promise<void> {
  await packageApp();
  const outside = path.join(evidence, 'outside');
  mkdirSync(outside);
  const clone = path.join(evidence, 'linked-source');
  const linked = path.join(evidence, 'linked-worktree');
  const cloned = harnessGit(['clone', '-q', '--no-local', fixtures.practice, clone]);
  assert.equal(cloned.status, 0, `clone fixture: ${cloned.stderr}`);
  const added = harnessGit(['-C', clone, 'worktree', 'add', '-q', '--detach', linked, 'HEAD']);
  assert.equal(added.status, 0, `create linked worktree: ${added.stderr}`);
  const before = new Map([[fixtures.practice, fingerprint(fixtures.practice)], [clone, fingerprint(clone)], [linked, fingerprint(linked)], [fixtures.bare, fingerprint(fixtures.bare)]]);
  const samples: number[] = [];
  const states: string[] = [];
  // The launcher's own git calls and the started app's both go through the recorder, which the app inherits on PATH.
  const recorder = gitRecorder(path.join(evidence, 'state', 'launcher-git-recorder'));
  for (let index = 0; index < SAMPLES; index++) {
    const repository = index === 1 ? linked : index === 2 ? fixtures.bare : fixtures.practice;
    const state = path.join(evidence, 'state', `launcher-${index}`);
    const started = performance.now();
    const result = spawnSync(path.join(root, 'bin/diff-viewer'), ['open', repository, '--format', 'json'], {
      cwd: outside, encoding: 'utf8', timeout: 30000, env: allowedEnv({DIFF_VIEWER_STATE_DIR: index === 0 ? `${state}/` : state, PATH: `${recorder.dir}:${process.env.PATH ?? ''}`}),
    });
    samples.push(performance.now() - started);
    assert.equal(result.status, 0, `launcher ${index}: ${result.stderr} ${result.stdout}`);
    const answer = JSON.parse(result.stdout) as {repository: string; app: string; pid: number; title: string; visible: boolean};
    assert.equal(answer.repository, realpathSync(repository));
    assert.equal(answer.app, 'started');
    assert.equal(answer.title, `${index === 1 ? 'linked-worktree' : index === 2 ? 'practice.git' : 'practice'}${TITLE_SUFFIX}`);
    assert.equal(answer.visible, true, 'the window is visible when the launcher returns');
    assert(Number.isSafeInteger(answer.pid) && isAlive(answer.pid), 'the app keeps running after the launcher returns');
    owned.add(answer.pid);
    states.push(state);
    const files = readdirSync(state);
    assert(files.includes('chromium') && files.includes('recent.json'), 'the app writes its state under DIFF_VIEWER_STATE_DIR');
    process.kill(answer.pid, 'SIGTERM');
    const deadline = Date.now() + 20000;
    while (isAlive(answer.pid) && Date.now() < deadline) await sleep(100);
    assert.equal(isAlive(answer.pid), false, 'the owned app stopped after the journey');
  }
  if (fault === 'launcher-write') appendFileSync(path.join(fixtures.practice, 'src/app.ts'), '\nplanted fixture write\n');
  if (fault === 'launcher-git-write') appendFileSync(path.join(gitOut(linked, 'rev-parse', '--git-dir'), 'launcher-write-probe'), 'planted shared Git metadata write\n');
  const changed = [...before].filter(([repository, print]) => fingerprint(repository) !== print).map(([repository]) => repository);
  assert.deepEqual(changed, [], 'launcher-open: fixture repository fingerprint stayed unchanged');
  timing('launcher return', null, samples, 'five packaged app launches from outside the repository, including a linked worktree and a bare repository');
  const commands = recordedCommands(recorder.log);
  const gitCalls = {recorded: commands.length, byCommand: Object.fromEntries([...new Set(commands)].map(name => [name, commands.filter(command => command === name).length])), outsideRuleTwo: outsideRuleTwo(commands)};
  observations.launcherOpen = {states: states.map(state => path.relative(root, state)), linkedWorktree: path.relative(root, linked), bareRepository: path.relative(root, fixtures.bare), gitCalls};
  assert(commands.includes('rev-parse') && commands.includes('log'), `the recorder saw the launcher's rev-parse and the app's log calls (${JSON.stringify(gitCalls.byCommand)})`);
  assert.deepEqual(gitCalls.outsideRuleTwo, [], `every git call by the launcher and the app it started is on the rule 2 list (${JSON.stringify(gitCalls.byCommand)})`);
}

function runLauncher(repository: string, state: string, outside: string, source?: string): Promise<{status: number | null; stdout: string; stderr: string}> {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(root, 'bin/diff-viewer'), ['open', repository, ...(source ? ['--source', source] : []), '--format', 'json'], {
      cwd: outside, env: appEnv({DIFF_VIEWER_STATE_DIR: state}),
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 25000);
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', status => { clearTimeout(timer); resolve({status, stdout, stderr}); });
  });
}

async function launcherSource(): Promise<void> {
  await packageApp();
  const state = path.join(evidence, 'state', 'launcher-source');
  const outside = path.join(evidence, 'outside-source');
  mkdirSync(outside);
  const before = fingerprint(fixtures.practice);
  const hash = gitOut(fixtures.practice, 'rev-parse', 'HEAD').trim();
  const firstCall = await runLauncher(fixtures.practice, path.join(evidence, 'state', 'launcher-source-first'), outside, 'unstaged');
  assert.equal(firstCall.status, 0, `first source open: ${firstCall.stdout} ${firstCall.stderr}`);
  const firstAnswer = JSON.parse(firstCall.stdout) as {app: string; pid: number; source: {kind: string}; firstFile: string};
  try {
    assert.deepEqual([firstAnswer.app, firstAnswer.source, firstAnswer.firstFile], ['started', {kind: 'unstaged'}, 'CHANGELOG.md'], 'the installed command acknowledges its first view');
    assert(isAlive(firstAnswer.pid), 'the first app stays running after the command returns');
  } finally {
    process.kill(firstAnswer.pid, 'SIGTERM');
    const deadline = Date.now() + 20000;
    while (isAlive(firstAnswer.pid) && Date.now() < deadline) await sleep(100);
    assert.equal(isAlive(firstAnswer.pid), false, 'the owned first app stopped');
  }
  const primary = await launch('launcher-source', fixtures.practice, {executable: BUNDLE_EXECUTABLE, dataDir: state, source: 'unstaged'});
  const results: unknown[] = [];
  try {
    await waitForFile(primary.page, 'CHANGELOG.md');
    assert.match(await primary.page.locator('#diff').innerText(), /Unstaged line\./);
    for (const [source, tab, first] of [['staged', 'staged', 'README.md'], ['commit:HEAD', 'commits', 'src/added.ts'], ['unstaged', 'unstaged', 'CHANGELOG.md'], ['commit:HEAD', 'commits', 'src/added.ts']] as const) {
      const call = await runLauncher(fixtures.practice, state, outside, source);
      assert.equal(call.status, 0, `${source}: ${call.stdout} ${call.stderr}`);
      const answer = JSON.parse(call.stdout) as {repository: string; app: string; pid: number; title: string; visible: boolean; source: {kind: string; hash?: string}; firstFile: string};
      assert.deepEqual([answer.repository, answer.app, answer.pid, answer.visible], [realpathSync(fixtures.practice), 'running', primary.app.process().pid, true]);
      assert.equal(await primary.page.locator(`#${tab}-tab`).getAttribute('aria-selected'), 'true', `${source}: tab selected before launcher returned`);
      assert.equal(await primary.page.locator('#diff > [data-path]').getAttribute('data-path'), first, `${source}: first diff shown before launcher returned`);
      assert.equal(await primary.page.locator('#diff').getAttribute('aria-busy'), null, `${source}: diff settled before launcher returned`);
      assert.equal(answer.firstFile, first, `${source}: JSON names the first file`);
      assert.deepEqual(answer.source, source.startsWith('commit:') ? {kind: 'commit', hash} : {kind: source}, `${source}: JSON names the resolved source`);
      assert.match(await primary.page.locator('#diff').innerText(), source === 'staged' ? /Staged line\./ : source === 'unstaged' ? /Unstaged line\./ : /added = true/);
      results.push({source, answer, tab, first, hash: source.startsWith('commit:') ? hash : null});
    }
    assert.equal(primary.app.windows().length, 1, 'one repository has one window');
    assert.equal(fingerprint(fixtures.practice), before, 'the launcher left the repository unchanged');
    observations.launcherSource = {firstAnswer, results, repositoryUnchanged: true};
    await shot(primary.page, 'launcher-source');
  } finally { await close(primary); }
  const clean = path.join(evidence, 'fixtures-source-clean');
  createCleanPractice(clean);
  const cleanBefore = fingerprint(clean);
  const cleanFirstState = path.join(evidence, 'state', 'launcher-source-clean-first');
  const cleanFirstCall = await runLauncher(clean, cleanFirstState, outside, 'staged');
  assert.equal(cleanFirstCall.status, 0, `empty staged first open: ${cleanFirstCall.stdout} ${cleanFirstCall.stderr}`);
  const cleanFirstAnswer = JSON.parse(cleanFirstCall.stdout) as {app: string; pid: number; source: {kind: string}; firstFile: string | null};
  try {
    assert.deepEqual([cleanFirstAnswer.app, cleanFirstAnswer.source, cleanFirstAnswer.firstFile], ['started', {kind: 'staged'}, null], 'an empty staged first view is acknowledged');
    assert(isAlive(cleanFirstAnswer.pid), 'the empty first view leaves the app running');
  } finally {
    process.kill(cleanFirstAnswer.pid, 'SIGTERM');
    const deadline = Date.now() + 20000;
    while (isAlive(cleanFirstAnswer.pid) && Date.now() < deadline) await sleep(100);
    assert.equal(isAlive(cleanFirstAnswer.pid), false, 'the owned empty first app stopped');
  }
  const cleanState = path.join(evidence, 'state', 'launcher-source-clean-running');
  const cleanPrimary = await launch('launcher-source-clean', clean, {executable: BUNDLE_EXECUTABLE, dataDir: cleanState, source: 'staged'});
  try {
    await cleanPrimary.page.waitForFunction(() => document.querySelector('#staged-tab')?.getAttribute('aria-selected') === 'true' && document.getElementById('diff')?.textContent?.includes('No staged changes'));
    const cleanSecondCall = await runLauncher(clean, cleanState, outside, 'unstaged');
    assert.equal(cleanSecondCall.status, 0, `empty unstaged running open: ${cleanSecondCall.stdout} ${cleanSecondCall.stderr}`);
    const cleanSecondAnswer = JSON.parse(cleanSecondCall.stdout) as {app: string; pid: number; source: {kind: string}; firstFile: string | null};
    assert.deepEqual([cleanSecondAnswer.app, cleanSecondAnswer.pid, cleanSecondAnswer.source, cleanSecondAnswer.firstFile], ['running', cleanPrimary.app.process().pid, {kind: 'unstaged'}, null], 'an empty unstaged running view is acknowledged');
    assert.equal(await cleanPrimary.page.locator('#unstaged-tab').getAttribute('aria-selected'), 'true');
    assert.match(await cleanPrimary.page.locator('#diff').innerText(), /No unstaged changes/);
    const cleanCommitCall = await runLauncher(clean, cleanState, outside, 'commit:HEAD');
    assert.equal(cleanCommitCall.status, 0, `empty commit running open: ${cleanCommitCall.stdout} ${cleanCommitCall.stderr}`);
    const cleanCommitAnswer = JSON.parse(cleanCommitCall.stdout) as {app: string; pid: number; source: {kind: string; hash: string}; firstFile: string | null};
    assert.deepEqual([cleanCommitAnswer.app, cleanCommitAnswer.pid, cleanCommitAnswer.source, cleanCommitAnswer.firstFile],
      ['running', cleanPrimary.app.process().pid, {kind: 'commit', hash: gitOut(clean, 'rev-parse', 'HEAD').trim()}, null], 'an empty commit running view is acknowledged');
    assert.equal(await cleanPrimary.page.locator('#commits-tab').getAttribute('aria-selected'), 'true');
    assert.match(await cleanPrimary.page.locator('#diff').innerText(), /No changed files/);
    assert.equal(cleanPrimary.app.windows().length, 1, 'the clean repository keeps one window');
    observations.launcherSourceClean = {first: cleanFirstAnswer, second: cleanSecondAnswer, commit: cleanCommitAnswer, stagedEmpty: true, unstagedEmpty: true, commitEmpty: true};
  } finally { await close(cleanPrimary); }
  assert.equal(fingerprint(clean), cleanBefore, 'the clean fixture stayed unchanged');
}

async function launcherTwice(): Promise<void> {
  await packageApp();
  const state = path.join(evidence, 'state', 'launcher-twice');
  const ready = path.join(state, 'ready-00000000-0000-4000-8000-000000000001.json');
  const outside = path.join(evidence, 'outside-twice');
  mkdirSync(state, {recursive: true});
  mkdirSync(outside);
  const before = new Map([[fixtures.practice, fingerprint(fixtures.practice)], [fixtures.special, fingerprint(fixtures.special)], [fixtures.history, fingerprint(fixtures.history)]]);
  const primary = await launch('launcher-twice', fixtures.practice, {executable: BUNDLE_EXECUTABLE, dataDir: state, readyFile: ready});
  try {
    await waitForCommits(primary.page, 12);
    for (let tries = 0; tries < 80 && !existsSync(ready); tries++) await sleep(100);
    assert(existsSync(ready), 'the primary app wrote its ready marker');
    const first = JSON.parse(readFileSync(ready, 'utf8')) as {app: string; pid: number; title: string; visible: boolean};
    assert.deepEqual([first.app, first.pid, first.title, first.visible], ['started', primary.app.process().pid, REPOSITORY_TITLE, true], 'the first app reports started and its main process ID');
    const results: {repository: string; app: string; pid: number; title: string; visible: boolean}[] = [];
    const samples: number[] = [];
    for (const repository of [fixtures.practice, fixtures.special, fixtures.practice, fixtures.special, fixtures.practice]) {
      const started = performance.now();
      const call = await runLauncher(repository, state, outside);
      samples.push(performance.now() - started);
      assert.equal(call.status, 0, `second open: ${call.stderr} ${call.stdout}`);
      const result = JSON.parse(call.stdout) as typeof results[number];
      assert.deepEqual([result.repository, result.app, result.pid, result.title, result.visible],
        [realpathSync(repository), 'running', primary.app.process().pid, repository === fixtures.practice ? REPOSITORY_TITLE : SPECIAL_TITLE, true],
        'the second call reports the repository and primary main process ID after its window appears');
      results.push(result);
      const expectedWindows = repository === fixtures.practice && results.length === 1 ? 1 : 2;
      assert.equal(primary.app.windows().length, expectedWindows, 'one window per repository');
      const focus = await primary.app.evaluate(({BrowserWindow}, title) => BrowserWindow.getAllWindows().find(window => window.getTitle() === title)?.isFocused(), result.title);
      assert.equal(focus, true, 'the requested repository window has focus when open returns');
    }
    const concurrent = await Promise.all(Array.from({length: 8}, () => runLauncher(fixtures.history, state, outside)));
    for (const [index, call] of concurrent.entries()) {
      assert.equal(call.status, 0, `concurrent open ${index}: ${call.stderr} ${call.stdout}`);
      const answer = JSON.parse(call.stdout) as typeof results[number];
      assert.deepEqual([answer.repository, answer.app, answer.pid, answer.title, answer.visible],
        [realpathSync(fixtures.history), 'running', primary.app.process().pid, `history${TITLE_SUFFIX}`, true],
        'each concurrent call receives the owning process and ready window');
    }
    assert.equal(primary.app.windows().length, 3, 'eight concurrent calls create one history window');
    const alias = path.join(evidence, 'state', 'launcher-alias');
    symlinkSync(state, alias, 'dir');
    const stateParentBefore = readdirSync(path.dirname(state)).sort();
    const aliasCall = await runLauncher(fixtures.practice, alias, outside);
    assert.equal(aliasCall.status, 0, `state symlink alias: ${aliasCall.stderr} ${aliasCall.stdout}`);
    const aliasAnswer = JSON.parse(aliasCall.stdout) as typeof results[number];
    assert.deepEqual([aliasAnswer.repository, aliasAnswer.app, aliasAnswer.pid], [realpathSync(fixtures.practice), 'running', primary.app.process().pid], 'a state symlink reaches the same owning app');
    assert.equal(realpathSync(alias), realpathSync(state), 'the alias names the same physical state folder');
    assert.deepEqual(readdirSync(path.dirname(state)).sort(), stateParentBefore, 'the alias open made no sibling state folder');
    assert.equal(realpathSync(path.join(alias, 'recent.json')), realpathSync(path.join(state, 'recent.json')), 'the alias reaches the chosen physical state file');
    const owners = spawnSync('ps', ['-axo', 'pid=,command='], {encoding: 'utf8'}).stdout.split('\n').filter(line => line.includes(BUNDLE_EXECUTABLE) && line.includes(`--data-dir ${state}`) && !line.includes('--type=')).map(line => Number(line.trim().split(/\s+/)[0]));
    assert.deepEqual(owners, [primary.app.process().pid], 'one owning Electron main process uses this state folder');
    const defaultState = path.join(evidence, 'state', 'launcher-default');
    mkdirSync(path.join(defaultState, 'chromium'), {recursive: true});
    const bootstrap = path.join(evidence, 'default-bootstrap.cjs');
    writeFileSync(bootstrap, `const {app} = require('electron');\napp.setPath('userData', ${JSON.stringify(defaultState)});\napp.setPath('sessionData', ${JSON.stringify(path.join(defaultState, 'chromium'))});\nrequire(${JSON.stringify(path.join(root, 'dist/src/app/main.js'))});\n`);
    const defaultApp = await launch('launcher-twice-default', fixtures.practice, {appEntry: bootstrap, dataDir: null});
    try {
      const defaultPid = defaultApp.app.process().pid, primaryPid = primary.app.process().pid;
      assert(defaultPid && primaryPid, 'both state folders have app process IDs');
      await waitForCommits(defaultApp.page, 12);
      assert.notEqual(defaultPid, primaryPid, 'two state folders have separate owning processes');
      const defaultCall = await runLauncher(fixtures.practice, defaultState, outside);
      assert.equal(defaultCall.status, 0, `open the app without --data-dir: ${defaultCall.stderr} ${defaultCall.stdout}`);
      const defaultAnswer = JSON.parse(defaultCall.stdout) as typeof results[number];
      assert.deepEqual([defaultAnswer.app, defaultAnswer.pid, defaultAnswer.repository], ['running', defaultPid, realpathSync(fixtures.practice)], 'the default-state app accepts a launcher hand-off');
      assert(isAlive(primaryPid) && isAlive(defaultPid), 'both state folders keep their separate app processes');
      observations.launcherTwiceDefault = {state: path.relative(root, defaultState), answer: defaultAnswer, owners: [primaryPid, defaultPid]};
    } finally { void close(defaultApp); }
    assert.deepEqual([...before].filter(([repository, print]) => fingerprint(repository) !== print).map(([repository]) => repository), [], 'both fixture repositories stayed unchanged');
    timing('second launcher return', null, samples, 'five second calls to one packaged app, including focus and a new repository window');
    observations.launcherTwice = {first, results, concurrentCalls: concurrent.length, alias: path.relative(root, alias), owners, windows: primary.app.windows().length};
  } finally { void close(primary); }
}

async function appBundle(): Promise<void> {
  const started = performance.now();
  await packageApp();
  measurements.packageSeconds = String(round((performance.now() - started) / 1000));
  const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', BUNDLE], {encoding: 'utf8'});
  const details = spawnSync('codesign', ['-dv', BUNDLE], {encoding: 'utf8'});
  writeFileSync(path.join(evidence, 'logs', 'codesign.log'), `verify exit ${verify.status}\n${verify.stdout}${verify.stderr}\n-dv exit ${details.status}\n${details.stdout}${details.stderr}`);
  assert.equal(verify.status, 0, 'codesign --verify --deep --strict exits 0');
  assert.match(details.stderr, /Signature=adhoc/, 'the bundle carries an ad-hoc signature');
  await withApp('app-bundle', fixtures.practice, async ({app, page}) => {
    const executable = await app.evaluate(({app}) => ({path: process.execPath, packaged: app.isPackaged}));
    assert.equal(executable.packaged, true, 'the running app is the packaged bundle');
    assert.equal(executable.path, BUNDLE_EXECUTABLE);
    await expectOpenRepository(page, 'app-bundle');
    await openCommit(page, NEWEST_SUBJECT, 4);
    await openFile(page, 'src/app.ts');
    const keyword = await page.evaluate(() => {
      const span = [...document.querySelectorAll('#diff td.cd.r span')].find(node => node.textContent?.startsWith('export'));
      return {color: span ? getComputedStyle(span).color : null, colored: document.querySelectorAll('#diff td.cd span[style*="--tl"]').length};
    });
    observations.appBundle = {keyword};
    assert.equal(keyword.color, rgb(GITHUB.light.keyword), 'Shiki runs inside the packaged bundle: the keyword export carries the github-light color');
    await shot(page, 'app-bundle-highlighted');
  }, {executable: BUNDLE_EXECUTABLE});
  log('app bundle', {bundle: path.relative(root, BUNDLE), codesignVerifyExit: verify.status});
}

const TRACE_SCAN = 'traces hold no shell environment';
const SECRET_NAME = /_(?:TOKEN|SECRET|PASSWORD|KEY|SESSION_ID|SOCK)$/;
// Shorter values (1, true, zsh, a user name) also occur in ordinary trace text, so only longer ones are searched for.
const MIN_SEARCHED_VALUE = 8;

/**
 * Unzips each traces/*.zip of this run and searches it for the names that match SECRET_NAME and for the value of every variable of the starting shell outside the
 * allowlist. Values the harness writes itself are not searched for: the checkout's path and its parents (PWD), and text inside
 * an allowed value (a PATH entry). The result names variables only, never a value.
 */
function environmentInTraces(): {allowed: string[]; traces: string[]; valuesSearched: string[]; canaryPlanted: boolean; found: Record<string, string[]>} {
  const allowedValues = Object.values(allowedEnv());
  const parents = root.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/')).filter(Boolean);
  const searched = Object.entries(process.env).filter((entry): entry is [string, string] => {
    const [name, value] = entry;
    return value !== undefined && !ALLOWED_ENV.includes(name) && value.length >= MIN_SEARCHED_VALUE && !parents.includes(value) && !allowedValues.some(allowed => allowed.includes(value));
  });
  const traces = readdirSync(path.join(evidence, 'traces')).filter(name => name.endsWith('.zip')).sort();
  const found: Record<string, string[]> = {};
  for (const trace of traces) {
    const unzipped = spawnSync('unzip', ['-p', path.join(evidence, 'traces', trace)], {maxBuffer: 1 << 30});
    if (unzipped.status !== 0) throw new Error(`unzip -p traces/${trace} exited ${unzipped.status ?? 'none'}`);
    const names = [
      ...Object.keys(process.env).filter(name => SECRET_NAME.test(name) && unzipped.stdout.includes(name)),
      ...searched.filter(([, value]) => unzipped.stdout.includes(value) || unzipped.stdout.includes(JSON.stringify(value).slice(1, -1))).map(([name]) => name),
    ];
    if (names.length) found[trace] = [...new Set(names)].sort();
  }
  return {allowed: ALLOWED_ENV, traces, valuesSearched: searched.map(([name]) => name).sort(), canaryPlanted: Boolean(process.env.DIFF_VIEWER_CANARY), found};
}

function realRepositories(): string[] {
  return [...new Set([options.historyRepo, options.fileRepo].filter((folder): folder is string => folder !== null))];
}

async function run(): Promise<number> {
  const ready = doctor();
  writeFileSync(path.join(evidence, 'logs', 'doctor.json'), JSON.stringify(ready, null, 2));
  if (!ready.ready) {
    const failed = ready.rows.filter(row => !row.ok).map(row => `${row.name}: ${row.detail}`).join('; ');
    for (const name of options.selected) rows.push({name, status: 'skipped', reason: `The doctor found the environment not ready (${failed}); see logs/doctor.json. Nothing was launched.`});
    return 3;
  }
  fixtures = createFixtures(path.join(evidence, 'fixtures'));
  const prints = new Map([...Object.values(fixtures), ...realRepositories()].map(folder => [folder, fingerprint(folder)]));
  const journeys: Record<Feature, () => Promise<void>> = {
    'open-repository': openRepository, 'commit-diff': commitDiff, 'special-files': specialFiles, highlighting, 'hostile-text': hostileText,
    'not-a-repository': notARepository, 'recent-repositories': recentRepositories, 'dark-mode': darkMode, 'bare-repository': bareRepository,
    'window-per-repository': windowPerRepository, 'collapse-pane': collapsePane, 'next-previous-file': nextPreviousFile,
    'working-changes': workingChanges, 'repository-removed': repositoryRemoved, 'read-only-repository': readOnlyWithFault, 'user-git-config': userGitConfig, 'app-bundle': appBundle, 'launcher-open': launcherOpen, 'launcher-twice': launcherTwice, 'launcher-source': launcherSource,
  };
  let locked = false;
  for (const name of options.selected) {
    if (locked) { rows.push({name, status: 'skipped', reason: 'not run: the screen locked during the run'}); continue; }
    try { await journeys[name](); rows.push({name, status: 'proven'}); }
    catch (error) {
      const failure = journeyFailure(error instanceof Error ? error.stack ?? error.message : String(error), frontAppName());
      locked = failure.locked;
      rows.push({name, status: failure.locked ? 'skipped' : 'failed', reason: failure.reason});
    }
  }
  for (const name of options.skipped) rows.push({name, status: 'skipped', reason: 'runs at the full level only'});
  await Promise.race([Promise.all(closing), sleep(40000)]);
  const unchanged = [...prints].map(([folder, before]) => ({repository: folder.startsWith(root) ? path.relative(root, folder) : folder, before, after: fingerprint(folder)}));
  observations.repositoriesUnchanged = unchanged;
  const changed = unchanged.filter(entry => entry.before !== entry.after);
  rows.push(changed.length ? {name: 'repositories unchanged', status: 'failed', reason: `changed: ${changed.map(entry => entry.repository).join(', ')}`} : {name: 'repositories unchanged', status: 'proven'});
  const scan = environmentInTraces();
  observations.environmentScan = scan;
  const leaks = Object.entries(scan.found).map(([trace, names]) => `traces/${trace} holds ${names.join(', ')}`);
  rows.push(!scan.traces.length ? {name: TRACE_SCAN, status: 'skipped', reason: 'no trace in this run'}
    : leaks.length ? {name: TRACE_SCAN, status: 'failed', reason: leaks.join('; ')} : {name: TRACE_SCAN, status: 'proven'});
  if (unexpected.length) rows.push({name: 'page errors', status: 'failed', reason: unexpected.join('; ')});
  if (rows.some(row => row.status === 'failed')) return 1;
  return locked ? 3 : 0;
}

async function stopOwnedProcesses(): Promise<void> {
  await Promise.race([Promise.all(closing), sleep(40000)]);
  const deadline = Date.now() + 40000;
  while ([...owned].some(isAlive) && Date.now() < deadline) await sleep(250);
  cleanup.ownedProcesses = owned.size;
  for (const pid of [...owned].filter(isAlive)) { process.kill(pid, 'SIGKILL'); cleanup.stopped.push(pid); }
  await sleep(500);
  cleanup.stillRunning = [...owned].filter(isAlive);
}

/**
 * The checkout's commit, whether it had uncommitted changes when the run started, and a digest of those changes,
 * so two dirty trees on one commit differ. The digest is sha256 over the trimmed `git diff-index --binary -p HEAD --`
 * output, a zero byte, then one `path NUL sha256` line per untracked file. A link is hashed by its target text, never
 * followed, and an untracked folder (a nested repository) by its name only, so the harness reads no ignored file.
 */
function checkoutState(): {revision: string; modified: boolean; changesDigest: string} {
  const changes = gitAsTheAppReads(root, 'diff-index', '--binary', '-p', 'HEAD', '--');
  const untracked = gitAsTheAppReads(root, 'ls-files', '-o', '--exclude-standard', '-z').split('\0').filter(Boolean).sort().map(file => {
    const full = path.join(root, file);
    const entry = lstatSync(full);
    const content = entry.isSymbolicLink() ? `link:${readlinkSync(full)}` : entry.isFile() ? readFileSync(full) : 'folder';
    return `${file}\0${createHash('sha256').update(content).digest('hex')}`;
  });
  return {...checkoutIdentity(root, allowedEnv()), changesDigest: createHash('sha256').update(changes).update('\0').update(untracked.join('\n')).digest('hex')};
}
const checkout = checkoutState();

function writeSummary(exitCode: number): void {
  observations.loadBeforeMeasuring = loadBeforeMeasuring;
  const summary = {
    revision: checkout.revision, modified: checkout.modified, changesDigest: checkout.changesDigest,
    startedAt: actions[0]?.at ?? null, finishedAt: new Date().toISOString(), level: options.level, selected: options.selected, fault,
    realRepositories: {historyRepo: options.historyRepo, fileRepo: options.fileRepo},
    standIns: ['The harness opens repositories with the --open start argument or through the recent list, because Playwright cannot drive the macOS folder chooser.', 'Repositories are generated by scripts/fixtures with fixed authors, dates, and content.'],
    features: rows, measurements, observations, cleanup, exitCode, evidence: path.relative(root, evidence),
  };
  writeFileSync(path.join(evidence, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  writeFileSync(path.join(evidence, 'logs', 'actions.json'), JSON.stringify(actions, null, 2) + '\n');
  const timingLines = Object.entries(measurements).map(([name, value]) => typeof value === 'string' ? `| ${name} | ${value} | | |` : `| ${name} | ${value.median} | ${value.bar ?? 'none'} | ${value.samples.join(', ')} |`);
  const markdown = [
    '# diff-viewer verification', '',
    `Commit: ${checkout.revision}. Uncommitted changes when the run started: ${checkout.modified ? `yes, digest ${checkout.changesDigest}` : 'no'}.`, '',
    ...rows.map((row, index) => `${index + 1}. ${row.name}: ${row.status}${row.reason ? ` (${row.reason.split('\n')[0]})` : ''}`), '',
    '| Measure (ms unless named) | Median | Bar | Samples |', '| --- | --- | --- | --- |', ...timingLines, '',
    `Exit: ${exitCode}. Level: ${options.level}. Planted fault: ${fault ?? 'none'}. Real repositories: ${realRepositories().join(', ') || 'none'}.`, '',
    'Observations (start script titles, file switches, colors, read-only fingerprints, request counts, user git config control):', '', '```json', JSON.stringify(observations, null, 2), '```', '',
    `Cleanup: ${cleanup.ownedProcesses} owned processes, ${cleanup.stopped.length} stopped by force, ${cleanup.stillRunning.length} still running.`, '',
    `Stand-ins: ${summary.standIns.join(' ')}`, '',
  ].join('\n');
  writeFileSync(path.join(evidence, 'summary.md'), markdown);
  const screens = readdirSync(path.join(evidence, 'screens')).sort();
  const escape = (text: string) => text.replace(/[&<>"]/g, char => `&#${char.charCodeAt(0)};`);
  writeFileSync(path.join(evidence, 'index.html'), `<!doctype html><meta charset="utf-8"><title>diff-viewer verification</title><h1>diff-viewer verification</h1><p>Exit ${exitCode}. <a href="summary.md">summary.md</a> <a href="summary.json">summary.json</a></p><ol>${rows.map(row => `<li>${escape(row.name)}: ${escape(row.status)}</li>`).join('')}</ol>${screens.map(name => `<h2>${escape(name)}</h2><img src="screens/${escape(name)}" style="max-width:100%">`).join('')}\n`);
}

let exitCode = 1;
try { exitCode = await run(); }
catch (error) { rows.push({name: 'harness', status: 'failed', reason: error instanceof Error ? error.stack ?? error.message : String(error)}); exitCode = 1; }
try { await stopOwnedProcesses(); }
catch (error) { cleanup.errors.push(error instanceof Error ? error.message : String(error)); }
if (exitCode === 0 && (cleanup.stillRunning.length || cleanup.errors.length)) {
  rows.push({name: 'cleanup', status: 'failed', reason: `still running: ${cleanup.stillRunning.join(', ') || 'none'}; errors: ${cleanup.errors.join('; ') || 'none'}`});
  exitCode = 1;
}
writeSummary(exitCode);
for (const row of rows) console.log(`${row.status} ${row.name}${row.reason ? `: ${row.reason.split('\n')[0]}` : ''}`);
console.log(evidence);
process.exit(exitCode);
