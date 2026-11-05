import type {
  AppError, ChangedFile, CommitHash, CommitSummary, ContextRow, DiffRow, DiffViewerApi, FileDiff, Line, RepoInfo, RepoPath, RequestedView, Result, Source, TokenColor, ViewReport,
} from '../domain/types.js';
import type * as contract from '../domain/types.js';
import { keptView } from './kept-view.js';

declare global {
  interface Window { diffViewer: DiffViewerApi }
}

// The page loads only its own files from src/web, so contract constants are restated here under their own names; the
// types keep them equal.
const LARGE_FILE_LINES: typeof contract.LARGE_FILE_LINES = 5000;
const LARGE_FILE_BYTES: typeof contract.LARGE_FILE_BYTES = 200000;
const RECENT_LIMIT: typeof contract.RECENT_LIMIT = 10;
const TITLE_SUFFIX: typeof contract.TITLE_SUFFIX = ' · diff-viewer';
const VIEW_MESSAGE_LIMIT: typeof contract.VIEW_MESSAGE_LIMIT = 4096;
const SPLIT = { initial: 0.55, min: 0.2, max: 0.8, step: 0.05 } as const;
// A file diff that answers within this time replaces the old one directly, so fast clicks never flash the loading rows.
const LOADING_DELAY_MS = 150;
// A focus refresh within this time of the last one is skipped; the Refresh button always runs.
const FOCUS_REFRESH_GAP_MS = 1000;
const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;

/** A call main refused, or a method this preload does not expose, as a failed answer like main's own. */
type Refused = { readonly ok: false; readonly error: { readonly kind: 'refused'; readonly message: string } };
type Problem = AppError | Refused['error'];

/** What the window shows. Every screen except 'repository' is a card that covers the workspace and keeps it intact. */
type Screen =
  | { readonly kind: 'loading' }
  | { readonly kind: 'firstRun' }
  | { readonly kind: 'notARepository'; readonly path: string }
  /**
   * `from`: what failed. 'start' is this window's first load of its own repository, so "Try again" reloads it. 'pick' is a
   * folder chosen in the picker or the recent list, so "Back to" returns to the repository still open. 'open' is the open
   * repository failing while in use.
   */
  | { readonly kind: 'failed'; readonly problem: Exclude<Problem, { kind: 'notARepository' }>; readonly from: 'start' | 'pick' | 'open' }
  | { readonly kind: 'repository' };

/** Where the file list comes from: one commit, or the staged or unstaged changes. */
type Origin = { readonly kind: 'commit'; readonly commit: CommitSummary } | { readonly kind: 'staged' } | { readonly kind: 'unstaged' };
type Tab = 'staged' | 'unstaged' | 'commits';

interface Selection {
  readonly origin: Origin;
  readonly files: readonly ChangedFile[];
  readonly file: ChangedFile | null;
}

type IconName = 'folder' | 'check' | 'expand' | 'file' | 'image' | 'alert' | 'sidebar' | 'merge' | 'link' | 'mark' | 'refresh';

const api = window.diffViewer;
const byId = (id: string) => document.getElementById(id)!;
const workspace = byId('workspace'), commitList = byId('commits'), fileList = byId('files'), diffArea = byId('diff'), fileHead = byId('file-head');
const menu = byId('recent-menu'), paste = byId('paste') as HTMLInputElement, split = byId('pane-split'), paneBottom = byId('pane-bottom');
const icons = (byId('icons') as HTMLTemplateElement).content;

let screen: Screen = { kind: 'loading' };
let repo: RepoInfo | null = null;
let commits: CommitSummary[] = [];
let more = false;
let selection: Selection | null = null;
let tab: Tab = 'commits';
/** The commit the Commits tab returns to. */
let lastCommit: CommitSummary | null = null;
/** The file named in the file header and the rail. It changes only together with the diff below it, so a name never sits above another file's lines. */
let shownFile: ChangedFile | null = null;
/** The diff on screen and how it was asked for, so a refresh that brings the same diff leaves the page as it is. */
let shownDiff: { readonly diff: FileDiff; readonly showLarge: boolean } | null = null;
let refreshing = false;
/** A Refresh click that came while a refresh ran; it runs once that refresh ends, so the click is never lost. */
let refreshAgain = false;
let lastRefresh = -Infinity;
const pane = { split: SPLIT.initial as number, collapsed: false };
/** Each click starts a new request; an answer to an older click is dropped. */
let latest = 0;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** A long list as one node: a spread call stops with a RangeError at about 125,000 arguments, and a commit or a file can hold more. */
function fragmentOf(nodes: readonly Node[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const node of nodes) fragment.append(node);
  return fragment;
}

const icon = (name: IconName) => icons.querySelector(`[data-icon="${name}"]`)!.cloneNode(true) as SVGElement;
const short = (hash: string) => hash.slice(0, 7);
const count = (n: number) => n.toLocaleString('en-US');
const plural = (n: number, word: string) => `${count(n)} ${word}${n === 1 ? '' : 's'}`;
const when = (iso: string) => new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const nextPaint = () => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
const sourceOf = (origin: Origin): Source => (origin.kind === 'commit' ? { kind: 'commit', hash: origin.commit.hash } : { kind: origin.kind });
const WORKING = {
  staged: { title: 'Staged changes', label: 'Staged', how: 'Last commit compared with what is staged', none: 'No staged changes', hint: 'Files you stage with git add show up here. Press Refresh after you stage them.' },
  unstaged: { title: 'Unstaged changes', label: 'Unstaged', how: 'Staged or committed files compared with the working folder', none: 'No unstaged changes', hint: 'Files you edit in the working folder show up here. Press Refresh after you save.' },
} as const;

function size(bytes: number | null): string {
  if (bytes === null) return 'none';
  if (bytes < 1000) return plural(bytes, 'byte');
  return bytes < 1e6 ? `${(bytes / 1e3).toFixed(1)} KB` : `${(bytes / 1e6).toFixed(1)} MB`;
}

