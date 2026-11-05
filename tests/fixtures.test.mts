import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {
  ACCENTED_SUBJECT, BIG_FILE, BIG_FILE_EDITS, BIG_FILE_LINES, createCleanPractice, createFixtures, HISTORY_COMMITS, HOSTILE_FILE, HTML_SUBJECT, NEWEST_SUBJECT,
  SLOW_CPP_FILE, SPECIAL_EDIT_SUBJECT, SPECIAL_ROOT_SUBJECT, SPECIAL_TARGETS_SUBJECT, STEP_FILES, STEP_SUBJECT, SUBMODULE_COMMITS, TABLE_FILE, TABLE_FILE_LINES,
} from '../scripts/fixtures.mts';

// The user's own git settings stay out: log.showSignature, for one, would print into the log output read here.
const env = {...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1'};
const git = (folder: string, ...args: string[]) => execFileSync('git', ['-C', folder, ...args], {encoding: 'utf8', env});

function describe(root: string) {
  const {practice, history, special, step, bare} = createFixtures(root);
  const merges = git(practice, 'rev-list', '--merges', 'HEAD').trim().split('\n');
  return {
    practiceCommits: git(practice, 'rev-list', 'HEAD').trim().split('\n'),
    historyHead: git(history, 'rev-parse', 'HEAD').trim(),
    historyCount: Number(git(history, 'rev-list', '--count', 'HEAD')),
    newest: git(practice, 'log', '-1', '--format=%s').trim(),
    newestSigned: git(practice, 'cat-file', 'commit', 'HEAD').includes('\ngpgsig -----BEGIN SSH SIGNATURE-----\n'),
    newestFiles: git(practice, 'diff-tree', '-r', '-M', '--name-status', 'HEAD~1', 'HEAD').trim().split('\n'),
    merges: merges.length,
    roots: git(practice, 'rev-list', '--max-parents=0', 'HEAD').trim().split('\n').length,
    subjects: git(practice, 'log', '--format=%s').trim().split('\n'),
    binaryChanges: git(practice, 'log', '--format=', '--numstat', '--', 'assets/logo.png').trim().split('\n').filter(line => line.startsWith('-\t-')).length,
    largeLines: git(practice, 'show', `HEAD:${TABLE_FILE}`).split('\n').length - 1,
    hostile: git(practice, 'ls-files', '--', HOSTILE_FILE).trim(),
    hostileCommitFiles: git(practice, 'log', '--format=', '--name-only', `--grep=${HTML_SUBJECT}`, '--fixed-strings').trim().split('\n'),
    status: git(practice, 'status', '--porcelain=v1', '--untracked-files=all').split('\n').filter(Boolean).sort(),
    specialCommits: git(special, 'log', '--format=%H %s').trim().split('\n'),
    specialTargets: git(special, 'diff-tree', '-r', '--raw', 'HEAD~2', 'HEAD~1').trim().split('\n').map(line => line.replace(/ [0-9a-f]{40} [0-9a-f]{40} /, ' ')),
    specialSubmodule: git(special, 'ls-tree', 'HEAD', 'vendor/lib').trim(),
    bigLines: git(special, 'show', `HEAD:${BIG_FILE}`).split('\n').length - 1,
    bigEdits: git(special, 'diff-tree', '--numstat', 'HEAD~1', 'HEAD', '--', BIG_FILE).trim().split('\t').slice(0, 2).map(Number),
    step: git(step, 'log', '--format=%s').trim(),
    stepFiles: git(step, 'diff-tree', '--root', '-r', '--numstat', 'HEAD').trim().split('\n').slice(1),
    bareHead: git(bare, 'rev-parse', 'HEAD').trim(),
    bare: git(bare, 'rev-parse', '--is-bare-repository').trim(),
  };
}

test('fixtures: the practice, history, special, and bare repositories are the same on every build', () => {
  const first = mkdtempSync('/private/tmp/diff-viewer-fixtures-'), second = mkdtempSync('/private/tmp/diff-viewer-fixtures-');
  try {
    const a = describe(path.join(first, 'repos')), b = describe(path.join(second, 'repos'));
    assert.deepEqual(a, b, 'two builds give the same object names and counts');
    assert.equal(a.practiceCommits.length, 12);
    assert.equal(a.newest, NEWEST_SUBJECT);
    assert.deepEqual(a.newestFiles.map(line => line.split('\t')[0].replace(/\d+$/, '')), ['A', 'M', 'R', 'D']);
    assert.equal(a.merges, 1);
    assert.equal(a.roots, 1);
    assert(a.subjects.includes(HTML_SUBJECT));
    assert(a.subjects.includes(ACCENTED_SUBJECT));
    assert(a.newestSigned, 'the newest commit carries an SSH signature header');
    assert.equal(a.binaryChanges, 2, 'the logo is added and then changed as a binary file');
    assert.equal(a.largeLines, TABLE_FILE_LINES);
    assert.equal(a.hostile, HOSTILE_FILE);
    assert.equal(a.hostileCommitFiles.at(-1), SLOW_CPP_FILE, 'the commit with the HTML subject also adds the slow C++ file, after the hostile file name');
    assert.deepEqual(a.status, ['?? notes/todo.txt', 'A  src/staged-new.ts', 'M  README.md', ' M CHANGELOG.md'].sort());
    assert.equal(a.historyCount, HISTORY_COMMITS);
    assert.deepEqual(a.specialCommits.map(line => line.slice(41)), [SPECIAL_EDIT_SUBJECT, SPECIAL_TARGETS_SUBJECT, SPECIAL_ROOT_SUBJECT]);
    assert.deepEqual(a.specialTargets, [':120000 120000 M\tlink', ':100644 100755 M\trun.sh', ':160000 160000 M\tvendor/lib'], 'a symlink target, a mode-only change, and a submodule pointer');
    assert.equal(a.specialSubmodule, `160000 commit ${SUBMODULE_COMMITS[1]}\tvendor/lib`);
    assert.equal(a.bigLines, BIG_FILE_LINES, 'the big module stays under the 5,000-line limit');
    assert.deepEqual(a.bigEdits, [BIG_FILE_EDITS, BIG_FILE_EDITS]);
    assert.equal(a.step, STEP_SUBJECT);
    assert.deepEqual(a.stepFiles, [`${TABLE_FILE_LINES}\t0\t${STEP_FILES[0]}`, `1\t0\t${STEP_FILES[1]}`, `1\t0\t${STEP_FILES[2]}`], 'one commit: a file over the limit first, then two small files');
    assert.deepEqual([a.bare, a.bareHead], ['true', a.practiceCommits[0]], 'the bare clone holds the practice history');
  } finally {
    rmSync(first, {recursive: true, force: true});
    rmSync(second, {recursive: true, force: true});
  }
});

test('fixtures: a folder that already holds files is refused', () => {
  const folder = mkdtempSync('/private/tmp/diff-viewer-fixtures-');
  try {
    createFixtures(folder + '/repos');
    assert.throws(() => createFixtures(folder + '/repos'), /not empty/);
  } finally { rmSync(folder, {recursive: true, force: true}); }
});

test('fixtures: the clean practice copy ignores the user\'s global git config, such as commit signing and hooks', () => {
  const folder = mkdtempSync('/private/tmp/diff-viewer-fixtures-');
  const home = process.env.HOME;
  try {
    const hostileHome = path.join(folder, 'home');
    const hooks = path.join(hostileHome, 'hooks');
    mkdirSync(hooks, {recursive: true});
    writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', {mode: 0o755});
    writeFileSync(path.join(hostileHome, '.gitconfig'), `[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /usr/bin/false\n[core]\n\thooksPath = ${hooks}\n`);
    process.env.HOME = hostileHome;
    const clean = path.join(folder, 'clean');
    createCleanPractice(clean);
    assert.equal(git(clean, 'status', '--porcelain=v1', '--untracked-files=all'), '', 'no staged, unstaged, or untracked changes remain');
    assert.equal(git(clean, 'log', '-1', '--format=%s').trim(), 'Empty commit');
  } finally {
    process.env.HOME = home;
    rmSync(folder, {recursive: true, force: true});
  }
});
