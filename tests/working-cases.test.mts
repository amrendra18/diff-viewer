import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync} from 'node:fs';
import {open as openFile} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import path from 'node:path';
import {UNTRACKED_READS, changedFiles, commitPage, fileDiff, openRepository, repositoryInfo} from '../src/app/git.ts';
import type {Repository} from '../src/app/git.ts';
import type {FileDiff, FilePath, Source} from '../src/domain/types.ts';
import {fingerprint} from '../scripts/fingerprint.mts';
import {isolatedGit} from '../scripts/isolated-git.mts';
import {caseGit, lines, scratchFolder, shape, value, withGitOnPath} from './repo-sandbox.mts';

const {scratch, sandbox} = scratchFolder('working');
const STAGED: Source = {kind: 'staged'}, UNSTAGED: Source = {kind: 'unstaged'};
const open = async (folder: string): Promise<Repository> => value(await openRepository(folder));
const listOf = async (repo: Repository, source: Source) => value(await changedFiles(repo, source)).map(file =>
  `${file.status} ${file.path}${file.oldPath ? ` from ${file.oldPath}` : ''} ${file.content} ${file.added}/${file.removed}${file.untracked ? ' untracked' : ''}`);
const diffOf = async (repo: Repository, source: Source, file: string, showLarge = false): Promise<FileDiff> => value(await fileDiff(repo, source, file as FilePath, showLarge));
const rowsOf = (diff: FileDiff) => diff.kind === 'text' ? shape(diff.rows) : [diff.kind];
const counts = async (repo: Repository) => { const info = value(await repositoryInfo(repo)); return [info.stagedCount, info.unstagedCount]; };

type ReadRecord = {calls: number; bytes: number};

/** Runs `body` while it records every FileHandle read: the read calls and bytes per handle, and the most reads waiting at one time. */
async function recordReads<T>(body: () => Promise<T>): Promise<{result: T; handles: ReadRecord[]; mostAtOnce: number}> {
  const probe = await openFile(import.meta.filename);
  const proto = Object.getPrototypeOf(probe) as {read: FileHandle['read']};
  await probe.close();
  const {read} = proto;
  const records = new Map<FileHandle, ReadRecord>();
  let waiting = 0, mostAtOnce = 0;
  proto.read = async function (this: FileHandle, ...args: unknown[]) {
    const record = records.get(this) ?? {calls: 0, bytes: 0};
    records.set(this, record);
    mostAtOnce = Math.max(mostAtOnce, ++waiting);
    try {
      const answer = await (read as (...rest: unknown[]) => ReturnType<FileHandle['read']>).apply(this, args);
      record.calls++;
      record.bytes += answer.bytesRead;
      return answer;
    } finally { waiting--; }
  } as FileHandle['read'];
  try {
    const result = await body();
    return {result, handles: [...records.values()], mostAtOnce};
  } finally { proto.read = read; }
}

test('working-lists: staged is the last commit against the index, unstaged the index against the working folder plus untracked files', async () => {
  const box = sandbox('lists');
  box.write('a.txt', lines(6));
  box.write('b.txt', lines(6));
  box.write('c.txt', lines(2));
  box.commit('Start');
  box.write('a.txt', lines(6, {2: 'two'}));
  box.write('new.txt', 'new\n');
  box.git('add', 'a.txt', 'new.txt');
  box.write('a.txt', lines(6, {2: 'two', 5: 'five'}));
  box.write('b.txt', lines(6, {4: 'four'}));
  box.write('u.txt', 'one\ntwo\n');
  utimesSync(path.join(box.folder, 'c.txt'), 1000000, 1000000);
  const repo = await open(box.folder);
  assert.deepEqual(await listOf(repo, STAGED), ['modified a.txt text 1/1', 'added new.txt text 1/0']);
  assert.deepEqual(await listOf(repo, UNSTAGED), ['modified a.txt text 1/1', 'modified b.txt text 1/1', 'added u.txt text 2/0 untracked'],
    'c.txt, whose time changed but whose content did not, is not listed');
  assert.deepEqual(await counts(repo), [2, 3], 'the tab counts equal the list lengths');
  assert.deepEqual(rowsOf(await diffOf(repo, STAGED, 'a.txt')), ['context 1:line 1|1:line 1', 'change 2:line 2|2:two', 'context 3:line 3|3:line 3', 'context 4:line 4|4:line 4', 'context 5:line 5|5:line 5', 'hidden 6-6']);
  assert.deepEqual(rowsOf(await diffOf(repo, UNSTAGED, 'a.txt')), ['hidden 1-1', 'context 2:two|2:two', 'context 3:line 3|3:line 3', 'context 4:line 4|4:line 4', 'change 5:line 5|5:five', 'context 6:line 6|6:line 6'],
    'unstaged compares the staged version with the working folder');
  assert.deepEqual(rowsOf(await diffOf(repo, UNSTAGED, 'u.txt')), ['change -|1:one', 'change -|2:two']);
  assert.equal((await fileDiff(repo, STAGED, 'b.txt' as FilePath, false)).ok, false, 'a file with no staged change has no staged diff');
});