async function ask<R>(call: () => Promise<R>): Promise<R | Refused> {
  try { return await call(); }
  catch (error) { return { ok: false, error: { kind: 'refused', message: error instanceof Error ? error.message : String(error) } }; }
}

const TITLE: Record<Problem['kind'], string> = {
  notARepository: 'This folder is not a git repository',
  repositoryGone: 'This repository is no longer there',
  unknownCommit: 'This commit is not in the repository',
  unknownFile: 'This file is not among the changes',
  unreadableFile: 'This file could not be read',
  gitFailed: 'Git could not read this repository',
  refused: 'The app could not finish this request',
};

function describe(problem: Problem): string {
  switch (problem.kind) {
    case 'notARepository': case 'repositoryGone': return problem.path;
    case 'unknownCommit': return `No commit starting with ${problem.text}.`;
    case 'unknownFile': return `${problem.path} has no change here.`;
    case 'unreadableFile': case 'gitFailed': case 'refused': return problem.message;
  }
}

/** Where a failed window-level load (start, Open repository, a recent repository) leaves the window. */
function screenFor(problem: Problem, from: 'start' | 'pick'): Screen {
  return problem.kind === 'notARepository' ? { kind: 'notARepository', path: problem.path } : { kind: 'failed', problem, from };
}

function notice(name: IconName | null, title: string, ...details: (string | Node)[]): HTMLElement {
  const box = element('div', 'notice');
  if (name) box.append(icon(name));
  box.append(element('div', 'big', title));
  for (const detail of details) box.append(typeof detail === 'string' ? element('div', '', detail) : detail);
  return box;
}

const fact = (text: string) => element('div', 'fact', text);

const problemNotice = (problem: Problem) => notice(null, TITLE[problem.kind], errorBox(describe(problem)));

/**
 * A repository that disappeared covers the whole window; every other failure replaces the diff. Either way no diff is on
 * screen, so the next refresh redraws the open file.
 */
function showProblem(problem: Problem): void {
  shownDiff = null;
  if (problem.kind === 'repositoryGone') show({ kind: 'failed', problem, from: 'open' });
  else diffArea.replaceChildren(problemNotice(problem));
}

function show(next: Screen): void {
  screen = next;
  closeMenu();
  const card = next.kind === 'repository' ? null : screenCard(next);
  const start = byId('start');
  start.hidden = !card;
  start.replaceChildren(...(card ? [card] : []));
  workspace.hidden = Boolean(card);
  (byId('refresh') as HTMLButtonElement).disabled = next.kind !== 'repository';
  renderHeader();
}

function openButton(label: string, primary: boolean): HTMLButtonElement {
  const button = element('button', primary ? 'primary' : '');
  button.dataset.open = '';
  button.append(icon('folder'), label);
  return button;
}

function recentList(limit: number): HTMLElement {
  const box = element('div', 'recent');
  box.append(element('h3', '', 'Recent repositories'));
  void ask(async () => ({ ok: true as const, value: await api.recent() })).then(answer => {
    if (!answer.ok) { box.append(element('div', 'none', describe(answer.error))); return; }
    const paths = answer.value.slice(0, limit);
    if (!paths.length) box.append(element('div', 'none', 'None yet. Repositories you open appear here.'));
    for (const path of paths) {
      const button = element('button');
      button.append(element('span', '', baseName(path)), element('span', 'p mono', path));
      button.addEventListener('click', () => { void openRecent(path); });
      box.append(button);
    }
  });
  return box;
}

function card(title: string, ...parts: HTMLElement[]): HTMLElement {
  const box = element('div', 'card');
  box.append(element('h2', '', title), ...parts);
  return box;
}

function actions(...buttons: HTMLButtonElement[]): HTMLElement {
  const box = element('div', 'actions');
  box.append(...buttons);
  return box;
}

function errorBox(...lines: string[]): HTMLElement {
  const box = element('div', 'err-box'), text = element('div');
  text.append(element('div', 'mono', lines[0]), ...lines.slice(1).map(line => element('div', '', line)));
  box.append(icon('alert'), text);
  return box;
}

/** "Back to <repository>" after a failed pick, when this window still has its repository open behind the card. */
function backButtons(): HTMLButtonElement[] {
  if (!repo) return [];
  const back = element('button', '', `Back to ${repo.name}`);
  back.addEventListener('click', () => show({ kind: 'repository' }));
  return [back];
}

function screenCard(next: Exclude<Screen, { kind: 'repository' }>): HTMLElement {
  switch (next.kind) {
    case 'loading': return notice(null, 'Opening the repository', element('span', 'spinner'));
    case 'firstRun': {
      const box = card('Open a git repository',
        element('p', '', 'diff-viewer shows what changed in each commit, old on the left and new on the right. It only reads the repository. It never stages, edits, or commits.'),
        actions(openButton('Open repository…', true)), recentList(RECENT_LIMIT));
      box.prepend(icon('mark'));
      return box;
    }
    case 'notARepository': {
      return card(TITLE.notARepository, errorBox(next.path, 'No .git folder was found here or in any folder above it.'),
        element('p', '', 'Choose the top folder of a project that uses git. A folder inside a project also works.'), actions(openButton('Choose another folder…', true), ...backButtons()), recentList(4));
    }
    case 'failed': {
      const { problem, from } = next;
      const back = from === 'pick' ? backButtons() : [];
      if (problem.kind === 'repositoryGone') {
        const why = from === 'pick' ? 'This folder from your recent list is no longer there. It was moved or deleted, so the list no longer holds it.' : 'The folder was moved or deleted after it was opened.';
        return card(TITLE.repositoryGone, errorBox(problem.path, why),
          element('p', '', 'Open it again from where it is now, or choose another repository.'), actions(openButton('Open repository…', true), ...back), recentList(4));
      }
      if (from !== 'start') return card(TITLE[problem.kind], errorBox(describe(problem)), actions(openButton('Open repository…', true), ...back));
      const retry = element('button', 'primary', 'Try again');
      retry.addEventListener('click', () => { void start(); });
      return card(TITLE[problem.kind], errorBox(describe(problem)), actions(retry, openButton('Open repository…', false)));
    }
  }
}

