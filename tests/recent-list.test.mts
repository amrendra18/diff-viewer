import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {forgetRecent, readRecent, rememberRecent} from '../src/app/recent.ts';
import type {RepoPath} from '../src/domain/types.ts';

const repo = (index: number) => `/private/tmp/repo-${index}` as RepoPath;

test('recent-list: newest first, no repeats, at most 10, kept across reads', () => {
  const folder = mkdtempSync('/private/tmp/diff-viewer-recent-');
  const file = path.join(folder, 'recent.json');
  try {
    assert.deepEqual(readRecent(file), [], 'no file reads as an empty list');
    for (let index = 1; index <= 12; index++) rememberRecent(file, repo(index));
    assert.deepEqual(readRecent(file), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3].map(repo));
    assert.deepEqual(rememberRecent(file, repo(5)), [5, 12, 11, 10, 9, 8, 7, 6, 4, 3].map(repo), 'reopening moves a path to the front');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), [5, 12, 11, 10, 9, 8, 7, 6, 4, 3].map(repo));
    assert.deepEqual(readdirSync(folder), ['recent.json'], 'the atomic write leaves no partial file behind');
  } finally {
    rmSync(folder, {recursive: true, force: true});
  }
});

test('recent-list: a damaged file reads as empty, and stray entries are dropped', () => {
  const folder = mkdtempSync('/private/tmp/diff-viewer-recent-');
  const file = path.join(folder, 'recent.json');
  try {
    writeFileSync(file, '{not json');
    assert.deepEqual(readRecent(file), []);
    writeFileSync(file, JSON.stringify({paths: ['/a']}));
    assert.deepEqual(readRecent(file), []);
    writeFileSync(file, JSON.stringify(['/a', 'relative', 7, null, '/a', '/b\0c', '/gone/for/good']));
    assert.deepEqual(readRecent(file), ['/a', '/gone/for/good'], 'a path that no longer exists stays listed');
    assert.deepEqual(rememberRecent(file, repo(1)), [repo(1), '/a', '/gone/for/good']);
  } finally {
    rmSync(folder, {recursive: true, force: true});
  }
});

test('recent-list: the first write creates a user-data folder that does not exist yet', () => {
  const folder = mkdtempSync('/private/tmp/diff-viewer-recent-');
  const file = path.join(folder, 'Application Support', 'diff-viewer', 'recent.json');
  try {
    assert.deepEqual(rememberRecent(file, repo(1)), [repo(1)]);
    assert.deepEqual(readRecent(file), [repo(1)], 'the list was written and reads back');
  } finally {
    rmSync(folder, {recursive: true, force: true});
  }
});

test('recent-list: forgetting a path drops only that path and keeps the order', () => {
  const folder = mkdtempSync('/private/tmp/diff-viewer-recent-');
  const file = path.join(folder, 'recent.json');
  try {
    for (let index = 1; index <= 3; index++) rememberRecent(file, repo(index));
    assert.deepEqual(forgetRecent(file, repo(2)), [3, 1].map(repo));
    assert.deepEqual(readRecent(file), [3, 1].map(repo), 'the shorter list was written');
    assert.deepEqual(forgetRecent(file, repo(9)), [3, 1].map(repo), 'a path not in the list changes nothing');
    assert.deepEqual(readdirSync(folder), ['recent.json'], 'the atomic write leaves no partial file behind');
  } finally {
    rmSync(folder, {recursive: true, force: true});
  }
});
