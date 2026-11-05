import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {waitFor, withStandInGit} from './electron-test.mts';



test('focus-refresh: a focus refresh on an open commit file reads no diff again; on the Unstaged tab it lists once and reads the open file again only when it changed', () => withStandInGit('focus-refresh',
  // A git that logs each call's arguments and passes it on to the real git.
  (real, folder) => `#!/bin/sh\nprintf '%s\\n' "$*" >> '${path.join(folder, 'calls.log')}'\nexec '${real}' "$@"\n`,
  async ({folder, practice, page}) => {
    const log = path.join(folder, 'calls.log');
    const calls = () => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    await page.locator('.commit').first().click();
    await page.waitForSelector('#diff table.diff');
    await page.waitForFunction(() => !document.getElementById('diff')!.hasAttribute('aria-busy'));
    // The page's own focus listener runs; Playwright's focus emulation would hide a real focus change.
    const focus = () => page.evaluate(() => window.dispatchEvent(new Event('focus')));

    rmSync(log, {force: true});
    await focus();
    assert.equal(await waitFor(() => calls().some(call => / log /.test(call)), 10000), true, 'the focus refresh reloads the newest commits');
    // A negative check needs a wait. A focus refresh that reloads the commit file makes its first diff-tree call
    // 51 to 52 ms after the log call (3 runs); 1 s is about 20 times that.
    await waitFor(() => calls().some(call => / diff-tree /.test(call)), 1000);
    assert.deepEqual(calls().filter(call => / diff-tree /.test(call)), [], 'no commit file list or diff is read again');

    await page.locator('#unstaged-tab').click();
    await page.waitForSelector('#diff .diff-panel[data-path="CHANGELOG.md"]');
    await page.waitForFunction(() => !document.getElementById('diff')!.hasAttribute('aria-busy'));
    // The page skips a focus refresh within 1 s of the last one.
    await new Promise(resolve => setTimeout(resolve, 1200));
    rmSync(log, {force: true});
    await focus();
    const openFileListed = () => calls().some(call => call.endsWith('diff-files --raw --numstat -z -- CHANGELOG.md'));
    assert.equal(await waitFor(openFileListed, 10000), true, 'the focus refresh asks for the open file\'s diff again');
    // A second listing would come before the open file's own call; 1 s more covers a late one.
    await waitFor(() => false, 1000);
    const listings = calls().filter(call => call.endsWith('diff-files --raw --numstat -z'));
    assert.equal(listings.length, 1, `one focus refresh lists the unstaged changes once (calls: ${calls().join(' | ')})`);
    assert.deepEqual(calls().filter(call => / diff-files -p /.test(call)), [], 'an unchanged open file is not read or highlighted again');

    writeFileSync(path.join(practice, 'CHANGELOG.md'), readFileSync(path.join(practice, 'CHANGELOG.md'), 'utf8') + 'Refreshed line.\n');
    await new Promise(resolve => setTimeout(resolve, 1200));
    rmSync(log, {force: true});
    await focus();
    assert.equal(await waitFor(() => calls().some(call => / diff-files -p /.test(call)), 10000), true, `positive control: a changed open file is read again (calls: ${calls().length})`);
    await page.waitForFunction(() => Array.from(document.querySelectorAll('#diff td.cd.r')).some(cell => cell.textContent === 'Refreshed line.'), null, {timeout: 10000});
}));
