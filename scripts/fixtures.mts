import {existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {LARGE_FILE_BYTES} from '../src/domain/types.ts';
import {isolatedGitOut} from './isolated-git.mts';

type FileChange =
  | {path: string; content: string | Buffer; mode?: '100644' | '100755' | '120000'}
  | {path: string; submodule: string}
  | {path: string; deleted: true};
type FixtureCommit = {mark: number; subject: string; parents: number[]; changes: FileChange[]};

export const HOSTILE_FILE = '<img src=x onerror=alert(1)>.ts';
export const HTML_SUBJECT = 'Render <b>html</b> in subjects as text';
export const SLOW_CPP_FILE = 'evil.cpp';
export const SLOW_CPP_LINES = Array.from({length: 3}, () => `x: ${'[{'.repeat(2000)}`);
export const NEWEST_SUBJECT = 'Rework the app module';
export const ACCENTED_SUBJECT = 'Describe the format helper for Zoë';
export const HISTORY_COMMITS = 250;
export const TABLE_FILE = 'data/table.txt';
export const TABLE_FILE_LINES = 5001;
export const SPECIAL_ROOT_SUBJECT = 'Start the special cases';
export const SPECIAL_TARGETS_SUBJECT = 'Point at new targets';
export const SPECIAL_EDIT_SUBJECT = 'Edit the big module';
export const BIG_FILE = 'src/big.ts';
export const BIG_FILE_LINES = 4999;
export const BIG_FILE_EDITS = 50;
/** The densest file the size limits let through, for bar 3: 4,999 lines and exactly LARGE_FILE_BYTES bytes. */
export const DENSE_FILE = 'src/dense.ts';
export const NOTES_FILE = 'src/notes.ts';
export const SMALL_FILE = 'src/small.ts';
export const STEP_SUBJECT = 'Add a large file and two small ones';
export const STEP_FILES = ['a-large.txt', 'b-next.ts', 'c-last.ts'] as const;
export const SUBMODULE_COMMITS = ['a'.repeat(40), 'b'.repeat(40)] as const;
export const SYMLINK_TARGETS = ['target-one', '../somewhere/else'] as const;

const AUTHOR = 'Fixture Author <fixture@example.invalid>';
const FIRST_TIME = 1767225600;
// Fixed bytes in the SSH signature format. They verify against no key, so the fixture holds no key and stays the same on every build.
const SIGNATURE = ['-----BEGIN SSH SIGNATURE-----', 'U1NIU0lHAAAAAQ==', '-----END SSH SIGNATURE-----'];

function git(folder: string, args: string[], input?: string | Buffer): string {
  return isolatedGitOut(['-C', folder, '-c', 'core.autocrlf=false', ...args], {input}).trim();
}

const lines = (rows: string[]) => rows.join('\n') + '\n';

function appModule(edited: boolean): string {
  const rows = [
    `import {formatNote} from './format';`,
    '',
    `export const greeting = ${edited ? `'Hello, reader'` : `'Hello'`};`,
    '',
  ];
  for (let index = 1; index <= 25; index++) {
    rows.push(`export function step${index}(value: number): number {`, `  return value + ${index};`);
  }
  rows.push('', edited ? `export const footer = formatNote('Last updated by the app');` : `export const footer = formatNote('Last updated');`);
  rows.push(`export const version = ${edited ? 2 : 1};`);
  return lines(rows);
}

function binary(seed: number): Buffer {
  const bytes = Buffer.alloc(256);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // Index 8 stays zero: git calls a file binary only when it finds a NUL byte.
  for (let index = 9; index < bytes.length; index++) bytes[index] = (index * seed) % 256;
  return bytes;
}

function table(edited: boolean): string {
  const rows: string[] = [];
  for (let index = 1; index <= TABLE_FILE_LINES; index++) {
    const value = edited && index % 1000 === 0 ? `changed ${index}` : `value ${index}`;
    rows.push(`row ${String(index).padStart(4, '0')}: ${value}`);
  }
  return lines(rows);
}

const BIG_HEADER = [
  '/*', ' * A generated module for the large-diff timing check.', ' * It holds comments, strings, and template literals,', ' * so highlighting does real work on every line.', ' */',
  `import {strict as assert} from 'node:assert';`, '', `export const MODULE_NAME = 'big';`, 'assert.ok(MODULE_NAME);',
];
const BIG_BLOCK_LINES = 10;

/** 9 header lines and 499 blocks of 10 lines; the edited version changes one line in every tenth block, 50 in all. */
export function bigModule(edited: boolean): string {
  const rows = [...BIG_HEADER];
  for (let block = 0; rows.length < BIG_FILE_LINES; block++) {
    const factor = edited && block % BIG_BLOCK_LINES === 5 ? 3 : 2;
    rows.push(
      `/** Step ${block}: scales a reading. */`,
      `export interface Reading${block} { readonly id: number; readonly label: string }`,
      `export function scale${block}(value: number, reading: Reading${block}): string {`,
      `  const factor = ${block} * ${factor}; // grows with the step`,
      '  if (value > factor) {',
      `    return \`\${reading.label}: \${value * factor}\`;`,
      '  }',
      `  return reading.label.padStart(${block % 20}, ' ');`,
      '}',
      '',
    );
  }
  return lines(rows);
}

/** Statement shapes of real source, from short to long. Each takes a number; a number literal then fills its line. */
const DENSE_SHAPES = [
  (n: number) => `a${n % 10} = f(k, ${n % 7}) + `,
  (n: number) => `if (a${n % 10}) t += `,
  (n: number) => `const a${n % 10} = read(k, ${n % 7}) ?? `,
  (n: number) => `if (a${n % 10}.length > ${n % 9}) total += `,
  (n: number) => `out.push(\`\${a${n % 10}}:\${k}\`, `,
  (n: number) => `total = Math.max(total, a${n % 10}.id) + `,
  (n: number) => `k = names[${n % 5}].trim() || 'k' + `,
];

/**
 * The densest 4,999-line TypeScript module of `bytes` bytes: every line is a whole statement as long as the size allows,
 * so no line is a short `}` or a blank, and a number literal fills each line to its exact width. The edited version
 * changes one line in the middle. Highlighting time grows with tokens and line length, so this is the slowest shape a
 * file under both size limits can take while it still reads like source.
 */
export function denseModule(edited: boolean, bytes: number): string {
  const width = Math.floor(bytes / BIG_FILE_LINES) - 1;
  const extra = bytes - (width + 1) * BIG_FILE_LINES;
  const rows = Array.from({length: BIG_FILE_LINES}, (_, index) => {
    const length = width + (index < extra ? 1 : 0);
    const number = edited && index === Math.floor(BIG_FILE_LINES / 2) ? index + 1 : index;
    // The longest shapes that fit the width take turns, so a narrow module still uses its whole width.
    const fitting = DENSE_SHAPES.map(shape => shape(number)).filter(start => start.length + 3 <= length).slice(-5);
    const start = fitting.length ? fitting[index % fitting.length] : '';
    const end = start.endsWith(', ') ? ');' : ';';
    const fill = length - start.length - end.length;
    if (fill < 1) throw new Error(`denseModule: ${bytes} bytes leave too little room per line`);
    return `${start}${'9'.repeat(fill)}${end}`;
  });
  return lines(rows);
}

/** A block comment opened well above the edits, so the edited comment line sits in a hunk that does not show the opener. */
function notesModule(edited: boolean): string {
  const notes = Array.from({length: 12}, (_, index) => index === 8 ? ` * const ${edited ? 'fresh' : 'old'} = "not code";` : ` * note ${index + 1}`);
  return lines(['/*', ' * Notes about the parser.', ...notes, ' */', '', `export const limit = ${edited ? 20 : 10};`, 'export function within(value: number): boolean {', '  return value <= limit;', '}']);
}

const smallModule = (edited: boolean) => lines(['export function greet(name: string): string {', `  return \`${edited ? 'Hello again' : 'Hello'}, \${name}\`;`, '}']);

const oldNameModule = (edited: boolean) => lines(['export function rename(text: string): string {', `  return text.${edited ? 'trim().toLowerCase()' : 'trim()'};`, '}', '', 'export const kept = true;', 'export const alsoKept = 1;']);

function practiceCommits(): FixtureCommit[] {
  return [
    {mark: 1, subject: 'Start the notes app', parents: [], changes: [
      {path: 'README.md', content: lines(['# Notes', '', 'A small notes app.', 'It stores notes in a folder.'])},
      {path: 'src/app.ts', content: appModule(false)},
      {path: 'src/old-name.ts', content: oldNameModule(false)},
      {path: 'src/remove-me.ts', content: lines(['export const unused = 1;', 'export const alsoUnused = 2;'])},
      {path: 'assets/logo.png', content: binary(7)},
      {path: HOSTILE_FILE, content: lines(['export const hostile = "<script>alert(1)</script>";'])},
    ]},
    {mark: 2, subject: 'Add the generated table', parents: [1], changes: [{path: TABLE_FILE, content: table(false)}]},
    {mark: 3, subject: 'Change the logo', parents: [2], changes: [{path: 'assets/logo.png', content: binary(13)}]},
    {mark: 4, subject: 'Add a search helper', parents: [3], changes: [{path: 'src/search.ts', content: lines(['export function search(notes: string[], word: string): string[] {', '  return notes.filter(note => note.includes(word));', '}'])}]},
    {mark: 5, subject: 'Fix a typo in the README', parents: [3], changes: [{path: 'README.md', content: lines(['# Notes', '', 'A small notes app.', 'It keeps notes in a folder.'])}]},
    {mark: 6, subject: `Merge branch 'search'`, parents: [5, 4], changes: [{path: 'src/search.ts', content: lines(['export function search(notes: string[], word: string): string[] {', '  return notes.filter(note => note.includes(word));', '}'])}]},
    {mark: 7, subject: HTML_SUBJECT, parents: [6], changes: [{path: HOSTILE_FILE, content: lines(['export const hostile = "<script>alert(2)</script>";'])}, {path: SLOW_CPP_FILE, content: lines(SLOW_CPP_LINES)}]},
    {mark: 8, subject: 'Edit the generated table', parents: [7], changes: [{path: TABLE_FILE, content: table(true)}]},
    {mark: 9, subject: 'Add the format helper', parents: [8], changes: [{path: 'src/format.ts', content: lines(['export function formatNote(text: string): string {', '  return text.trim();', '}'])}]},
    {mark: 10, subject: ACCENTED_SUBJECT, parents: [9], changes: [{path: 'README.md', content: lines(['# Notes', '', 'A small notes app.', 'It keeps notes in a folder.', 'Notes are trimmed before saving.'])}]},
    {mark: 11, subject: 'Start the change log', parents: [10], changes: [{path: 'CHANGELOG.md', content: lines(['# Changes', '', '## 1', '', 'First version.'])}]},
    {mark: 12, subject: NEWEST_SUBJECT, parents: [11], changes: [
      {path: 'src/app.ts', content: appModule(true)},
      {path: 'src/added.ts', content: lines(['export const added = true;'])},
      {path: 'src/remove-me.ts', deleted: true},
      {path: 'src/old-name.ts', deleted: true},
      {path: 'src/new-name.ts', content: oldNameModule(true)},
    ]},
  ];
}

function specialCommits(): FixtureCommit[] {
  return [
    {mark: 1, subject: SPECIAL_ROOT_SUBJECT, parents: [], changes: [
      {path: BIG_FILE, content: bigModule(false)},
      {path: DENSE_FILE, content: denseModule(false, LARGE_FILE_BYTES)},
      {path: NOTES_FILE, content: notesModule(false)},
      {path: SMALL_FILE, content: smallModule(false)},
      {path: 'run.sh', content: lines(['#!/bin/sh', 'echo hi'])},
      {path: 'link', content: SYMLINK_TARGETS[0], mode: '120000'},
      {path: 'vendor/lib', submodule: SUBMODULE_COMMITS[0]},
    ]},
    {mark: 2, subject: SPECIAL_TARGETS_SUBJECT, parents: [1], changes: [
      {path: 'run.sh', content: lines(['#!/bin/sh', 'echo hi']), mode: '100755'},
      {path: 'link', content: SYMLINK_TARGETS[1], mode: '120000'},
      {path: 'vendor/lib', submodule: SUBMODULE_COMMITS[1]},
    ]},
    {mark: 3, subject: SPECIAL_EDIT_SUBJECT, parents: [2], changes: [
      {path: BIG_FILE, content: bigModule(true)},
      {path: DENSE_FILE, content: denseModule(true, LARGE_FILE_BYTES)},
      {path: NOTES_FILE, content: notesModule(true)},
      {path: SMALL_FILE, content: smallModule(true)},
    ]},
  ];
}

/** One commit whose first file is over the 5,000-line limit, so the keys step from a file shown with "Show anyway". */
function stepCommits(): FixtureCommit[] {
  return [{mark: 1, subject: STEP_SUBJECT, parents: [], changes: [
    {path: STEP_FILES[0], content: table(false)},
    {path: STEP_FILES[1], content: lines(['export const next = 1;'])},
    {path: STEP_FILES[2], content: lines(['export const last = 1;'])},
  ]}];
}

function historyCommits(): FixtureCommit[] {
  return Array.from({length: HISTORY_COMMITS}, (_, index) => ({
    mark: index + 1, subject: `History change ${index + 1}`, parents: index ? [index] : [],
    changes: [{path: `notes/note-${String(index % 20).padStart(2, '0')}.txt`, content: lines([`Note ${index % 20}`, `Revision ${index + 1}`])}],
  }));
}

/** One git fast-import stream, so the same input always yields the same object names. */
function importCommits(folder: string, commits: FixtureCommit[]): void {
  const chunks: Buffer[] = [];
  const text = (value: string) => chunks.push(Buffer.from(value));
  for (const commit of commits) {
    const time = FIRST_TIME + commit.mark * 3600;
    text(`commit refs/heads/${commit.mark === 4 ? 'search' : 'main'}\nmark :${commit.mark}\n`);
    text(`author ${AUTHOR} ${time} +0000\ncommitter ${AUTHOR} ${time} +0000\n`);
    const message = Buffer.from(commit.subject + '\n');
    text(`data ${message.length}\n`); chunks.push(message);
    const [first, ...merges] = commit.parents;
    if (first !== undefined) text(`from :${first}\n`);
    for (const parent of merges) text(`merge :${parent}\n`);
    for (const change of commit.changes) {
      if ('deleted' in change) { text(`D ${change.path}\n`); continue; }
      if ('submodule' in change) { text(`M 160000 ${change.submodule} ${change.path}\n`); continue; }
      const body = Buffer.isBuffer(change.content) ? change.content : Buffer.from(change.content);
      text(`M ${change.mode ?? '100644'} inline ${change.path}\ndata ${body.length}\n`); chunks.push(body); text('\n');
    }
    text('\n');
  }
  git(folder, ['fast-import', '--quiet', '--done'], Buffer.concat([...chunks, Buffer.from('done\n')]));
}

function createRepository(folder: string, commits: FixtureCommit[]): void {
  mkdirSync(folder, {recursive: true});
  git(folder, ['init', '--quiet', '-b', 'main']);
  importCommits(folder, commits);
  if (git(folder, ['branch', '--list', 'search'])) git(folder, ['branch', '--quiet', '-D', 'search']);
  git(folder, ['checkout', '--quiet', '--force', 'main']);
}

/** Gives the newest commit a signature header, so the git setting log.showSignature has something to print. */
function signNewestCommit(folder: string): void {
  const commit = git(folder, ['cat-file', 'commit', 'refs/heads/main']);
  const signed = commit.replace(/^committer .*$/m, line => `${line}\ngpgsig ${SIGNATURE.join('\n ')}`);
  git(folder, ['update-ref', 'refs/heads/main', git(folder, ['hash-object', '-t', 'commit', '-w', '--stdin'], signed + '\n')]);
}

function addWorkingChanges(folder: string): void {
  writeFileSync(path.join(folder, 'README.md'), lines(['# Notes', '', 'A small notes app.', 'It keeps notes in a folder.', 'Notes are trimmed before saving.', 'Staged line.']));
  mkdirSync(path.join(folder, 'src'), {recursive: true});
  writeFileSync(path.join(folder, 'src/staged-new.ts'), lines(['export const staged = true;']));
  git(folder, ['add', '--', 'README.md', 'src/staged-new.ts']);
  writeFileSync(path.join(folder, 'CHANGELOG.md'), lines(['# Changes', '', '## 1', '', 'First version.', 'Unstaged line.']));
  mkdirSync(path.join(folder, 'notes'), {recursive: true});
  writeFileSync(path.join(folder, 'notes/todo.txt'), lines(['Untracked note.']));
  // A tracked, unchanged file whose time no longer matches the index: a plain git status would then rewrite .git/index.
  utimesSync(path.join(folder, 'src/format.ts'), FIRST_TIME, FIRST_TIME);
}

/** The practice repository: 12 commits on main, the newest signed, plus staged, unstaged, and untracked changes. */
export function createPractice(folder: string): void {
  createRepository(folder, practiceCommits());
  signNewestCommit(folder);
  addWorkingChanges(folder);
}

/**
 * The practice repository with its working changes dropped and an empty commit on top, so staged and unstaged are both empty.
 * Its writes use this file's git, so the user's global config (commit signing, hooks) cannot make them fail.
 */
export function createCleanPractice(folder: string): void {
  createPractice(folder);
  git(folder, ['reset', '--quiet', '--hard', 'HEAD']);
  git(folder, ['clean', '--quiet', '-fd']);
  git(folder, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'Empty commit']);
}