function renderHeader(): void {
  byId('repo-name').textContent = repo?.name ?? '';
  byId('repo-name').hidden = !repo;
  byId('no-repo').hidden = Boolean(repo);
  byId('branch-line').hidden = !repo;
  byId('branch').textContent = repo ? repo.branch ?? 'detached HEAD' : '';
  document.title = repo ? `${repo.name}${TITLE_SUFFIX}` : 'diff-viewer';
}

function opened(answer: Result<RepoInfo> | Refused | null): void {
  // Null: the user cancelled, or the repository opened or was focused in another window.
  if (answer === null) return;
  if (answer.ok) showRepository(answer.value);
  else show(screenFor(answer.error, 'pick'));
}

async function openFolder(): Promise<void> { opened(await ask(() => api.openRepository())); }
async function openRecent(path: RepoPath): Promise<void> { opened(await ask(() => api.openRecent(path))); }

function closeMenu(): void {
  menu.hidden = true;
  byId('repo-button').setAttribute('aria-expanded', 'false');
}

async function openMenu(): Promise<void> {
  const answer = await ask(async () => ({ ok: true as const, value: await api.recent() }));
  menu.replaceChildren(element('h3', '', 'Recent repositories'));
  if (!answer.ok) menu.append(element('div', 'menu-empty', describe(answer.error)));
  else if (!answer.value.length) menu.append(element('div', 'menu-empty', 'No repositories yet. Use Open repository.'));
  for (const path of answer.ok ? answer.value.slice(0, RECENT_LIMIT) : []) {
    const item = element('button');
    item.setAttribute('role', 'menuitem');
    item.append(path === repo?.path && screen.kind === 'repository' ? icon('check') : element('span'), element('span', 'name', baseName(path)), element('span', 'path mono', path));
    item.addEventListener('click', () => { closeMenu(); void openRecent(path); });
    menu.append(item);
  }
  menu.hidden = false;
  byId('repo-button').setAttribute('aria-expanded', 'true');
  menu.querySelector<HTMLButtonElement>('button')?.focus();
}

function showRepository(info: RepoInfo): void {
  repo = info;
  commits = [...info.commits.commits];
  more = info.commits.more;
  lastCommit = null;
  renderCommits();
  setPasteMessage('');
  showNoCommit();
  show({ kind: 'repository' });
}

/** Removes the open file and its diff, and shows `content` in the diff area instead. */
function clearDiff(...content: Node[]): void {
  shownFile = null;
  shownDiff = null;
  fileHead.hidden = true;
  diffArea.removeAttribute('aria-busy');
  diffArea.replaceChildren(...content);
}

/** The Commits tab before a commit is chosen. */
function showNoCommit(): void {
  latest++;
  tab = 'commits';
  selection = null;
  byId('selection').textContent = originLabel(null).text;
  byId('totals').replaceChildren();
  byId('summary').hidden = true;
  fileList.replaceChildren();
  clearDiff(notice(null, 'Choose a commit', 'Its changed files appear on the left, and the first file opens here.'));
  renderTabs();
  renderRail();
}

/** New counts, branch, and newest commits from main, keeping older commit pages already loaded when the newest commit is the same. */
function applyInfo(info: RepoInfo): void {
  const newest = info.commits.commits[0]?.hash;
  repo = info;
  if (newest !== commits[0]?.hash || !commits.length) {
    commits = [...info.commits.commits];
    more = info.commits.more;
    renderCommits();
  }
  renderHeader();
  renderTabs();
}

async function start(): Promise<void> {
  performance.mark('repository-requested');
  show({ kind: 'loading' });
  const answer = await ask(() => api.repository());
  if (answer === null) { show({ kind: 'firstRun' }); return; }
  if (!answer.ok) {
    show(screenFor(answer.error, 'start'));
    // A launcher that waits for this window hears the problem at once, with git's own message.
    const requested = await api.requestedView();
    if (requested) await ask(() => api.viewReady(requested.id, reportOf(answer)));
    return;
  }
  showRepository(answer.value);
  const requested = await api.requestedView();
  if (requested) await showRequested(requested);
  await nextPaint();
  performance.mark('commits-shown');
}

/**
 * Opens a view a launcher asked for, then reports to main what the page shows: the list's first file, or the problem shown
 * instead. A card that covers the repository, such as a failed pick from the recent list, gives way first, so the report
 * names what is on screen. With no source, the repository view only comes back.
 */
async function showRequested(view: RequestedView): Promise<void> {
  if (repo && screen.kind !== 'repository') show({ kind: 'repository' });
  const { source } = view;
  let listed: Listed = { ok: true, files: [] };
  if (source?.kind === 'commit') {
    const answer = await ask(() => api.resolveCommit(source.hash));
    if (!answer.ok) showProblem(answer.error);
    listed = answer.ok ? await selectCommit(answer.value) : answer;
  } else if (source) listed = await loadOrigin({ kind: source.kind }, false);
  await nextPaint();
  await ask(() => api.viewReady(view.id, reportOf(listed)));
}

/**
 * What the page tells main it shows for a requested view: the first listed file, or the problem with its shown text. A long
 * text keeps its end, where git prints its fatal line.
 */
const reportOf = (listed: Listed): ViewReport => (listed.ok ? { ok: true, firstFile: listed.files[0]?.path ?? null } : { ok: false, problem: listed.error.kind, message: describe(listed.error).slice(-VIEW_MESSAGE_LIMIT) });

