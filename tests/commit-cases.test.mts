import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmodSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {parseRequest} from '../src/app/boundary.ts';
import {changedFiles, commitPage, fileDiff, openRepository, repositoryInfo, resolveCommit, resolveRevision} from '../src/app/git.ts';
import type {Repository} from '../src/app/git.ts';
import {createHighlighter} from '../src/app/highlight.ts';
import {createFixtures, denseModule} from '../scripts/fixtures.mts';
import {fingerprint} from '../scripts/fingerprint.mts';
import {LARGE_FILE_BYTES} from '../src/domain/types.ts';
import type {CommitHash, FileDiff, FilePath, Line} from '../src/domain/types.ts';
import {env, lines, partialClone, scratchFolder, shape, textOf, value, withGitOnPath, withoutHeadObject} from './repo-sandbox.mts';

const {scratch, sandbox} = scratchFolder('cases');
const open = async (folder: string): Promise<Repository> => value(await openRepository(folder));
const source = (hash: CommitHash) => ({kind: 'commit', hash}) as const;
const diffOf = async (repo: Repository, hash: CommitHash, file: string, showLarge = false): Promise<FileDiff> => value(await fileDiff(repo, source(hash), file as FilePath, showLarge));

test('diff-rows-hidden-lines: 3 lines of context around a change, the rest hidden but present', async () => {
  const box = sandbox('hidden');
  box.write('notes.txt', lines(20));
  box.commit('Add notes');
  box.write('notes.txt', lines(20, {10: 'ten'}));
  const hash = box.commit('Edit line 10');
  const diff = await diffOf(await open(box.folder), hash, 'notes.txt');
  assert.equal(diff.kind, 'text');
  assert.deepEqual(shape(diff.kind === 'text' ? diff.rows : []), [
    'hidden 1-6', 'context 7:line 7|7:line 7', 'context 8:line 8|8:line 8', 'context 9:line 9|9:line 9',
    'change 10:line 10|10:ten', 'context 11:line 11|11:line 11', 'context 12:line 12|12:line 12', 'context 13:line 13|13:line 13', 'hidden 14-20',
  ]);
});

test('large-file: over 5,000 lines stays collapsed until showLarge', async () => {
  const box = sandbox('large');
  box.write('big.txt', lines(5001));
  const hash = box.commit('Add a big file');
  const repo = await open(box.folder);
  const collapsed = await diffOf(repo, hash, 'big.txt');
  assert.deepEqual(collapsed.kind === 'tooLarge' && collapsed.over === 'lines' && collapsed.lineCount, 5001);
  const shown = await diffOf(repo, hash, 'big.txt', true);
  assert.equal(shown.kind === 'text' && shown.rows.length, 5001);
});

test('large-bytes: a version over 200 KB answers tooLarge from its size, and neither version is read until showLarge', async () => {
  const box = sandbox('bytes');
  // One 600,012-byte line, as in a minified bundle, and 1,000,000 short lines with one changed.
  const wide = (letter: string) => `{"data":"${letter.repeat(600_000)}"}\n`;
  box.write('bundle.json', wide('a'));
  box.write('table.csv', lines(1_000_000));
  box.commit('Add');
  box.write('bundle.json', wide('b'));
  box.write('table.csv', lines(1_000_000, {500_000: 'changed'}));
  const hash = box.commit('Change');
  const repo = await open(box.folder);
  const {result: [bundle, table], calls} = await withGitOnPath(scratch, async () => [await diffOf(repo, hash, 'bundle.json'), await diffOf(repo, hash, 'table.csv')]);
  assert.deepEqual(bundle.kind === 'tooLarge' && bundle.over === 'bytes' && bundle.byteCount, 600_012);
  assert.deepEqual(table.kind === 'tooLarge' && table.over === 'bytes' && table.byteCount, 11_888_896);
  assert.deepEqual(calls.filter(call => call.includes('cat-file blob')), [], 'no version was read to decide');
  const shown = await diffOf(repo, hash, 'bundle.json', true);
  assert.deepEqual(shown.kind === 'text' && shape(shown.rows), ['change 1:' + wide('a').slice(0, -1) + '|1:' + wide('b').slice(0, -1)]);
});

