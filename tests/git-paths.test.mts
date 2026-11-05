import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import path from 'node:path';
import {isolatedGit} from '../scripts/isolated-git.mts';
import {openRepository} from '../src/app/git.ts';

test('git-paths: openRepository keeps a trailing space in the path and ignores inherited Git settings', async () => {
  const temp = mkdtempSync('/private/tmp/diff-viewer-git-path-');
  const repository = path.join(temp, 'repository ');
  const previousDir = process.env.GIT_DIR;
  const previousTree = process.env.GIT_WORK_TREE;
  try {
    mkdirSync(repository);
    assert.equal(isolatedGit(['init', '-q', repository]).status, 0);
    process.env.GIT_DIR = path.join(temp, 'missing-git-dir');
    process.env.GIT_WORK_TREE = path.join(temp, 'other-tree');
    assert.deepEqual(await openRepository(repository), {ok: true, value: {path: realpathSync(repository), bare: false}});
  } finally {
    if (previousDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previousDir;
    if (previousTree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = previousTree;
    rmSync(temp, {recursive: true, force: true});
  }
});