export interface Fixtures {
  readonly practice: string;
  readonly history: string;
  /** Submodule, symlink, and mode-only changes, then a 4,999-line TypeScript file edited in 50 places and a dense one edited once. */
  readonly special: string;
  /** One commit: a 5,001-line file, then two small files. */
  readonly step: string;
  /** A bare clone of practice. */
  readonly bare: string;
}

export function createFixtures(root: string): Fixtures {
  if (existsSync(root) && readdirSync(root).length) throw new Error(`Fixture folder is not empty: ${root}`);
  const practice = path.join(root, 'practice'), history = path.join(root, 'history'), special = path.join(root, 'special'), step = path.join(root, 'step'), bare = path.join(root, 'practice.git');
  createPractice(practice);
  createRepository(history, historyCommits());
  createRepository(special, specialCommits());
  createRepository(step, stepCommits());
  git(root, ['clone', '--quiet', '--bare', '--no-local', practice, bare]);
  return {practice, history, special, step, bare};
}

/** The old and new text of src/app.ts in the newest commit, for the side-by-side checks. */
export const APP_CHANGES = [
  {old: `export const greeting = 'Hello';`, new: `export const greeting = 'Hello, reader';`},
  {old: `export const version = 1;`, new: `export const version = 2;`},
];

if (import.meta.main) {
  const [target, ...rest] = process.argv.slice(2);
  if (!target || rest.length || target.startsWith('-')) {
    console.error('Usage: scripts/fixtures DIR\nBuilds the practice repository (DIR/practice), the 250-commit history repository (DIR/history), the special-cases repository (DIR/special), the one-commit step repository (DIR/step), and a bare clone of practice (DIR/practice.git). DIR must be empty or missing.');
    process.exit(2);
  }
  const made = createFixtures(path.resolve(target));
  console.log(Object.entries(made).map(([name, folder]) => `${name} ${folder}`).join('\n'));
}