function commitButton(commit: CommitSummary): HTMLButtonElement {
  const button = element('button', 'commit');
  button.dataset.hash = commit.hash;
  button.setAttribute('aria-current', String(selection?.origin.kind === 'commit' && selection.origin.commit.hash === commit.hash));
  const meta = element('span', 'meta');
  meta.append(element('span', 'mono', short(commit.hash)));
  if (commit.parents.length > 1) meta.append(element('span', 'tag', 'merge'));
  meta.append(element('span', 'who', commit.authorName), element('span', '', when(commit.authorTime)));
  button.append(element('span', 'subj', commit.subject), meta);
  button.addEventListener('click', () => { void selectCommit(commit); });
  return button;
}

function renderCommits(): void {
  byId('commit-count').textContent = more ? `${count(commits.length)}+` : count(commits.length);
  commitList.replaceChildren(...commits.map(commitButton));
  if (!commits.length) commitList.append(element('div', 'col-empty', 'This branch has no commits yet.'));
  if (more) {
    const older = element('button', 'more', 'Show older commits');
    older.addEventListener('click', () => { void loadOlder(older); });
    commitList.append(older);
  }
}

async function loadOlder(button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  const answer = await ask(() => api.commits(commits.length));
  if (!answer.ok) { showProblem(answer.error); button.disabled = false; return; }
  commits = [...commits, ...answer.value.commits];
  more = answer.value.more;
  renderCommits();
}

function setPasteMessage(text: string): void {
  const message = byId('paste-msg');
  message.textContent = text;
  message.hidden = !text;
}

async function pasteCommit(): Promise<void> {
  const text = paste.value.trim().toLowerCase();
  if (text.length < 4) { setPasteMessage('Paste at least 4 characters of a commit hash.'); return; }
  const answer = await ask(() => api.resolveCommit(text));
  if (!answer.ok) {
    if (answer.error.kind === 'repositoryGone') showProblem(answer.error);
    else setPasteMessage(answer.error.kind === 'unknownCommit' ? `No commit starting with ${text.slice(0, 12)}.` : describe(answer.error));
    return;
  }
  paste.value = '';
  setPasteMessage('');
  const row = commitList.querySelector<HTMLElement>(`.commit[data-hash="${answer.value.hash}"]`);
  row?.scrollIntoView({ block: 'nearest' });
  await selectCommit(answer.value);
}

const CHIP = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', unmerged: 'U' } as const;
const STATUS_WORD = { added: 'Added', modified: 'Modified', deleted: 'Deleted', renamed: 'Renamed', unmerged: 'Unmerged, has a merge conflict' } as const;
const statusWord = (file: ChangedFile) => (file.untracked ? 'Untracked, new file' : STATUS_WORD[file.status]);
const folder = (path: string) => { const at = path.lastIndexOf('/'); return at < 0 ? '' : path.slice(0, at); };

function chip(file: ChangedFile): HTMLElement {
  const mark = element('span', `chip ${CHIP[file.status]}`, CHIP[file.status]);
  mark.title = statusWord(file);
  return mark;
}

/** The word shown instead of line counts: the content kind, or "not counted" for a text file the listing did not count. */
const countWord = (file: ChangedFile) => (file.content === 'text' ? 'not counted' : file.content);

/**
 * Why a text file has no line counts. A commit's file has none only in a partial clone, whose missing file data the app
 * never fetches (git.ts commitListing). An untracked file has none when it is over LARGE_FILE_BYTES or the app cannot read it.
 */
const countWhy = (file: ChangedFile) => (file.content !== 'text' ? ''
  : selection?.origin.kind === 'commit' ? 'Not counted: this partial clone does not hold the file data' : `Not counted: the file is over ${size(LARGE_FILE_BYTES)}, or the app could not read it`);

function stat(added: number | null, removed: number | null, label: string, why = ''): HTMLElement {
  const box = element('span', 'stat');
  if (why && (added === null || removed === null)) box.title = why;
  if (added === null || removed === null) box.append(element('span', 'b', label));
  else box.append(element('span', 'a', `+${count(added)}`), element('span', 'd', `−${count(removed)}`));
  return box;
}

function fileButton(file: ChangedFile): HTMLButtonElement {
  const button = element('button', 'file');
  button.dataset.path = file.path;
  button.setAttribute('aria-current', String(selection?.file?.path === file.path));
  const dir = folder(file.path);
  const title = element('span', 'name');
  if (file.oldPath) title.append(baseName(file.oldPath), element('span', 'arrow', '→'), baseName(file.path));
  else title.textContent = baseName(file.path);
  const where = element('span', 'dir');
  if (file.untracked) where.append(element('span', 'tag', 'untracked'), ' ');
  where.append(file.oldPath && folder(file.oldPath) !== dir ? `${folder(file.oldPath) || 'repository root'} → ${dir || 'repository root'}` : dir || 'repository root');
  button.append(chip(file), title, stat(file.added, file.removed, countWord(file), countWhy(file)), where);
  button.addEventListener('click', () => { void selectFile(file, false); });
  return button;
}

function renderCommitSummary(commit: CommitSummary): void {
  byId('summary').hidden = false;
  byId('subject').textContent = commit.subject;
  byId('commit-meta').replaceChildren(element('span', 'mono', commit.hash), element('span', '', commit.authorName), element('span', '', when(commit.authorTime)));
  const banner = byId('banner');
  const [first, ...others] = commit.parents;
  banner.hidden = commit.parents.length === 1;
  if (!first) {
    banner.replaceChildren(icon('file'), element('span', '', 'First commit. It has no parent, so every file shows as added.'));
    return;
  }
  const text = element('span', '', 'Merge commit. Compared with first parent ');
  text.append(element('span', 'mono', short(first)));
  const firstSubject = commits.find(candidate => candidate.hash === first)?.subject;
  if (firstSubject) text.append(` (${firstSubject})`);
  text.append(others.length === 1 ? '. Second parent ' : '. Other parents ');
  others.forEach((hash, index) => text.append(...(index ? [', '] : []), element('span', 'mono', short(hash))));
  text.append(others.length === 1 ? ' is not shown.' : ' are not shown.');
  banner.replaceChildren(icon('merge'), text);
}

