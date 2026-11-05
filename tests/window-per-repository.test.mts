import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planOpen} from '../src/app/windows.ts';
import type {RepoPath} from '../src/domain/types.ts';

const alpha = '/private/tmp/alpha' as RepoPath, beta = '/private/tmp/beta' as RepoPath;

test('window-per-repository: an empty window takes the repository, a busy one opens a new window', () => {
  assert.deepEqual(planOpen(new Map([[1, null]]), 1, alpha), {kind: 'here'});
  assert.deepEqual(planOpen(new Map([[1, beta]]), 1, alpha), {kind: 'new'});
  assert.deepEqual(planOpen(new Map([[1, beta], [2, null]]), 1, alpha), {kind: 'new'}, 'another empty window is not reused');
});

test('window-per-repository: a repository already open focuses its window', () => {
  assert.deepEqual(planOpen(new Map([[1, null], [2, alpha]]), 1, alpha), {kind: 'focus', window: 2}, 'even from an empty window');
  assert.deepEqual(planOpen(new Map([[1, beta], [2, alpha]]), 1, alpha), {kind: 'focus', window: 2});
  assert.deepEqual(planOpen(new Map([[1, alpha]]), 1, alpha), {kind: 'here'}, 'the window already showing it reloads it');
});
