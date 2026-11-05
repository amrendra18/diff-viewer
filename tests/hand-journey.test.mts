import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {practiceNumbers, PROMISED} from '../scripts/hand-journey.mts';
import {createPractice} from '../scripts/fixtures.mts';
import {scratchFolder} from './repo-sandbox.mts';

const {scratch} = scratchFolder('hand');

test('hand-journey: the practice repository gives the numbers the hand-journey steps promise', async () => {
  const folder = path.join(scratch, 'practice');
  createPractice(folder);
  assert.deepEqual(await practiceNumbers(folder), {commits: 12, newestFiles: 4, staged: 2, unstaged: 2, untracked: 1});
  assert.deepEqual(PROMISED, {commits: 12, newestFiles: 4, staged: 2, unstaged: 2, untracked: 1}, 'the steps print the numbers the practice repository gives');
});