test('no-head: before the first commit, staged changes compare with the empty tree', async () => {
  const box = sandbox('unborn');
  box.write('n.txt', 'first\nsecond\n');
  box.git('add', 'n.txt');
  const repo = await open(box.folder);
  assert.deepEqual(await listOf(repo, STAGED), ['added n.txt text 2/0']);
  assert.deepEqual(rowsOf(await diffOf(repo, STAGED, 'n.txt')), ['change -|1:first', 'change -|2:second']);
  const info = value(await repositoryInfo(repo));
  assert.deepEqual([info.branch, info.stagedCount, info.unstagedCount, info.commits.commits.length], ['main', 1, 0, 0]);
});

test('merge-conflict: a conflicted file shows once, in unstaged, as unmerged with its conflict markers', async () => {
  const box = sandbox('conflict');
  box.write('f.txt', 'a\nb\nc\n');
  box.write('g.txt', 'x\n');
  box.commit('Base');
  box.git('checkout', '--quiet', '-b', 'side');
  box.write('f.txt', 'a\nSIDE\nc\n');
  box.commit('Side');
  box.git('checkout', '--quiet', 'main');
  box.write('f.txt', 'a\nMAIN\nc\n');
  box.commit('Main');
  assert.throws(() => box.git('merge', '--quiet', 'side'), 'the merge stops on a conflict');
  box.write('g.txt', 'y\n');
  box.git('add', 'g.txt');
  const repo = await open(box.folder);
  assert.deepEqual(await listOf(repo, STAGED), ['modified g.txt text 1/1'], 'the conflicted file is not in the staged list');
  assert.deepEqual(await listOf(repo, UNSTAGED), ['unmerged f.txt text 4/0'], 'the conflicted file is one row');
  assert.deepEqual(await counts(repo), [1, 1]);
  assert.deepEqual(rowsOf(await diffOf(repo, UNSTAGED, 'f.txt')), [
    'context 1:a|1:a', 'change -|2:<<<<<<< HEAD', 'context 2:MAIN|3:MAIN', 'change -|4:=======', 'change -|5:SIDE', 'change -|6:>>>>>>> side', 'context 3:c|7:c',
  ], 'our side on the left, the working folder with its markers on the right');
});

test('intent-to-add: a file added with git add -N is a new unstaged file and not staged', async () => {
  const box = sandbox('ita');
  box.write('kept.txt', 'kept\n');
  box.commit('Start');
  box.write('ita.txt', 'one\ntwo\n');
  box.git('add', '-N', 'ita.txt');
  const repo = await open(box.folder);
  assert.deepEqual(await listOf(repo, STAGED), []);
  assert.deepEqual(await listOf(repo, UNSTAGED), ['added ita.txt text 2/0']);
  assert.deepEqual(rowsOf(await diffOf(repo, UNSTAGED, 'ita.txt')), ['change -|1:one', 'change -|2:two']);
  assert.deepEqual(await counts(repo), [0, 1]);
});

test('deleted-on-disk: a tracked file removed from the working folder is an unstaged deletion', async () => {
  const box = sandbox('deleted');
  box.write('gone.txt', lines(2));
  box.commit('Start');
  rmSync(path.join(box.folder, 'gone.txt'));
  const repo = await open(box.folder);
  assert.deepEqual(await listOf(repo, UNSTAGED), ['deleted gone.txt text 0/2']);
  assert.deepEqual(rowsOf(await diffOf(repo, UNSTAGED, 'gone.txt')), ['change 1:line 1|-', 'change 2:line 2|-']);
});

test('staged-rename-then-edited: the staged list shows the rename, the unstaged list the later edit', async () => {
  const box = sandbox('rename');
  box.write('ren.txt', lines(4));
  box.commit('Start');
  box.git('mv', 'ren.txt', 'ren2.txt');
  box.write('ren2.txt', lines(5));
  const repo = await open(box.folder);
  assert.deepEqual(await listOf(repo, STAGED), ['renamed ren2.txt from ren.txt text 0/0']);
  assert.deepEqual(rowsOf(value(await fileDiff(repo, STAGED, 'ren2.txt' as FilePath, false, 'ren.txt' as FilePath))), ['hidden 1-4'], 'a pure rename, sent with its old path as the page does, has no changed lines');
  assert.deepEqual(await listOf(repo, UNSTAGED), ['modified ren2.txt text 1/0']);
  assert.deepEqual(rowsOf(await diffOf(repo, UNSTAGED, 'ren2.txt')), ['hidden 1-1', 'context 2:line 2|2:line 2', 'context 3:line 3|3:line 3', 'context 4:line 4|4:line 4', 'change -|5:line 5']);
});