test('commit-pages: 250 commits come as a page of 200 with more, then the oldest 50 without', async () => {
  const box = sandbox('pages');
  for (let index = 1; index <= 250; index++) box.git('commit', '--quiet', '--allow-empty', '-m', `Commit ${index}`);
  const repo = await open(box.folder);
  const first = value(await commitPage(repo, 0));
  const second = value(await commitPage(repo, 200));
  assert.deepEqual([first.commits.length, first.more, first.commits[0].subject, first.commits[199].subject], [200, true, 'Commit 250', 'Commit 51']);
  assert.deepEqual([second.commits.length, second.more, second.commits[0].subject, second.commits[49].subject], [50, false, 'Commit 50', 'Commit 1']);
});

test('resolve-prefix-batch: a prefix shared by a commit and a blob picks the commit with one cat-file call', async () => {
  const box = sandbox('prefix');
  box.write('a.txt', 'a\n');
  const commit = box.commit('Start');
  const prefix = commit.slice(0, 4);
  const blobName = (text: string) => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0${text}`).digest('hex');
  let text = '';
  for (let index = 0; !blobName(text).startsWith(prefix); index++) text = `blob ${index}\n`;
  box.write('blob.txt', text);
  assert.equal(box.git('hash-object', '-w', 'blob.txt'), blobName(text));
  const repo = await open(box.folder);
  const {result, calls} = await withGitOnPath(scratch, () => resolveCommit(repo, prefix));
  assert.equal(value(result).hash, commit);
  assert.equal(calls.filter(call => /(^| )cat-file /.test(call)).length, 1, `one cat-file call: ${calls.join(' | ')}`);
});

test('git-missing: without git on PATH, opening a folder says git is missing instead of not a repository', async () => {
  const box = sandbox('no-git');
  const {result} = await withGitOnPath(scratch, () => openRepository(box.folder), {git: false});
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.kind, 'gitFailed');
  assert.match(!result.ok && result.error.kind === 'gitFailed' ? result.error.message : '', /^git was not found on PATH\./);
});

test('not-a-repository-only: only git\'s own "not a git repository" answer gives notARepository; other failures keep git\'s line', async () => {
  const box = sandbox('bad-config');
  box.write('a.txt', 'a\n');
  box.commit('Start');
  writeFileSync(path.join(box.folder, '.git/config'), '[bad\n', {flag: 'a'});
  const broken = await openRepository(box.folder);
  assert.equal(!broken.ok && broken.error.kind, 'gitFailed', 'a repository with a broken .git/config is not called "not a repository"');
  assert.match(!broken.ok && broken.error.kind === 'gitFailed' ? broken.error.message : '', /bad config line/);
  const plain = path.join(scratch, 'plain-folder');
  mkdirSync(plain);
  assert.deepEqual(await openRepository(plain), {ok: false, error: {kind: 'notARepository', path: plain}});
  const missing = path.join(scratch, 'no-such-folder');
  assert.deepEqual(await openRepository(missing), {ok: false, error: {kind: 'notARepository', path: missing}});
});

test('not-a-repository-localized: a git that answers in another language still gives notARepository for a plain folder', async () => {
  // A stand-in git that answers in German unless LC_ALL=C, as a git built with translations does under a German locale.
  const bin = path.join(scratch, 'localized-git');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nif [ "$LC_ALL" = C ]; then echo "fatal: not a git repository (or any of the parent directories): .git" >&2; else echo "fatal: Kein Git-Repository" >&2; fi\nexit 128\n', {mode: 0o755});
  const plain = path.join(scratch, 'plain-localized');
  mkdirSync(plain);
  const saved = {PATH: process.env.PATH, LC_ALL: process.env.LC_ALL, LANG: process.env.LANG};
  Object.assign(process.env, {PATH: bin, LC_ALL: 'de_DE.UTF-8', LANG: 'de_DE.UTF-8'});
  try {
    assert.deepEqual(await openRepository(plain), {ok: false, error: {kind: 'notARepository', path: plain}});
  } finally {
    for (const [name, before] of Object.entries(saved)) { if (before === undefined) delete process.env[name]; else process.env[name] = before; }
  }
});

test('file-click-path-limited: one file\'s diff lists only that file, and a rename sent with its old path stays a rename', async () => {
  const box = sandbox('path-limited');
  box.write('src/old.ts', lines(8));
  for (let index = 0; index < 20; index++) box.write(`other/${index}.txt`, lines(3));
  box.commit('Start');
  rmSync(path.join(box.folder, 'src/old.ts'));
  box.write('lib/new.ts', lines(8, {4: 'four'}));
  for (let index = 0; index < 20; index++) box.write(`other/${index}.txt`, lines(3, {2: 'two'}));
  const hash = box.commit('Rename and touch others');
  const repo = await open(box.folder);
  const {result: [renamed, other], calls} = await withGitOnPath(scratch, async () => [
    value(await fileDiff(repo, source(hash), 'lib/new.ts' as FilePath, false, 'src/old.ts' as FilePath)),
    value(await fileDiff(repo, source(hash), 'other/7.txt' as FilePath, false)),
  ]);
  assert.deepEqual(renamed.kind === 'text' && [renamed.file.status, renamed.file.oldPath], ['renamed', 'src/old.ts']);
  assert.deepEqual(renamed.kind === 'text' && renamed.rows.filter(row => row.kind === 'change').map(row => `${textOf(row.left)}|${textOf(row.right)}`), ['4:line 4|4:four']);
  assert.deepEqual(other.kind === 'text' && other.file.status, 'modified');
  const listings = calls.filter(call => / diff-tree .*--raw/.test(call));
  assert.deepEqual(listings.map(call => call.slice(call.lastIndexOf(' -- ') + 4)), ['src/old.ts lib/new.ts', 'other/7.txt'], `each listing names only the asked file: ${listings.join(' | ')}`);
});

test('large-diff-lines: two versions under 5,000 lines whose diff is over 5,000 lines stay collapsed', async () => {
  const box = sandbox('large-diff');
  box.write('wide.txt', lines(3000));
  box.commit('Start');
  box.write('wide.txt', Array.from({length: 3000}, (_, index) => `changed ${index + 1}`).join('\n') + '\n');
  const hash = box.commit('Change every line');
  const repo = await open(box.folder);
  const collapsed = await diffOf(repo, hash, 'wide.txt');
  assert.deepEqual(collapsed.kind === 'tooLarge' && collapsed.over === 'lines' && collapsed.lineCount, 6000, '3,000 removed and 3,000 added lines count as 6,000');
});

test('rename-and-binary: a renamed file with edits, and a binary file with both sizes', async () => {
  const box = sandbox('rename');
  box.write('src/old.ts', lines(8));
  box.write('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  box.commit('Start');
  rmSync(path.join(box.folder, 'src/old.ts'));
  box.write('lib/new.ts', lines(8, {4: 'four'}));
  box.write('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9, 9, 9]));
  const hash = box.commit('Rename and redraw');
  const repo = await open(box.folder);
  const files = value(await changedFiles(repo, source(hash)));
  assert.deepEqual(files.map(file => [file.path, file.oldPath, file.status, file.content, file.added, file.removed]), [
    ['lib/new.ts', 'src/old.ts', 'renamed', 'text', 1, 1],
    ['logo.png', null, 'modified', 'binary', null, null],
  ]);
  // The page sends a renamed file's old path with it, as the listing gave it.
  const renamed = value(await fileDiff(repo, source(hash), 'lib/new.ts' as FilePath, false, 'src/old.ts' as FilePath));
  assert.deepEqual(renamed.kind === 'text' && renamed.rows.filter(row => row.kind === 'change').map(row => `${textOf(row.left)}|${textOf(row.right)}`), ['4:line 4|4:four']);
  const binary = await diffOf(repo, hash, 'logo.png');
  assert.deepEqual(binary.kind === 'binary' && [binary.oldSize, binary.newSize], [8, 10]);
});

test('merge-first-parent: a merge commit lists what the merge brought in against its first parent', async () => {
  const box = sandbox('merge');
  box.write('base.txt', 'base\n');
  box.commit('Base');
  box.git('checkout', '--quiet', '-b', 'side');
  box.write('side.txt', 'from the side branch\n');
  box.commit('Side work');
  box.git('checkout', '--quiet', 'main');
  box.write('main.txt', 'on main\n');
  box.commit('Main work');
  box.git('merge', '--quiet', '--no-ff', '--no-edit', 'side');
  const merge = box.git('rev-parse', 'HEAD') as CommitHash;
  const repo = await open(box.folder);
  const info = value(await repositoryInfo(repo));
  assert.equal(info.commits.commits[0].parents.length, 2);
  const files = value(await changedFiles(repo, source(merge)));
  assert.deepEqual(files.map(file => [file.path, file.status]), [['side.txt', 'added']]);
});

test('root-commit: the first commit shows every file as added', async () => {
  const box = sandbox('root');
  box.write('a.txt', 'a\n');
  box.write('dir/b.txt', 'b\nb\n');
  const hash = box.commit('First');
  const repo = await open(box.folder);
  const files = value(await changedFiles(repo, source(hash)));
  assert.deepEqual(files.map(file => [file.path, file.status, file.added]), [['a.txt', 'added', 1], ['dir/b.txt', 'added', 2]]);
  const diff = await diffOf(repo, hash, 'dir/b.txt');
  assert.deepEqual(diff.kind === 'text' && shape(diff.rows), ['change -|1:b', 'change -|2:b']);
});

test('submodule-symlink-mode: a submodule pointer, a symlink target, and a mode-only change', async () => {
  const box = sandbox('special');
  const first = 'a'.repeat(40), second = 'b'.repeat(40);
  box.write('run.sh', 'echo hi\n');
  symlinkSync('target-one', path.join(box.folder, 'link'));
  box.git('add', 'run.sh', 'link');
  box.git('update-index', '--add', '--cacheinfo', `160000,${first},vendor/lib`);
  box.git('commit', '--quiet', '-m', 'Start');
  chmodSync(path.join(box.folder, 'run.sh'), 0o755);
  rmSync(path.join(box.folder, 'link'));
  symlinkSync('../somewhere/else', path.join(box.folder, 'link'));
  box.git('update-index', '--cacheinfo', `160000,${second},vendor/lib`);
  box.git('add', 'run.sh', 'link');
  box.git('commit', '--quiet', '-m', 'Change all three');
  const hash = box.git('rev-parse', 'HEAD') as CommitHash;
  const repo = await open(box.folder);
  const files = value(await changedFiles(repo, source(hash)));
  assert.deepEqual(files.map(file => [file.path, file.content]), [['link', 'symlink'], ['run.sh', 'text'], ['vendor/lib', 'submodule']]);
  const submodule = await diffOf(repo, hash, 'vendor/lib');
  assert.deepEqual(submodule.kind === 'submodule' && [submodule.oldCommit, submodule.newCommit], [first, second]);
  const link = await diffOf(repo, hash, 'link');
  assert.deepEqual(link.kind === 'symlink' && [link.oldTarget, link.newTarget], ['target-one', '../somewhere/else']);
  const mode = await diffOf(repo, hash, 'run.sh');
  assert.deepEqual(mode.kind === 'modeOnly' && [mode.oldMode, mode.newMode], ['100644', '100755']);
});

test('bare-repository: a bare clone has commits only, with no staged or unstaged changes', async () => {
  const {practice} = createFixtures(path.join(scratch, 'fixtures'));
  const bare = path.join(scratch, 'practice.git');
  execFileSync('git', ['clone', '--quiet', '--bare', practice, bare], {env});
  const repo = await open(bare);
  assert.equal(repo.bare, true);
  const info = value(await repositoryInfo(repo));
  assert.deepEqual([info.bare, info.stagedCount, info.unstagedCount, info.commits.commits.length, info.name], [true, 0, 0, 12, 'practice.git']);
  const files = value(await changedFiles(repo, source(info.commits.commits[0].hash)));
  assert.ok(files.some(file => file.path === 'src/app.ts'), 'a commit of a bare repository lists its files');
  const diff = await diffOf(repo, info.commits.commits[0].hash, 'src/app.ts');
  assert.equal(diff.kind, 'text');
});

test('large-bytes-dense: the densest 4,999-line file over 200,000 bytes stays collapsed, and one at the limit shows highlighted', async () => {
  const box = sandbox('dense');
  box.write('over.ts', denseModule(false, 200_001));
  box.write('at.ts', denseModule(false, LARGE_FILE_BYTES));
  box.commit('Add');
  box.write('over.ts', denseModule(true, 200_001));
  box.write('at.ts', denseModule(true, LARGE_FILE_BYTES));
  const hash = box.commit('Change');
  const repo = await open(box.folder);
  const over = await diffOf(repo, hash, 'over.ts');
  assert.deepEqual(over.kind === 'tooLarge' && over.over === 'bytes' && over.byteCount, 200_001, `a 200,001-byte dense file is over the size limit (got ${over.kind})`);
  const at = await diffOf(repo, hash, 'at.ts');
  assert.equal(at.kind, 'text');
  assert.equal(at.kind === 'text' && at.rows.filter(row => row.kind === 'change').length, 1, 'the dense file at the limit shows its one changed line');
});

test('resolve-revision: HEAD becomes a full commit hash before a diff request', async () => {
  const box = sandbox('revision');
  box.write('one.txt', 'one\n');
  const hash = box.commit('First');
  const repo = await open(box.folder);
  assert.deepEqual(await resolveRevision(repo, 'HEAD'), {ok: true, value: hash});
  assert.deepEqual(await resolveRevision(repo, 'missing-commit'), {ok: false, error: {kind: 'unknownCommit', text: 'missing-commit'}});
  assert.deepEqual(await resolveRevision(repo, 'HEAD^{tree}'), {ok: false, error: {kind: 'unknownCommit', text: 'HEAD^{tree}'}}, 'a name for an object that is not a commit');
  const absent = '0123456789abcdef0123456789abcdef01234567';
  assert.deepEqual(await resolveRevision(repo, absent), {ok: false, error: {kind: 'unknownCommit', text: absent}}, 'a full hash the repository does not hold');
});

test('resolve-revision-unreadable: a commit git cannot read is a git failure with git\'s line, not an unknown commit', async () => {
  const box = sandbox('revision-unreadable');
  box.write('one.txt', 'one\n');
  box.commit('First');
  const hash = withoutHeadObject(box.folder);
  const result = await resolveRevision(await open(box.folder), 'HEAD');
  assert.equal(result.ok ? 'ok' : result.error.kind, 'gitFailed', `got ${JSON.stringify(result)}`);
  assert.match(result.ok || result.error.kind !== 'gitFailed' ? '' : result.error.message, new RegExp(`${hash}[\\s\\S]*fatal: `), 'the message names the commit and git\'s line');
});

test('not-utf8: text in another encoding is read as UTF-8, with the replacement character for bytes that are not valid UTF-8', async () => {
  const box = sandbox('latin-1');
  box.write('name.txt', Buffer.from('caf\xe9 cr\xe8me\n', 'latin1'));
  box.commit('Latin-1 text');
  box.write('name.txt', 'café crème\n');
  const hash = box.commit('UTF-8 text');
  const diff = await diffOf(await open(box.folder), hash, 'name.txt');
  assert.equal(diff.kind, 'text', 'a Latin-1 file is text, not binary');
  assert.deepEqual(shape(diff.kind === 'text' ? diff.rows : []), ['change 1:caf\ufffd cr\ufffdme|1:café crème']);
});

test('resolve-commit: a pasted prefix finds one commit on any branch; unknown or ambiguous text does not', async () => {
  const box = sandbox('resolve');
  const stream: string[] = [];
  for (let mark = 1; mark <= 1000; mark++) {
    stream.push(`commit refs/heads/main\nmark :${mark}\ncommitter Case <case@example.invalid> ${1767225600 + mark} +0000\ndata 5\nc${String(mark).padStart(4, '0')}\n${mark > 1 ? `from :${mark - 1}\n` : ''}\n`);
  }
  execFileSync('git', ['-C', box.folder, 'fast-import', '--quiet'], {input: stream.join(''), env});
  const hashes = box.git('rev-list', 'main').split('\n');
  const byPrefix = new Map<string, string[]>();
  for (const hash of hashes) byPrefix.set(hash.slice(0, 4), [...byPrefix.get(hash.slice(0, 4)) ?? [], hash]);
  const shared = [...byPrefix.values()].find(group => group.length > 1);
  assert.ok(shared, 'two of the 1,000 commits share their first 4 hex characters');
  box.write('side.txt', 'side\n');
  box.git('checkout', '--quiet', '--orphan', 'side');
  const sideHash = box.commit('Only on the side branch');
  box.git('checkout', '--quiet', 'main');
  const unique = hashes.find(hash => byPrefix.get(hash.slice(0, 4))?.length === 1)!;
  box.git('branch', unique.slice(0, 4), hashes[hashes.length - 1]);
  const repo = await open(box.folder);
  const resolved = async (text: string) => { const result = await resolveCommit(repo, text); return result.ok ? result.value.hash : result.error.kind; };
  assert.equal(await resolved(sideHash.slice(0, 7)), sideHash, 'a commit on another branch');
  assert.equal(await resolved(sideHash.toUpperCase()), sideHash, 'a full hash in capitals');
  assert.equal(await resolved(unique.slice(0, 4)), unique, 'a 4-character prefix wins over a branch with the same name');
  assert.equal(await resolved(shared[0].slice(0, 4)), 'unknownCommit', 'an ambiguous prefix');
  for (const text of ['0000000', 'abc', 'main', '--all', 'HEAD~1', 'a'.repeat(41)]) assert.equal(await resolved(text), 'unknownCommit', text);
});

test('highlight-multiline: a block comment opened above a hunk colors the changed line inside it', async () => {
  const box = sandbox('multiline');
  const source = (inner: string) => ['/*', ...Array.from({length: 10}, (_, index) => index === 6 ? inner : ` * note ${index}`), ' */', 'const value = 1;'].join('\n') + '\n';
  box.write('notes.ts', source(' * const old = "not code";'));
  box.commit('Add notes');
  box.write('notes.ts', source(' * const fresh = "not code";'));
  const hash = box.commit('Edit the comment');
  const diff = await diffOf(await open(box.folder), hash, 'notes.ts');
  assert.equal(diff.kind, 'text');
  const rows = diff.kind === 'text' ? diff.rows : [];
  assert.equal(rows[0].kind, 'hidden', 'the line that opens the comment is outside the hunk');
  const change = rows.find(row => row.kind === 'change');
  assert.ok(change?.kind === 'change' && change.left && change.right);
  const comment = {light: '#6A737D', dark: '#6A737D'};
  for (const line of [change.left, change.right]) assert.deepEqual(new Set(line.tokens.map(token => JSON.stringify(token.color))), new Set([JSON.stringify(comment)]), `every token on line ${line.number} has the comment color`);
  assert.deepEqual(change.right.tokens.filter(token => token.changed).map(token => token.text), ['fresh'], 'changed-word marks are applied after highlighting');
  const code = rows.at(-1);
  assert.ok(code?.kind === 'context' || code?.kind === 'hidden');
  const last = code.kind === 'hidden' ? code.rows.at(-1)!.right : code.right;
  assert.notDeepEqual(last.tokens[0].color, comment, 'code after the comment is colored as code');
});

test('crlf-lines: rows of a CRLF file hold no carriage return, and their colors equal whole-file highlighting', async () => {
  const box = sandbox('crlf');
  const before = ['/* A block comment', ' * over two lines */', 'export const a = 1;', ...Array.from({length: 12}, (_, index) => `const v${index} = "${index}";`), 'export const z = 2;'];
  const after = before.map((row, index) => index === 2 ? 'export const a = 10;' : index === 14 ? 'const v11 = "eleven";' : row);
  const crlf = (rows: string[]) => rows.map(row => `${row}\r\n`).join(''), lf = (rows: string[]) => rows.map(row => `${row}\n`).join('');
  box.write('both.ts', crlf(before));
  box.write('old-only.ts', crlf(before));
  box.commit('Add CRLF files');
  box.write('both.ts', crlf(after));
  box.write('old-only.ts', lf(after));
  const hash = box.commit('Edit CRLF files');
  const repo = await open(box.folder);
  const {version} = createHighlighter();
  const colors = (tokens: Line['tokens']) => tokens.flatMap(token => Array.from(token.text, character => `${character} ${token.color?.light}/${token.color?.dark}`));
  for (const file of ['both.ts', 'old-only.ts']) {
    const diff = await diffOf(repo, hash, file);
    assert.equal(diff.kind, 'text');
    const rows = diff.kind === 'text' ? diff.rows : [];
    const shown = rows.flatMap((row): readonly {left: Line | null; right: Line | null}[] => row.kind === 'hidden' ? row.rows : [row]).flatMap(row => [['old', row.left], ['new', row.right]] as const);
    const whole = {old: await version(lf(before), file), new: await version(lf(after), file)};
    let checked = 0;
    for (const [side, line] of shown) {
      if (!line) continue;
      assert(!line.tokens.some(token => token.text.includes('\r')), `${file} ${side} line ${line.number} holds no carriage return`);
      assert.deepEqual(colors(line.tokens), colors(whole[side][line.number - 1]), `${file} ${side} line ${line.number} has the colors of whole-file highlighting`);
      checked++;
    }
    assert.equal(checked, before.length + after.length, `${file}: every line of both versions was checked`);
  }
});

test('sha256-repository: a repository with 64-character object names lists, shows, and resolves its commits', async () => {
  const folder = path.join(scratch, 'sha256');
  const git = (...args: string[]) => execFileSync('git', ['-C', folder, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {encoding: 'utf8', env}).trim();
  execFileSync('git', ['init', '--quiet', '--object-format=sha256', '-b', 'main', folder], {env});
  writeFileSync(path.join(folder, 'notes.txt'), lines(5));
  git('add', 'notes.txt');
  git('commit', '--quiet', '-m', 'Add notes');
  writeFileSync(path.join(folder, 'notes.txt'), lines(5, {3: 'three'}));
  git('commit', '--quiet', '-am', 'Edit line 3');
  const repo = await open(folder);
  const newest = value(await repositoryInfo(repo)).commits.commits[0];
  assert.equal(newest.hash.length, 64);
  assert.deepEqual(parseRequest('files', [{kind: 'commit', hash: newest.hash}]), {method: 'files', source: {kind: 'commit', hash: newest.hash}}, 'main accepts the page asking for this commit');
  const diff = await diffOf(repo, newest.hash, 'notes.txt');
  assert.deepEqual(diff.kind === 'text' && diff.rows.filter(row => row.kind === 'change').map(row => `${textOf(row.left)}|${textOf(row.right)}`), ['3:line 3|3:three']);
  const resolved = async (text: string) => { const result = await resolveCommit(repo, text); return result.ok ? result.value.hash : result.error.kind; };
  assert.equal(await resolved(newest.hash), newest.hash, 'a pasted full 64-character hash');
  assert.equal(await resolved(newest.hash.slice(0, 7)), newest.hash, 'a pasted short hash');
});

test('partial-clone-no-fetch: in a partial clone a commit lists its files without line counts when a blob is missing; only that file\'s diff shows git\'s error; git fetches nothing and .git stays unchanged', async () => {
  const box = sandbox('promisor-source');
  box.write('kept.txt', lines(3));
  box.write('moved.txt', lines(40));
  box.write('same.txt', lines(5));
  box.commit('First');
  box.write('kept.txt', lines(3, {2: 'two'}));
  box.git('mv', 'moved.txt', 'renamed.txt');
  box.write('renamed.txt', lines(40, {7: 'seven'}));
  box.git('mv', 'same.txt', 'same-renamed.txt');
  box.write('new.txt', 'new\n');
  box.git('add', '-A');
  const head = box.commit('Second');
  // Only HEAD's blobs come with the clone; the first commit's versions of kept.txt and moved.txt stay on the promisor remote (same.txt's data is in HEAD).
  const clone = partialClone(scratch, box.folder, 'partial');
  const packs = () => readdirSync(path.join(clone, '.git/objects/pack')).length;
  const before = {print: fingerprint(clone), packs: packs()};
  const repo = await open(clone);
  const listed = await changedFiles(repo, source(head));
  assert.equal(listed.ok, true, `the commit's file list works without the missing blobs: ${JSON.stringify(listed)}`);
  const files = value(listed).map(file => `${file.status} ${file.path}${file.oldPath ? ` from ${file.oldPath}` : ''} ${file.content} ${file.added}/${file.removed}`);
  // Without the file data git can match only exact renames, so the edited rename is listed as a delete and an add.
  assert.deepEqual(files, ['modified kept.txt text null/null', 'deleted moved.txt text null/null', 'added new.txt text null/null', 'added renamed.txt text null/null', 'renamed same-renamed.txt from same.txt text null/null'],
    'every file is listed, without line counts');
  const diff = await fileDiff(repo, source(head), 'kept.txt' as FilePath, false);
  assert.equal(!diff.ok && diff.error.kind, 'gitFailed', `the clicked file names git's failure instead of fetching: ${JSON.stringify(diff)}`);
  const added = await fileDiff(repo, source(head), 'new.txt' as FilePath, false);
  assert.deepEqual(added.ok && added.value.kind === 'text' && shape(added.value.rows), ['change -|1:new'], 'a file whose blobs are in the clone still opens');
  assert.deepEqual({print: fingerprint(clone), packs: packs()}, before, 'git fetched nothing, and .git is unchanged');
  // Positive control: git without the app's settings fetches the missing blob and adds a pack.
  execFileSync('git', ['-C', clone, 'diff-tree', '-r', '--numstat', `${head}~1`, head], {env});
  assert.ok(packs() > before.packs, 'plain git lazily fetches the missing blob into a new pack');
});

test('missing-object-ordinary: in an ordinary repository with a missing file object, the commit listing names git\'s error instead of listing files without counts', async () => {
  const box = sandbox('missing-object');
  box.write('kept.txt', lines(3));
  box.commit('First');
  const blob = box.git('rev-parse', 'HEAD:kept.txt');
  box.write('kept.txt', lines(3, {2: 'two'}));
  const head = box.commit('Second');
  rmSync(path.join(box.folder, '.git/objects', blob.slice(0, 2), blob.slice(2)));
  const listed = await changedFiles(await open(box.folder), source(head));
  assert.equal(!listed.ok && listed.error.kind, 'gitFailed', `a damaged repository shows git's error: ${JSON.stringify(listed)}`);
});
