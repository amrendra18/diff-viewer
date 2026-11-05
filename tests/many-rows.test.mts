import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {_electron} from 'playwright';
import {appEnv, root} from './electron-test.mts';
import {env, scratchFolder} from './repo-sandbox.mts';

const {scratch, sandbox} = scratchFolder('many-rows');
const ABOVE_SPREAD_LIMIT = 130_000;

const blob = (text: string) => `data ${Buffer.byteLength(text)}\n${text}\n`;
const commit = (mark: number, subject: string, changes: string) =>
  `commit refs/heads/main\nmark :${mark}\ncommitter Case <case@example.invalid> ${1767225600 + mark} +0000\n${blob(subject)}${mark > 1 ? `from :${mark - 1}\n` : ''}${changes}\n`;

test('many-rows: 130,000 files in a commit, 130,000 rows in a file, and 130,000 hidden lines all show', {timeout: 240_000}, async () => {
  const box = sandbox('many');
  const text = Array.from({length: ABOVE_SPREAD_LIMIT + 10}, (_, index) => `line ${index + 1}`);
  const edited = [...text.slice(0, -1), 'last line edited'];
  const files = Array.from({length: ABOVE_SPREAD_LIMIT}, (_, index) => `M 100644 inline many/${String(index).padStart(6, '0')}.txt\n${blob('x\n')}`).join('');
  execFileSync('git', ['-C', box.folder, 'fast-import', '--quiet'], {env, maxBuffer: 1 << 28, input: [
    commit(1, 'Add the long file', `M 100644 inline long.txt\n${blob(text.join('\n') + '\n')}`),
    commit(2, 'Edit its last line', `M 100644 inline long.txt\n${blob(edited.join('\n') + '\n')}`),
    commit(3, 'Add many files', files),
  ].join('')});
  box.git('config', 'core.bare', 'true');
  const app = await _electron.launch({args: [root, '--open', box.folder, '--data-dir', path.join(scratch, 'data')], cwd: root, env: appEnv(), timeout: 30000});
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const openCommit = async (subject: string) => {
      await page.locator('.commit', {hasText: subject}).click();
      await page.waitForFunction(wanted => document.getElementById('subject')?.textContent === wanted && !document.getElementById('diff')?.hasAttribute('aria-busy') && Boolean(document.querySelector('#files .file')), subject, {timeout: 40000})
        .catch((error: unknown) => assert.fail(`${subject} did not show. Page errors: ${errors.join('; ') || 'none'}. ${String(error)}`));
    };
    await page.waitForSelector('.commit');

    await openCommit('Add many files');
    assert.equal(await page.locator('#files .file').count(), ABOVE_SPREAD_LIMIT, 'every file of the commit is listed');

    await openCommit('Edit its last line');
    await page.locator('#show-large').click();
    await page.waitForSelector('#diff tr.gap button', {timeout: 40000});
    await page.locator('#diff tr.gap button').click();
    await page.waitForFunction(wanted => document.querySelectorAll('#diff tbody tr').length >= wanted, ABOVE_SPREAD_LIMIT, {timeout: 40000});
    assert.equal(await page.locator('#diff tr.gap').count(), 0, 'the hidden lines replaced their bar');

    await openCommit('Add the long file');
    await page.locator('#show-large').click();
    await page.waitForFunction(wanted => document.querySelectorAll('#diff tbody tr').length === wanted, ABOVE_SPREAD_LIMIT + 10, {timeout: 40000});
    assert.deepEqual(errors, [], 'the page reported no error');
  } finally { await app.close(); }
});