test('mode-only: a mode change with the same content names both modes, unstaged and staged', async () => {
  const box = sandbox('mode');
  box.write('run.sh', 'echo hi\n');
  box.commit('Start');
  chmodSync(path.join(box.folder, 'run.sh'), 0o755);
  const repo = await open(box.folder);
  assert.deepEqual(await listOf(repo, UNSTAGED), ['modified run.sh text 0/0']);
  const unstaged = await diffOf(repo, UNSTAGED, 'run.sh');
  assert.deepEqual(unstaged.kind === 'modeOnly' && [unstaged.oldMode, unstaged.newMode], ['100644', '100755']);
  box.git('add', 'run.sh');
  const staged = await diffOf(repo, STAGED, 'run.sh');
  assert.deepEqual(staged.kind === 'modeOnly' && [staged.oldMode, staged.newMode], ['100644', '100755']);
});

test('submodule: new commits and a dirty tree inside a submodule show its commits, never its files', async () => {
  const inner = sandbox('inner');
  inner.write('i.txt', 'i\n');
  const first = inner.commit('Inner one');
  const box = sandbox('outer');
  box.write('top.txt', 'top\n');
  box.commit('Start');
  box.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', inner.folder, 'mod');
  box.commit('Add the submodule');
  const sub = path.join(box.folder, 'mod');
  const subGit = (...args: string[]) => caseGit(['-C', sub, ...args]).trim();
  writeFileSync(path.join(sub, 'i.txt'), 'i2\n');
  subGit('commit', '--quiet', '-am', 'Inner two');
  const second = subGit('rev-parse', 'HEAD');
  const repo = await open(box.folder);
  assert.deepEqual(await listOf(repo, UNSTAGED), ['modified mod submodule 1/1']);
  const moved = await diffOf(repo, UNSTAGED, 'mod');
  assert.deepEqual(moved.kind === 'submodule' && [moved.oldCommit, moved.newCommit], [first, second], 'new commits inside the submodule');
  writeFileSync(path.join(sub, 'i.txt'), 'dirty\n');
  const movedAndDirty = await diffOf(repo, UNSTAGED, 'mod');
  assert.deepEqual(movedAndDirty.kind === 'submodule' && [movedAndDirty.oldCommit, movedAndDirty.newCommit], [first, second], 'new commits and changed files inside');
  subGit('reset', '--quiet', '--hard', first);
  writeFileSync(path.join(sub, 'i.txt'), 'dirty\n');
  assert.deepEqual(await listOf(repo, UNSTAGED), ['modified mod submodule 0/0']);
  const dirty = await diffOf(repo, UNSTAGED, 'mod');
  assert.deepEqual(dirty.kind === 'submodule' && [dirty.oldCommit, dirty.newCommit], [first, first], 'changed files inside, same commit');
});

test('symlink: a changed link target and an untracked link are read without following them', async () => {
  const box = sandbox('links');
  box.write('secret.txt', 'not shown\n');
  symlinkSync('target-one', path.join(box.folder, 'link'));
  box.commit('Start');
  rmSync(path.join(box.folder, 'link'));
  symlinkSync('secret.txt', path.join(box.folder, 'link'));
  symlinkSync('nowhere', path.join(box.folder, 'newlink'));
  const repo = await open(box.folder);
  assert.deepEqual(await listOf(repo, UNSTAGED), ['modified link symlink 1/1', 'added newlink symlink 1/0 untracked']);
  const changed = await diffOf(repo, UNSTAGED, 'link');
  assert.deepEqual(changed.kind === 'symlink' && [changed.oldTarget, changed.newTarget], ['target-one', 'secret.txt'], 'the target path, not the content of secret.txt');
  const added = await diffOf(repo, UNSTAGED, 'newlink');
  assert.deepEqual(added.kind === 'symlink' && [added.oldTarget, added.newTarget], [null, 'nowhere'], 'a dangling untracked link shows its target');
});

test('crlf: a CRLF working file shows only real edits and no carriage returns', async () => {
  const normalized = sandbox('crlf-auto');
  normalized.git('config', 'core.autocrlf', 'true');
  normalized.write('crlf.txt', 'l1\r\nl2\r\n');
  normalized.commit('Start');
  normalized.write('crlf.txt', 'l1\r\nl2\r\nl3\r\n');
  const repo = await open(normalized.folder);
  assert.deepEqual(await listOf(repo, UNSTAGED), ['modified crlf.txt text 1/0'], 'core.autocrlf: git compares without the carriage returns');
  assert.deepEqual(rowsOf(await diffOf(repo, UNSTAGED, 'crlf.txt')), ['context 1:l1|1:l1', 'context 2:l2|2:l2', 'change -|3:l3']);
  const raw = sandbox('crlf-raw');
  raw.write('crlf.txt', 'l1\nl2\n');
  raw.commit('Start');
  raw.write('crlf.txt', 'l1\r\nl2\r\n');
  const rawRepo = await open(raw.folder);
  assert.deepEqual(await listOf(rawRepo, UNSTAGED), ['modified crlf.txt text 2/2'], 'without core.autocrlf, the line endings are a real change');
  assert.deepEqual(rowsOf(await diffOf(rawRepo, UNSTAGED, 'crlf.txt')), ['change 1:l1|1:l1', 'change 2:l2|2:l2'], 'the rows hold no carriage return');
});