function markCurrent(list: HTMLElement, attribute: 'hash' | 'path', value: string): HTMLElement | null {
  let current: HTMLElement | null = null;
  for (const button of list.querySelectorAll<HTMLElement>(`button[data-${attribute}]`)) {
    const on = button.dataset[attribute] === value;
    button.setAttribute('aria-current', String(on));
    if (on) current = button;
  }
  return current;
}

/** The summary above the file header: the commit, or what the staged or unstaged view compares. */
function renderSummary(origin: Origin, files: readonly ChangedFile[] | null): void {
  if (origin.kind === 'commit') { renderCommitSummary(origin.commit); return; }
  const working = WORKING[origin.kind];
  byId('summary').hidden = false;
  byId('subject').textContent = working.title;
  byId('banner').hidden = true;
  const parts = [element('span', '', working.how)];
  if (files) {
    const untracked = files.filter(file => file.untracked).length;
    const what = !files.length ? (origin.kind === 'staged' ? 'Nothing staged' : 'Nothing changed')
      : origin.kind === 'staged' ? `${plural(files.length, 'file')} ready for the next commit` : `${plural(files.length, 'file')} changed${untracked ? `, ${count(untracked)} untracked` : ''}`;
    parts.unshift(element('span', '', what));
  }
  byId('commit-meta').replaceChildren(...parts);
}

function renderTabs(): void {
  for (const name of ['staged', 'unstaged', 'commits'] as const) byId(`${name}-tab`).setAttribute('aria-selected', String(tab === name));
  for (const kind of ['staged', 'unstaged'] as const) {
    // Null: git could not list this source; the tab's own list shows git's message.
    const n = repo ? (kind === 'staged' ? repo.stagedCount : repo.unstagedCount) : 0;
    byId(`${kind}-tab`).hidden = repo?.bare ?? false;
    byId(`${kind}-count`).textContent = n === null ? '?' : count(n);
    byId(`${kind}-dot`).className = n ? `dot ${kind}` : 'dot';
  }
  byId('commit-panel').hidden = tab !== 'commits';
  renderWorking();
}

/** The staged or unstaged tab's own panel: how many files, what is compared, and a Refresh button. */
function renderWorking(): void {
  const panel = byId('working-panel');
  panel.hidden = tab === 'commits' || !repo;
  if (tab === 'commits' || !repo) return;
  const files = selection?.origin.kind === tab ? selection.files : [];
  const n = tab === 'staged' ? repo.stagedCount : repo.unstagedCount;
  const untracked = files.filter(file => file.untracked).length;
  const line = element('div', 'line');
  const what = n === null ? 'Git could not list these files' : n ? `${plural(n, 'file')}${untracked ? `, ${count(untracked)} untracked` : ''}` : 'Nothing changed';
  line.append(element('span', n ? `dot ${tab}` : 'dot'), what);
  const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0), removed = files.reduce((sum, file) => sum + (file.removed ?? 0), 0);
  if (added + removed) line.append(stat(added, removed, ''));
  const refresh = element('button');
  refresh.dataset.refresh = '';
  refresh.append(icon('refresh'), 'Refresh');
  panel.replaceChildren(line, element('div', 'muted', `${WORKING[tab].how}.`), refresh);
}

/** What a file list comes from: "Commit" with the short hash, "Staged", or "Unstaged"; "No commit chosen" before a choice. */
function originLabel(origin: Origin | null): { readonly text: string; readonly hash: string | null } {
  if (!origin) return { text: 'No commit chosen', hash: null };
  return origin.kind === 'commit' ? { text: 'Commit', hash: short(origin.commit.hash) } : { text: WORKING[origin.kind].label, hash: null };
}

function selectionLabel(origin: Origin): (string | Node)[] {
  const { text, hash } = originLabel(origin);
  return hash ? [`${text} `, element('span', 'mono', hash)] : [text];
}

async function selectCommit(commit: CommitSummary): Promise<Listed> {
  lastCommit = commit;
  markCurrent(commitList, 'hash', commit.hash);
  return loadOrigin({ kind: 'commit', commit }, false);
}

function selectTab(next: Tab): void {
  if (next === tab) return;
  if (next !== 'commits') void loadOrigin({ kind: next }, false);
  else if (lastCommit) void selectCommit(lastCommit);
  else showNoCommit();
}

/** The file list a load showed, or the problem shown instead; 'refused' when a later click replaced the load first. */
type Listed = { readonly ok: true; readonly files: readonly ChangedFile[] } | { readonly ok: false; readonly error: Problem };
const replaced: Listed = { ok: false, error: { kind: 'refused', message: 'Another view was opened before this one appeared.' } };

/**
 * Lists the files of `origin` and opens the first one. A refresh lists them again and keeps the open file, with its scroll
 * position and "Show anyway", while it is still listed. `listed` is a list the refresh already has from main.
 */
