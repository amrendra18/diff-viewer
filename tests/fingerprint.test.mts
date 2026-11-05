import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync, mkdirSync, rmSync, symlinkSync} from 'node:fs';
import path from 'node:path';
import {fingerprint} from '../scripts/fingerprint.mts';
import {scratchFolder} from './repo-sandbox.mts';

const {sandbox} = scratchFolder('fingerprint');

test('fingerprint: a retargeted link, a mode change, an empty folder, and a new link in .git each change it', () => {
  const box = sandbox('repository');
  box.write('run.sh', 'echo run\n');
  box.write('a.txt', 'a\n');
  box.write('b.txt', 'b\n');
  symlinkSync('a.txt', path.join(box.folder, 'link'));
  box.commit('Start');
  const prints = [fingerprint(box.folder)];
  assert.equal(fingerprint(box.folder), prints[0], 'control: an unchanged folder keeps its fingerprint');
  const changes: [string, () => void][] = [
    ['a retargeted link', () => { rmSync(path.join(box.folder, 'link')); symlinkSync('b.txt', path.join(box.folder, 'link')); }],
    ['chmod 600 on run.sh', () => chmodSync(path.join(box.folder, 'run.sh'), 0o600)],
    ['an empty folder in .git', () => mkdirSync(path.join(box.folder, '.git/empty'))],
    ['a new link in .git', () => symlinkSync('HEAD', path.join(box.folder, '.git/HEAD-link'))],
  ];
  for (const [what, change] of changes) {
    change();
    const print = fingerprint(box.folder);
    assert.ok(!prints.includes(print), `${what} changes the fingerprint`);
    prints.push(print);
  }
});