test('ignored: a tracked file that matches .gitignore is listed when edited; an ignored untracked file is not', async () => {
  const box = sandbox('ignored');
  box.write('.gitignore', 'ignored*\n');
  box.write('ignored-tracked.txt', 'one\n');
  box.git('add', '--force', '.gitignore', 'ignored-tracked.txt');
  box.git('commit', '--quiet', '-m', 'Start');
  box.write('ignored-tracked.txt', 'two\n');
  box.write('ignored-new.txt', 'secret\n');
  box.write('plain-new.txt', 'shown\n');
  const repo = await open(box.folder);
  assert.deepEqual(await listOf(repo, UNSTAGED), ['modified ignored-tracked.txt text 1/1', 'added plain-new.txt text 1/0 untracked']);
  assert.deepEqual(await fileDiff(repo, UNSTAGED, 'ignored-new.txt' as FilePath, false), {ok: false, error: {kind: 'unknownFile', path: 'ignored-new.txt'}}, 'an ignored untracked file has no diff');
  assert.deepEqual(rowsOf(await diffOf(repo, UNSTAGED, 'plain-new.txt')), ['change -|1:shown'], 'positive control: an untracked file that is not ignored has a diff');
});

test('untracked-binary: a NUL in the first 8,000 bytes or an unset diff attribute makes an untracked file binary', async () => {
  const box = sandbox('binary');
  box.write('.gitattributes', '*.raw -diff\n');
  box.commit('Start');
  box.write('early.dat', Buffer.from([0x89, 0x50, 0x00, 0x47]));
  box.write('late.txt', Buffer.concat([Buffer.alloc(9000, 'a'), Buffer.from([0, 0x0a])]));
  box.write('plain.raw', 'looks like text\n');
  const repo = await open(box.folder);
  assert.deepEqual(await listOf(repo, UNSTAGED), ['added early.dat binary null/null untracked', 'added late.txt text 1/0 untracked', 'added plain.raw binary null/null untracked'],
    'a NUL after byte 8,000 leaves the file text, as git counts it');
  const early = await diffOf(repo, UNSTAGED, 'early.dat');
  assert.deepEqual(early.kind === 'binary' && [early.oldSize, early.newSize], [null, 4]);
});

test('untracked-large: an untracked file over 5,000 lines stays collapsed until showLarge', async () => {
  const box = sandbox('large');
  box.write('kept.txt', 'kept\n');
  box.commit('Start');
  box.write('big.txt', lines(5001));
  const repo = await open(box.folder);
  assert.deepEqual(await listOf(repo, UNSTAGED), ['added big.txt text 5001/0 untracked']);
  const collapsed = await diffOf(repo, UNSTAGED, 'big.txt');
  assert.deepEqual(collapsed.kind === 'tooLarge' && collapsed.over === 'lines' && collapsed.lineCount, 5001);
  const shown = await diffOf(repo, UNSTAGED, 'big.txt', true);
  assert.equal(shown.kind === 'text' && shown.rows.length, 5001);
});

test('untracked-huge: an untracked text file too long to read into memory is listed without a line count and answers tooLarge from its size', async () => {
  const box = sandbox('huge');
  box.write('kept.txt', 'kept\n');
  box.commit('Start');
  const huge = path.join(box.folder, 'huge.log');
  writeFileSync(huge, lines(5001));
  // Sparse, so the disk holds only the first lines. 600 MiB is over the longest string Node can hold, so a full read fails.
  truncateSync(huge, 600 * 1024 * 1024);
  const repo = await open(box.folder);
  const {result: listed, handles} = await recordReads(() => listOf(repo, UNSTAGED));
  assert.deepEqual(handles.map(handle => handle.bytes), [8000], 'the listing reads only the first 8,000 bytes of the 600 MiB file');
  assert.deepEqual(listed, ['added huge.log text null/null untracked'], 'a file over 200 KB is not counted; NUL bytes after byte 8,000 leave it text, as git counts it');
  const collapsed = await diffOf(repo, UNSTAGED, 'huge.log');
  assert.deepEqual(collapsed.kind === 'tooLarge' && collapsed.over === 'bytes' && collapsed.byteCount, 600 * 1024 * 1024);
});