async function loadOrigin(origin: Origin, refresh: boolean, listed: Result<readonly ChangedFile[]> | null = null): Promise<Listed> {
  const request = ++latest;
  const kept = refresh ? keptView(selection?.file?.path ?? null, shownDiff && { path: shownDiff.diff.file.path, showLarge: shownDiff.showLarge }, diffArea.scrollTop) : null;
  tab = origin.kind === 'commit' ? 'commits' : origin.kind;
  if (!refresh) {
    selection = { origin, files: [], file: null };
    clearDiff();
    renderSummary(origin, null);
    byId('selection').replaceChildren(...selectionLabel(origin));
    byId('totals').replaceChildren();
    fileList.replaceChildren();
    renderRail();
  }
  renderTabs();
  const answer = listed ?? await ask(() => api.files(sourceOf(origin)));
  if (request !== latest) return replaced;
  if (!answer.ok) { showProblem(answer.error); return answer; }
  const files = answer.value;
  const keep = kept ? files.find(file => file.path === kept.path) ?? null : null;
  selection = { origin, files, file: keep };
  // The list is newer than the counts from the last repository load, so the tab shows its length.
  if (repo && origin.kind !== 'commit') repo = { ...repo, [origin.kind === 'staged' ? 'stagedCount' : 'unstagedCount']: files.length };
  byId('selection').replaceChildren(...selectionLabel(origin), ` · ${files.length ? plural(files.length, 'file') : 'no changes'}`);
  const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0), removed = files.reduce((sum, file) => sum + (file.removed ?? 0), 0);
  byId('totals').replaceChildren(...(added + removed ? [stat(added, removed, '')] : []));
  fileList.replaceChildren(fragmentOf(files.map(fileButton)));
  renderSummary(origin, files);
  renderTabs();
  renderRail();
  if (!files.length) {
    if (origin.kind === 'commit') {
      fileList.append(element('div', 'col-empty', 'This commit changes no files.'));
      clearDiff(notice('file', 'No changed files', 'This commit records no file changes against its parent.'));
    } else {
      const working = WORKING[origin.kind];
      fileList.append(element('div', 'col-empty', `${working.none}.`));
      clearDiff(notice('file', working.none, working.hint));
    }
    renderRail();
    return { ok: true, files };
  }
  if (keep && kept) await selectFile(keep, kept.showLarge, kept.scrollTop);
  else await selectFile(files[0], false);
  return { ok: true, files };
}

/** By path, because a diff that comes back from main carries its own copy of the file. */
const placeOf = (files: readonly ChangedFile[], file: ChangedFile) => files.findIndex(entry => entry.path === file.path);

function stepFile(by: 1 | -1): void {
  if (!selection?.file) return;
  const next = selection.files[placeOf(selection.files, selection.file) + by];
  if (next) void selectFile(next, false);
}

function renderFileHead(file: ChangedFile): void {
  fileHead.hidden = false;
  const path = element('span', 'path');
  if (file.oldPath) path.append(file.oldPath, element('span', 'arrow', '→'), file.path);
  else path.append(element('span', 'muted', folder(file.path) ? `${folder(file.path)}/` : ''), baseName(file.path));
  fileHead.replaceChildren(chip(file), path, element('span', 'word', statusWord(file)), element('span', 'grow'), stat(file.added, file.removed, countWord(file), countWhy(file)));
}

function loadingPanel(file: ChangedFile): HTMLElement {
  const panel = element('div', 'diff-panel'), line = element('div', 'loading-line'), rows = element('div', 'skeleton');
  line.append(element('span', 'spinner'), `Loading diff for ${file.path}…`);
  for (let index = 0; index < 14; index++) {
    const row = element('div', 'skel-row');
    const left = element('i'), right = element('i');
    left.style.setProperty('width', `${30 + ((index * 37) % 55)}%`);
    right.style.setProperty('width', `${25 + ((index * 53) % 60)}%`);
    row.append(element('i', 'n'), left, element('i', 'n'), right);
    rows.append(row);
  }
  panel.append(line, rows);
  return panel;
}

/** Opens a file's diff. With `keepScroll` (a refresh), no loading rows show, and an unchanged diff leaves the page as it is. */
async function selectFile(file: ChangedFile, showLarge: boolean, keepScroll: number | null = null): Promise<void> {
  if (!selection) return;
  const request = ++latest;
  const { origin } = selection;
  selection = { ...selection, file };
  markCurrent(fileList, 'path', file.path)?.scrollIntoView({ block: 'nearest' });
  diffArea.setAttribute('aria-busy', 'true');
  const display = (body: HTMLElement, diff: FileDiff | null) => {
    shownFile = file;
    shownDiff = diff && { diff, showLarge };
    renderFileHead(file);
    renderRail();
    body.dataset.path = file.path;
    diffArea.replaceChildren(body);
    diffArea.scrollTop = keepScroll ?? 0;
  };
  const previous = shownDiff;
  const slow = keepScroll === null ? setTimeout(() => { if (request === latest) display(loadingPanel(file), null); }, LOADING_DELAY_MS) : undefined;
  const answer = await ask(() => api.fileDiff(sourceOf(origin), file.path, showLarge, file.oldPath));
  clearTimeout(slow);
  if (request !== latest) return;
  diffArea.removeAttribute('aria-busy');
  if (!answer.ok && answer.error.kind === 'repositoryGone') { showProblem(answer.error); return; }
  if (answer.ok && keepScroll !== null && previous?.diff.file.path === file.path && JSON.stringify(previous.diff) === JSON.stringify(answer.value)) {
    shownFile = file;
    renderFileHead(file);
    renderRail();
    return;
  }
  display(answer.ok ? diffBody(answer.value, origin) : problemNotice(answer.error), answer.ok ? answer.value : null);
}

const validColor = (color: TokenColor | null) => (color && HEX_COLOR.test(color.light) && HEX_COLOR.test(color.dark) ? color : null);

/** Columns of leading white space, a tab counting as the stylesheet's tab-size of 2. */
function indentOf(line: Line): number {
  let columns = 0;
  for (const token of line.tokens) {
    for (const char of token.text) {
      if (char === ' ') columns += 1;
      else if (char === '\t') columns += 2;
      else return columns;
    }
  }
  return columns;
}

const sameColor = (a: TokenColor | null, b: TokenColor | null) => a?.light === b?.light && a?.dark === b?.dark;

/** Neighbouring tokens that look the same join into one run, so long files need fewer elements. Unmarked white space has no visible color, so it joins any unmarked run. */
function runs(line: Line): { text: string; color: TokenColor | null; changed: boolean }[] {
  const merged: { text: string; color: TokenColor | null; changed: boolean }[] = [];
  for (const token of line.tokens) {
    const color = validColor(token.color), last = merged.at(-1);
    const blank = !token.changed && !token.text.trim();
    if (last && last.changed === token.changed && (blank || sameColor(last.color, color))) last.text += token.text;
    else merged.push({ text: token.text, color, changed: token.changed });
  }
  return merged;
}

