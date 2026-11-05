import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {_electron} from 'playwright';
import type {Page} from 'playwright';
import {createFixtures} from '../scripts/fixtures.mts';
import {appEnv, root, waitFor} from './electron-test.mts';
import {lines, partialClone, scratchFolder} from './repo-sandbox.mts';

const GONE = 'This repository is no longer there';

/** What the window shows: the card title, or null when the repository view is on screen. */
const shown = (page: Page) => page.evaluate(() => ({
  card: document.getElementById('start')!.hidden ? null : document.querySelector('#start h2')?.textContent ?? '',
  workspace: !document.getElementById('workspace')!.hidden,
}));

/** Clicks a stale entry in the recent menu and waits for its card. */
async function pickStale(page: Page, name: string): Promise<void> {
  await page.locator('#repo-button').click();
  await page.locator('#recent-menu button', {hasText: name}).click();
  await page.waitForFunction(title => document.querySelector('#start .card h2')?.textContent === title, GONE, {timeout: 15000});
}

test('card-recovery: a failed recent pick offers "Back to" the open repository, and a later open of that repository answers only once its view shows', async () => {
  const folder = mkdtempSync('/private/tmp/diff-viewer-card-recovery-');
  const {practice} = createFixtures(path.join(folder, 'repos'));
  const data = path.join(folder, 'data');
  mkdirSync(data);
  const stale = ['moved-1', 'moved-2', 'moved-3'].map(name => path.join(folder, name));
  writeFileSync(path.join(data, 'recent.json'), JSON.stringify(stale));
  const electron = createRequire(import.meta.url)('electron') as string;
  /** A later `diff-viewer open` of the practice repository, as the installed command starts it; resolves with its answer. */
  const openAgain = async (source: string[]) => {
    const ready = path.join(data, `ready-${randomUUID()}.json`);
    spawn(electron, [root, '--open', realpathSync(practice), '--data-dir', data, '--ready-file', ready, ...source], {cwd: root, env: appEnv(), stdio: 'ignore'});
    assert.equal(await waitFor(() => existsSync(ready), 20000), true, 'the later open answers');
    return JSON.parse(readFileSync(ready, 'utf8')) as {ready: boolean; source?: unknown; firstFile?: string | null};
  };
  const app = await _electron.launch({args: [root, '--open', practice, '--data-dir', data], cwd: root, env: appEnv(), timeout: 30000});
  try {
    const page = await app.firstWindow();
    await page.locator('.commit').first().click();
    await page.locator('#files .file').nth(1).click();
    await page.waitForFunction(() => document.querySelector('#diff .diff-panel')?.getAttribute('data-path') === document.querySelector('#files .file[aria-current="true"]')?.getAttribute('data-path'));
    const before = await page.evaluate(() => ({commit: document.querySelector('.commit[aria-current="true"]')?.getAttribute('data-hash'), file: document.querySelector('#diff .diff-panel')?.getAttribute('data-path')}));

    await pickStale(page, 'moved-1');
    assert.match(await page.locator('#start .err-box').innerText(), /from your recent list/, 'the card says the stale folder came from the recent list');
    await page.locator('#start').getByRole('button', {name: 'Back to practice'}).click();
    assert.deepEqual(await shown(page), {card: null, workspace: true}, '"Back to practice" shows the repository again');
    const after = await page.evaluate(() => ({commit: document.querySelector('.commit[aria-current="true"]')?.getAttribute('data-hash'), file: document.querySelector('#diff .diff-panel')?.getAttribute('data-path')}));
    assert.deepEqual(after, before, 'the earlier commit and file are still selected');

    await pickStale(page, 'moved-2');
    const unstaged = await openAgain(['--source', 'unstaged']);
    assert.deepEqual(await shown(page), {card: null, workspace: true}, 'by the time the open with --source answers, the card is gone and the repository view shows');
    assert.deepEqual([unstaged.ready, unstaged.firstFile], [true, 'CHANGELOG.md'], `the answer names the view on screen: ${JSON.stringify(unstaged)}`);
    assert.equal(await page.locator('#unstaged-tab').getAttribute('aria-selected'), 'true');

    await pickStale(page, 'moved-3');
    const plain = await openAgain([]);
    assert.equal(plain.ready, true);
    assert.deepEqual(await shown(page), {card: null, workspace: true}, 'by the time an open without --source answers, the repository view shows');
  } finally {
    await app.close();
    rmSync(folder, {recursive: true, force: true});
  }
});

const {scratch, sandbox} = scratchFolder('not-counted');

test('not-counted: a file listed without line counts says why, in a partial clone and for a large untracked file', async () => {
  const box = sandbox('source');
  box.write('kept.txt', lines(3));
  box.commit('First');
  box.write('kept.txt', lines(3, {2: 'two'}));
  box.commit('Second');
  // The first commit's kept.txt stays on the promisor remote, so the newest commit's list has no line counts.
  const clone = partialClone(scratch, box.folder, 'partial');
  writeFileSync(path.join(clone, 'huge.log'), 'x'.repeat(600_000));
  const data = path.join(scratch, 'data');
  mkdirSync(data);
  const app = await _electron.launch({args: [root, '--open', clone, '--data-dir', data], cwd: root, env: appEnv(), timeout: 30000});
  try {
    const page = await app.firstWindow();
    const stat = (file: string) => page.locator(`#files .file[data-path="${file}"] .stat`);
    await page.locator('.commit').first().click();
    await stat('kept.txt').waitFor();
    assert.deepEqual([await stat('kept.txt').innerText(), await stat('kept.txt').getAttribute('title')], ['not counted', 'Not counted: this partial clone does not hold the file data'], 'a commit file in a partial clone');
    await page.locator('#unstaged-tab').click();
    await stat('huge.log').waitFor();
    assert.deepEqual([await stat('huge.log').innerText(), await stat('huge.log').getAttribute('title')], ['not counted', 'Not counted: the file is over 200.0 KB, or the app could not read it'], 'a large untracked file');
  } finally {
    await app.close();
  }
});