test('unstaged-bytes: a working copy over 200 KB answers tooLarge from its size on disk', async () => {
  const box = sandbox('bytes');
  box.write('bundle.js', 'var a = 1;\n');
  box.commit('Start');
  box.write('bundle.js', `var a = "${'x'.repeat(600_000)}";\n`);
  const repo = await open(box.folder);
  const collapsed = await diffOf(repo, UNSTAGED, 'bundle.js');
  assert.deepEqual(collapsed.kind === 'tooLarge' && collapsed.over === 'bytes' && collapsed.byteCount, 600_012);
  const shown = await diffOf(repo, UNSTAGED, 'bundle.js', true);
  assert.equal(shown.kind, 'text');
});

test('untracked-unreadable: an untracked file the app cannot read is listed without counts beside the others, and its own diff names the problem', async () => {
  const box = sandbox('unreadable-untracked');
  box.write('kept.txt', 'kept\n');
  box.commit('Start');
  box.write('a.txt', 'one\n');
  box.write('locked.txt', 'secret\n');
  box.write('z.txt', 'one\ntwo\n');
  chmodSync(path.join(box.folder, 'locked.txt'), 0);
  try {
    const repo = await open(box.folder);
    assert.deepEqual(await listOf(repo, UNSTAGED), ['added a.txt text 1/0 untracked', 'added locked.txt text null/null untracked', 'added z.txt text 2/0 untracked']);
    const locked = await fileDiff(repo, UNSTAGED, 'locked.txt' as FilePath, false);
    assert.equal(!locked.ok && locked.error.kind, 'unreadableFile', `opening the file names why it cannot be read: ${JSON.stringify(locked)}`);
    assert.deepEqual(rowsOf(await diffOf(repo, UNSTAGED, 'z.txt')), ['change -|1:one', 'change -|2:two'], 'the other files still open');
  } finally { chmodSync(path.join(box.folder, 'locked.txt'), 0o644); }
});

test('untracked-many: 20,000 small untracked files list with their line counts, each read once, several at a time but at most UNTRACKED_READS', async () => {
  const box = sandbox('many-untracked');
  box.write('kept.txt', 'kept\n');
  box.commit('Start');
  for (let folder = 0; folder < 200; folder++) {
    mkdirSync(path.join(box.folder, `d${folder}`));
    for (let file = 0; file < 100; file++) writeFileSync(path.join(box.folder, `d${folder}`, `f${file}.txt`), `line one ${folder} ${file}\nline two\nline three\n`);
  }
  const repo = await open(box.folder);
  const started = performance.now();
  const {result: files, handles, mostAtOnce} = await recordReads(async () => value(await changedFiles(repo, UNSTAGED)));
  const elapsed = performance.now() - started;
  assert.deepEqual([files.length, files.every(file => file.added === 3)], [20000, true], 'every file is listed with its 3 lines');
  assert.deepEqual([handles.length, handles.every(handle => handle.calls === 1)], [20000, true], 'each file is opened once and read in one call');
  assert.ok(mostAtOnce > 1 && mostAtOnce <= UNTRACKED_READS, `files are read several at a time, at most ${UNTRACKED_READS} (most reads waiting at once: ${mostAtOnce})`);
  // A loose sanity limit only; the counts above prove the behaviour. Read one at a time, this listing took 2.9 to 3.5 s.
  assert.ok(elapsed < 15000, `the listing took ${elapsed.toFixed(0)} ms`);
});

test('nested-repository: an untracked folder that holds its own repository is one entry, and its files are not read', async () => {
  const box = sandbox('nested');
  box.write('kept.txt', 'kept\n');
  box.commit('Start');
  caseGit(['init', '--quiet', path.join(box.folder, 'nested')]);
  writeFileSync(path.join(box.folder, 'nested', 'inside.txt'), 'inside\n');
  const repo = await open(box.folder);
  assert.deepEqual(await listOf(repo, UNSTAGED), ['added nested submodule null/null untracked']);
  const nested = await diffOf(repo, UNSTAGED, 'nested');
  assert.deepEqual(nested.kind === 'submodule' && [nested.oldCommit, nested.newCommit], [null, null]);
});

test('repository-gone: a repository moved after it was opened answers repositoryGone for every read', async () => {
  const box = sandbox('moved');
  box.write('a.txt', 'a\n');
  box.commit('Start');
  box.write('a.txt', 'b\n');
  const repo = await open(box.folder);
  renameSync(box.folder, `${box.folder}-elsewhere`);
  const gone = {ok: false, error: {kind: 'repositoryGone', path: repo.path}};
  assert.deepEqual(await repositoryInfo(repo), gone);
  assert.deepEqual(await changedFiles(repo, UNSTAGED), gone);
  assert.deepEqual(await fileDiff(repo, UNSTAGED, 'a.txt' as FilePath, false), gone);
});