function code(side: 'l' | 'r', line: Line): HTMLTableCellElement {
  const cell = element('td', `cd ${side}`);
  cell.append(...runs(line).map(run => {
    if (!run.color && !run.changed) return run.text;
    const span = element('span', run.changed ? 'w' : '', run.text);
    if (run.color) {
      span.style.setProperty('--tl', run.color.light);
      span.style.setProperty('--td', run.color.dark);
    }
    return span;
  }));
  const indent = indentOf(line);
  // Wrapped lines continue two columns right of the line's own indent.
  if (indent) cell.style.setProperty('--hang', `${indent + 2}ch`);
  return cell;
}

function cells(row: HTMLTableRowElement, side: 'l' | 'r', line: Line | null): void {
  if (!line) row.append(element('td', `ln ${side} empty`), element('td', `cd ${side} empty`));
  else row.append(element('td', `ln ${side}`, String(line.number)), code(side, line));
}

function gapRow(hidden: readonly ContextRow[]): HTMLTableRowElement {
  const tr = element('tr', 'gap'), td = element('td'), button = element('button');
  tr.dataset.kind = 'hidden';
  td.colSpan = 4;
  const first = hidden[0].right.number, last = hidden[hidden.length - 1].right.number;
  button.append(icon('expand'), `Show ${plural(hidden.length, 'hidden line')}`, element('span', 'range', first === last ? `line ${first}` : `lines ${first} to ${last}`));
  button.addEventListener('click', () => tr.replaceWith(fragmentOf(hidden.map(rowElement))));
  td.append(button);
  tr.append(td);
  return tr;
}

function rowElement(row: DiffRow): HTMLTableRowElement {
  if (row.kind === 'hidden') return gapRow(row.rows);
  const tr = element('tr');
  tr.dataset.kind = row.kind;
  if (row.kind === 'change') tr.className = row.left && row.right ? 'chg' : row.left ? 'del' : 'add';
  cells(tr, 'l', row.left);
  cells(tr, 'r', row.right);
  return tr;
}

function sideLabel(text: string, hash: CommitHash | null): HTMLTableCellElement {
  const th = element('th', '', hash ? `${text} ` : text);
  th.colSpan = 2;
  if (hash) th.append(element('span', 'mono', short(hash)));
  return th;
}

/** The two column labels: what the left side and the right side are. */
function sideLabels(origin: Origin, file: ChangedFile): HTMLTableCellElement[] {
  switch (origin.kind) {
    case 'commit': {
      const { commit } = origin, parent = commit.parents[0] ?? null;
      return [sideLabel(parent ? (commit.parents.length > 1 ? 'First parent' : 'Parent') : 'No parent', parent), sideLabel('Commit', commit.hash)];
    }
    case 'staged': return [sideLabel(commits.length ? 'Last commit' : 'No commit yet', null), sideLabel('Staged', null)];
    case 'unstaged': return [sideLabel(file.untracked ? 'Not in git yet' : 'Staged or last commit', null), sideLabel('Working folder', null)];
  }
}

function diffTable(rows: readonly DiffRow[], origin: Origin, file: ChangedFile): HTMLTableElement {
  const table = element('table', 'diff'), columns = element('colgroup'), head = element('thead'), headRow = element('tr'), body = element('tbody');
  columns.append(element('col', 'ln'), element('col'), element('col', 'ln'), element('col'));
  headRow.append(...sideLabels(origin, file));
  head.append(headRow);
  body.append(fragmentOf(rows.map(rowElement)));
  table.append(columns, head, body);
  return table;
}

function diffBody(diff: FileDiff, origin: Origin): HTMLElement {
  const panel = element('div', 'diff-panel');
  if (diff.file.status === 'unmerged') {
    const banner = element('div', 'banner');
    banner.append(icon('alert'), element('span', '', 'This file has a merge conflict. Left: your side before the merge. Right: the working folder, with the conflict markers.'));
    panel.append(banner);
  }
  switch (diff.kind) {
    case 'text': panel.append(diffTable(diff.rows, origin, diff.file)); break;
    case 'binary': panel.append(notice('image', 'Binary file, not shown', fact(`${size(diff.oldSize)} → ${size(diff.newSize)}`))); break;
    case 'tooLarge': {
      const show = element('button', '', 'Show anyway');
      show.id = 'show-large';
      show.addEventListener('click', () => { void selectFile(diff.file, true); });
      const measure = diff.over === 'lines' ? `has ${count(diff.lineCount)} lines, over the ${count(LARGE_FILE_LINES)}-line limit` : `is ${size(diff.byteCount)}, over the ${size(LARGE_FILE_BYTES)} limit`;
      panel.append(notice('file', 'Large file hidden', `${baseName(diff.file.path)} ${measure}. Showing it may take a few seconds.`, show));
      break;
    }
    case 'submodule': {
      const side = (hash: CommitHash | null) => (hash ? short(hash) : 'none');
      if (!diff.oldCommit && !diff.newCommit) panel.append(notice('folder', 'Folder with its own git repository', 'It is not tracked here. Its files are not shown.'));
      else if (diff.oldCommit === diff.newCommit) panel.append(notice('folder', `Submodule ${side(diff.newCommit)} has changes inside`, 'Files inside the submodule changed. They are not shown here.'));
      else panel.append(notice('folder', `Submodule: ${side(diff.oldCommit)} → ${side(diff.newCommit)}`, 'The submodule points at another commit. Its files are not shown here.'));
      break;
    }
    case 'symlink':
      panel.append(notice('link', 'Symbolic link', fact(`${diff.oldTarget ?? 'none'} → ${diff.newTarget ?? 'none'}`), 'The link target changed. The app shows the target path and does not follow it.'));
      break;
    case 'modeOnly': panel.append(notice('file', `File mode ${diff.oldMode} → ${diff.newMode}`, 'Only the file mode changed. The content is the same.')); break;
  }
  return panel;
}

