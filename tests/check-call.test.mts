import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

test('check-call: a bad call and --help end with the exit line, as CONTRIBUTING.md says', () => {
  for (const [args, status] of [[[], 2], [['bogus'], 2], [['--help'], 0]] as [string[], number][]) {
    const result = spawnSync(path.join(root, 'scripts/check'), args, {cwd: root, encoding: 'utf8'});
    assert.equal(result.status, status, `check ${args.join(' ')}: ${result.stdout}`);
    assert.equal(result.stdout.trim().split('\n').at(-1), `check exit ${status}`, `check ${args.join(' ')} ends with its exit line`);
  }
  for (const [args, line] of [[['fast', 'extra'], 'check fast exit 2'], [['full', '--bogus'], 'check full exit 2']] as [string[], string][]) {
    const result = spawnSync(path.join(root, 'scripts/check'), args, {cwd: root, encoding: 'utf8'});
    assert.equal(result.stdout.trim().split('\n').at(-1), line, `a call that names a level keeps it in the exit line: ${args.join(' ')}`);
  }
});