test('repository-removed-bare: a bare repository removed while open answers repositoryGone, not an empty commit list', async () => {
  const box = sandbox('bare-source');
  box.write('a.txt', 'a\n');
  box.commit('Start');
  const bare = path.join(scratch, 'removed.git');
  caseGit(['clone', '--quiet', '--bare', box.folder, bare]);
  const repo = await open(bare);
  assert.equal(value(await repositoryInfo(repo)).commits.commits.length, 1, 'control: the open repository lists its commit');
  renameSync(bare, `${bare}-elsewhere`);
  const gone = {ok: false, error: {kind: 'repositoryGone', path: repo.path}};
  assert.deepEqual(await repositoryInfo(repo), gone);
  assert.deepEqual(await commitPage(repo, 0), gone);
});

test('git-stops-reading: a git that exits before it reads its input gives a git error, not a crash of the main process', async () => {
  const box = sandbox('stops-reading');
  const filesOverPipeCapacity = 4000;
  for (let index = 0; index < filesOverPipeCapacity; index++) box.write(`untracked-file-with-a-long-name-${index}.txt`, 'x\n');
  const repo = await open(box.folder);
  const crashes: unknown[] = [];
  const crash = (error: unknown) => crashes.push(error);
  const others = process.listeners('uncaughtException');
  process.removeAllListeners('uncaughtException');
  process.on('uncaughtException', crash);
  try {
    const stopsEarly = (real: string) => `#!/bin/sh\nfor arg in "$@"; do [ "$arg" = check-attr ] && { echo 'fatal: planted' >&2; exit 128; }; done\nexec '${real}' "$@"\n`;
    const {result} = await withGitOnPath(scratch, () => changedFiles(repo, UNSTAGED), {script: stopsEarly});
    assert.deepEqual(result, {ok: false, error: {kind: 'gitFailed', message: 'fatal: planted'}});
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.deepEqual(crashes.map(String), [], 'no uncaught error');
  } finally {
    process.off('uncaughtException', crash);
    for (const listener of others) process.on('uncaughtException', listener);
  }
});

test('unreadable-working-file: a working file git cannot read leaves the commits and the staged list, and fails only the unstaged list', async () => {
  const box = sandbox('required-filter');
  box.write('.gitattributes', '*.bin filter=lfs\n');
  box.write('data.bin', 'version 1\n');
  box.write('a.txt', 'a\n');
  box.commit('Start');
  box.write('a.txt', 'a2\n');
  box.git('add', '--', 'a.txt');
  // A required clean filter whose program is missing, as with filter.lfs.required and git-lfs not on PATH.
  box.git('config', 'filter.lfs.required', 'true');
  box.git('config', 'filter.lfs.clean', '/nonexistent/git-lfs clean %f');
  box.write('data.bin', 'version 2\n');
  const repo = await open(box.folder);
  const info = value(await repositoryInfo(repo));
  assert.deepEqual([info.commits.commits.map(commit => commit.subject), info.stagedCount, info.unstagedCount], [['Start'], 1, null], 'the commits and the staged count stay; the unstaged count is unknown');
  assert.deepEqual(await listOf(repo, STAGED), ['modified a.txt text 1/1']);
  const unstaged = await changedFiles(repo, UNSTAGED);
  assert.equal(!unstaged.ok && unstaged.error.kind, 'gitFailed', 'the unstaged list names git\'s failure');
  assert.match(!unstaged.ok && unstaged.error.kind === 'gitFailed' ? unstaged.error.message : '', /lfs/);
});

test('filtered-working-file: a clean filter that changes a working file\'s line count fails for that file alone, and says why', async () => {
  const box = sandbox('clean-filter');
  box.git('config', 'filter.squeeze.clean', 'grep -v DROP');
  box.git('config', 'filter.squeeze.smudge', 'cat');
  box.write('.gitattributes', '*.txt filter=squeeze\n');
  box.write('f.txt', 'a\nb\nc\n');
  box.commit('Start');
  box.write('f.txt', 'a\nDROP\nDROP\nb\nX\nc\n');
  const repo = await open(box.folder);
  assert.deepEqual(await listOf(repo, UNSTAGED), ['modified f.txt text 1/0'], 'git compares the filtered text, so its counts leave the dropped lines out');
  const answer = await fileDiff(repo, UNSTAGED, 'f.txt' as FilePath, false);
  assert.equal(!answer.ok && answer.error.kind, 'unreadableFile', `the failure belongs to the file, not to git: ${JSON.stringify(answer)}`);
  assert.match(!answer.ok && answer.error.kind === 'unreadableFile' ? answer.error.message : '', /filter/, 'the message names the likely cause');
});