function setSplit(value: number): void {
  pane.split = Math.min(SPLIT.max, Math.max(SPLIT.min, value));
  const percent = Math.round(pane.split * 100);
  paneBottom.style.setProperty('flex-basis', `${percent}%`);
  split.setAttribute('aria-valuenow', String(percent));
}

function setCollapsed(collapsed: boolean): void {
  const hadFocus = (collapsed ? byId('pane') : byId('rail')).contains(document.activeElement);
  pane.collapsed = collapsed;
  workspace.toggleAttribute('data-collapsed', collapsed);
  byId('pane').hidden = collapsed;
  byId('rail').hidden = !collapsed;
  const label = `${collapsed ? 'Show' : 'Hide'} sidebar (⌘B)`;
  for (const button of document.querySelectorAll<HTMLButtonElement>('.side-btn')) {
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-expanded', String(!collapsed));
  }
  if (hadFocus) document.querySelector<HTMLButtonElement>(`#${collapsed ? 'rail' : 'pane'} .side-btn`)?.focus();
}

function renderRail(): void {
  const file = shownFile;
  const railChip = byId('rail-chip'), railSource = byId('rail-source'), railFile = byId('rail-file');
  railChip.hidden = !file;
  if (file) {
    railChip.className = `chip ${CHIP[file.status]}`;
    railChip.textContent = CHIP[file.status];
    railChip.title = statusWord(file);
  }
  const origin = selection?.origin ?? null;
  const { text, hash } = originLabel(origin);
  railSource.className = hash ? 'src mono' : 'src';
  railSource.textContent = hash ?? text;
  railFile.textContent = file ? baseName(file.path) : selection ? 'No changes' : '';
  railFile.hidden = !railFile.textContent;
  const where = hash ? `${text} ${hash}` : text;
  const what = file && selection ? `, ${file.path} (file ${placeOf(selection.files, file) + 1} of ${selection.files.length})` : origin && origin.kind !== 'commit' && !file ? ', no changes' : '';
  byId('rail-info').title = `${where}${what}. Show sidebar (⌘B)`;
}

split.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  event.preventDefault();
  const box = byId('pane').getBoundingClientRect();
  split.setPointerCapture(event.pointerId);
  split.classList.add('dragging');
  const move = (moved: PointerEvent) => setSplit((box.bottom - moved.clientY) / box.height);
  const end = () => { split.classList.remove('dragging'); split.removeEventListener('pointermove', move); };
  split.addEventListener('pointermove', move);
  split.addEventListener('lostpointercapture', end, { once: true });
});
split.addEventListener('dblclick', () => setSplit(SPLIT.initial));
split.addEventListener('keydown', event => {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  event.preventDefault();
  setSplit(pane.split + (event.key === 'ArrowUp' ? SPLIT.step : -SPLIT.step));
});

paste.addEventListener('keydown', event => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  void pasteCommit();
});
paste.addEventListener('input', () => setPasteMessage(''));

byId('repo-button').addEventListener('click', () => { if (menu.hidden) void openMenu(); else closeMenu(); });

document.addEventListener('click', event => {
  const target = event.target instanceof Element ? event.target : null;
  if (!menu.hidden && !target?.closest('.repo')) closeMenu();
  const tabButton = target?.closest<HTMLElement>('[data-tab]');
  if (target?.closest('[data-open]')) void openFolder();
  else if (target?.closest('[data-side]')) setCollapsed(!pane.collapsed);
  else if (target?.closest('[data-refresh]')) void refresh(true);
  else if (tabButton) selectTab(tabButton.dataset.tab as Tab);
});

/**
 * Reloads the counts, the branch, and the newest commits, then redraws the open tab: its file list and open file, or
 * "Choose a commit". A commit's files cannot change, so a focus refresh reloads them only when no diff is on screen, as
 * after an error an earlier refresh left in the diff area; the Refresh button always reloads them.
 */
async function refresh(byButton: boolean): Promise<void> {
  if (screen.kind !== 'repository') return;
  if (refreshing) { refreshAgain ||= byButton; return; }
  if (!byButton && performance.now() - lastRefresh < FOCUS_REFRESH_GAP_MS) return;
  refreshing = true;
  // The button turns its icon while a refresh runs, so a refresh that finds no change still shows it happened.
  byId('refresh').setAttribute('aria-busy', 'true');
  try {
    // The open working tab's files come with the counts, so the refresh lists them once.
    const list = selection && selection.origin.kind !== 'commit' ? selection.origin.kind : null;
    const answer = await ask(() => api.repository(list));
    if (screen.kind !== 'repository' || answer === null) return;
    if (!answer.ok) { showProblem(answer.error); return; }
    applyInfo(answer.value);
    if (!selection) showNoCommit();
    else if (byButton || selection.origin.kind !== 'commit' || !shownDiff) await loadOrigin(selection.origin, true, selection.origin.kind === list ? answer.value.files : null);
  } finally {
    refreshing = false;
    byId('refresh').removeAttribute('aria-busy');
    lastRefresh = performance.now();
    if (refreshAgain) { refreshAgain = false; void refresh(true); }
  }
}

window.addEventListener('focus', () => { void refresh(false); });

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !menu.hidden) { closeMenu(); byId('repo-button').focus(); return; }
  if (screen.kind !== 'repository') return;
  if (event.metaKey && !event.altKey && !event.shiftKey && !event.ctrlKey && event.key.toLowerCase() === 'b') {
    event.preventDefault();
    setCollapsed(!pane.collapsed);
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey || event.target instanceof HTMLInputElement) return;
  if (event.key === ']' || event.key === '[') {
    event.preventDefault();
    stepFile(event.key === ']' ? 1 : -1);
  }
});

for (const button of document.querySelectorAll<HTMLButtonElement>('.side-btn')) button.append(icon('sidebar'));
setSplit(SPLIT.initial);
setCollapsed(false);
const started = start();
// A window whose own repository failed to load loads it again; start() then shows the pending view or reports the problem.
api.onRequestedView(view => { void started.then(() => (repo ? showRequested(view) : start())); });