test('filtered-working-file: a working-tree-encoding attribute gives "could not be read" when the line count differs, and the file on disk when it does not', async () => {
  const box = sandbox('working-tree-encoding');
  const utf16 = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  box.write('.gitattributes', '*.utf16 working-tree-encoding=UTF-16LE-BOM\n*.latin1 working-tree-encoding=ISO-8859-1\n');
  box.write('wide.utf16', utf16('a\nb\nc\n'));
  box.write('narrow.latin1', Buffer.from('a\nb\nc\n', 'latin1'));
  box.commit('Start');
  box.write('wide.utf16', utf16('a\nB\nc\n'));
  box.write('narrow.latin1', Buffer.from('a\n\u00e9\nc\n', 'latin1'));
  const repo = await open(box.folder);
  const wide = await fileDiff(repo, UNSTAGED, 'wide.utf16' as FilePath, false);
  assert.equal(!wide.ok && wide.error.kind, 'unreadableFile', 'a NUL byte after each newline gives the UTF-8 reading an extra line');
  const narrow = await diffOf(repo, UNSTAGED, 'narrow.latin1');
  assert.deepEqual(narrow.kind === 'text' && shape(narrow.rows), ['context 1:a|1:a', 'change 2:b|2:\uFFFD', 'context 3:c|3:c'], 'the right side is the file on disk, read as UTF-8, with git\'s marks');
});

test('file-click-path-limited-working: a staged or unstaged file\'s diff lists only that file', async () => {
  const box = sandbox('path-limited-working');
  box.write('ren.txt', lines(4));
  box.write('b.txt', lines(4));
  box.write('c.txt', lines(4));
  box.commit('Start');
  box.git('mv', 'ren.txt', 'ren2.txt');
  box.write('b.txt', lines(4, {2: 'two'}));
  box.write('c.txt', lines(4, {3: 'three'}));
  box.write('u.txt', 'u\n');
  box.write('v.txt', 'v\n');
  const repo = await open(box.folder);
  const {result: [renamed, tracked, untracked], calls} = await withGitOnPath(scratch, async () => [
    value(await fileDiff(repo, STAGED, 'ren2.txt' as FilePath, false, 'ren.txt' as FilePath)),
    value(await fileDiff(repo, UNSTAGED, 'b.txt' as FilePath, false)),
    value(await fileDiff(repo, UNSTAGED, 'u.txt' as FilePath, false)),
  ]);
  assert.deepEqual([renamed.file.status, renamed.file.oldPath], ['renamed', 'ren.txt']);
  assert.deepEqual([tracked.file.status, untracked.file.status, untracked.file.untracked], ['modified', 'added', true]);
  const listings = calls.filter(call => / (diff-index|diff-files) .*--raw| ls-files /.test(call)).map(call => call.replace(/^.* -C \S+ /, ''));
  assert.deepEqual(listings.map(call => call.slice(call.lastIndexOf(' -- ') + 4)), ['ren.txt ren2.txt', 'b.txt', 'b.txt', 'u.txt', 'u.txt'], `each listing names only the asked file: ${listings.join(' | ')}`);
});

test('stale-index: listing and reading staged and unstaged changes leaves a stale index unchanged; plain git diff does not', async () => {
  const box = sandbox('stale');
  box.write('a.txt', 'a\n');
  box.write('b.txt', 'b\n');
  box.commit('Start');
  box.write('b.txt', 'b2\n');
  box.write('u.txt', 'u\n');
  utimesSync(path.join(box.folder, 'a.txt'), 1000000, 1000000);
  const index = path.join(box.folder, '.git', 'index');
  const print = () => ({bytes: readFileSync(index).toString('hex'), time: statSync(index).mtimeMs});
  const before = print();
  const repo = await open(box.folder);
  await counts(repo);
  for (const source of [STAGED, UNSTAGED]) await listOf(repo, source);
  await diffOf(repo, UNSTAGED, 'b.txt');
  await diffOf(repo, UNSTAGED, 'u.txt');
  assert.deepEqual(print(), before, 'the index bytes and time are unchanged');
  isolatedGit(['-C', box.folder, 'diff', '--quiet'], {env: {GIT_OPTIONAL_LOCKS: '0'}});
  assert.notDeepEqual(print(), before, 'positive control: plain git diff rewrites the same index, even with GIT_OPTIONAL_LOCKS=0');
});

/** Every file under .git, by content, and the index's modification time. */
const gitFolderPrint = (folder: string) => ({files: fingerprint(path.join(folder, '.git')), indexTime: statSync(path.join(folder, '.git', 'index')).mtimeMs});

/** The app's reads left .git as `before`; then plain git status, as the positive control, must change it. */
function assertGitFolderKept(folder: string, before: ReturnType<typeof gitFolderPrint>): void {
  assert.deepEqual(gitFolderPrint(folder), before, 'every file under .git and the index time are unchanged');
  isolatedGit(['-C', folder, 'status', '--porcelain']);
  assert.notDeepEqual(gitFolderPrint(folder), before, 'positive control: git status without GIT_OPTIONAL_LOCKS=0 rewrites the same index');
}

test('read-only-no-commit: reading a repository with no commit, where git status names the branch, leaves .git unchanged', async () => {
  const box = sandbox('unborn-stale');
  box.write('n.txt', 'first\n');
  box.git('add', 'n.txt');
  utimesSync(path.join(box.folder, 'n.txt'), 1000000, 1000000);
  const before = gitFolderPrint(box.folder);
  const repo = await open(box.folder);
  const info = value(await repositoryInfo(repo));
  assert.deepEqual([info.branch, info.stagedCount, info.unstagedCount], ['main', 1, 0], 'the branch name comes from git status');
  assertGitFolderKept(box.folder, before);
});

test('read-only-attributes: listing and reading unstaged changes with a .gitattributes file, where check-attr runs, leaves .git unchanged', async () => {
  const box = sandbox('attributes-stale');
  box.write('.gitattributes', '*.raw -diff\n');
  box.write('a.txt', 'a\n');
  box.commit('Start');
  box.write('plain.raw', 'looks like text\n');
  box.write('new.txt', 'new\n');
  utimesSync(path.join(box.folder, 'a.txt'), 1000000, 1000000);
  const before = gitFolderPrint(box.folder);
  const repo = await open(box.folder);
  assert.deepEqual(await listOf(repo, UNSTAGED), ['added new.txt text 1/0 untracked', 'added plain.raw binary null/null untracked']);
  assert.equal((await diffOf(repo, UNSTAGED, 'plain.raw')).kind, 'binary', 'check-attr marks plain.raw binary');
  await diffOf(repo, UNSTAGED, 'new.txt');
  assertGitFolderKept(box.folder, before);
});

test('refresh-one-listing: a repository load that names the open working tab lists that tab once and returns its files with the counts', async () => {
  const box = sandbox('one-listing');
  box.write('tracked.txt', lines(3));
  box.write('staged.txt', lines(2));
  box.commit('Start');
  box.write('staged.txt', lines(2, {1: 'one'}));
  box.git('add', 'staged.txt');
  box.write('tracked.txt', lines(3, {2: 'two'}));
  box.write('new.txt', 'new\n');
  const repo = await open(box.folder);
  for (const [list, command, expected] of [['unstaged', 'diff-files', ['modified tracked.txt text 1/1', 'added new.txt text 1/0 untracked']], ['staged', 'diff-index', ['modified staged.txt text 1/1']]] as const) {
    const {result, calls} = await withGitOnPath(scratch, () => repositoryInfo(repo, list));
    const info = value(result);
    const files = value(info.files ?? {ok: false, error: {kind: 'gitFailed', message: 'no files returned'}});
    assert.deepEqual(files.map(file => `${file.status} ${file.path} ${file.content} ${file.added}/${file.removed}${file.untracked ? ' untracked' : ''}`).sort(), [...expected].sort(), `the ${list} files come with the counts`);
    assert.equal(list === 'staged' ? info.stagedCount : info.unstagedCount, files.length, `the ${list} count is the list's length`);
    assert.equal(calls.filter(call => call.split(' ').includes(command)).length, 1, `one ${command} call for the ${list} tab: ${calls.join(' | ')}`);
  }
  assert.equal(value(await repositoryInfo(repo)).files, null, 'a load that names no tab returns no files');
});

test('diff-cache: opening the same unchanged staged or unstaged file again reads and highlights nothing again; a changed file and a commit diff are read again', async () => {
  const box = sandbox('diff-cache');
  box.write('notes.txt', lines(20));
  box.commit('Start');
  box.write('notes.txt', lines(20, {5: 'five'}));
  box.git('add', 'notes.txt');
  box.write('notes.txt', lines(20, {5: 'five', 9: 'nine'}));
  const repo = await open(box.folder);
  const reads = async (source: Source) => (await withGitOnPath(scratch, () => diffOf(repo, source, 'notes.txt'))).calls.filter(call => / (cat-file blob|-p) /.test(` ${call} `));
  for (const source of [UNSTAGED, STAGED]) {
    const first = await diffOf(repo, source, 'notes.txt');
    assert.equal(await diffOf(repo, source, 'notes.txt'), first, `${source.kind}: the second answer is the first one, not highlighted again`);
    assert.deepEqual(await reads(source), [], `${source.kind}: no file version or patch is read again`);
  }
  const file = path.join(box.folder, 'notes.txt');
  writeFileSync(file, lines(20, {5: 'five', 9: 'NINE'}));
  utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  const changed = rowsOf(await diffOf(repo, UNSTAGED, 'notes.txt'));
  assert.ok(changed.includes('change 9:line 9|9:NINE'), `a file changed on disk is read again: ${changed.join(' | ')}`);
  // Bar 3 times commit diffs, so they are always read; a focus refresh never reads them again.
  const commit: Source = {kind: 'commit', hash: box.commit('Edit')};
  await diffOf(repo, commit, 'notes.txt');
  assert.notDeepEqual(await reads(commit), [], 'a commit diff is read again');
});
