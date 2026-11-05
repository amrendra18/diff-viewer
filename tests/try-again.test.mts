import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {_electron} from 'playwright';
import type {ElectronApplication, Page} from 'playwright';
import {appEnv, failingLog, root, waitFor, withStandInGit} from './electron-test.mts';
import {scratchFolder} from './repo-sandbox.mts';

const FAILED = 'Git could not read this repository';
const electronBinary = createRequire(import.meta.url)('electron') as string;

/** Makes the next "Open repository…" dialog answer with `folder`, as if the person chose it. */
function chooseInDialog(app: ElectronApplication, folder: string): Promise<void> {
  return app.evaluate(({dialog}, chosen) => {
    dialog.showOpenDialog = (async () => ({canceled: false, filePaths: [chosen]})) as typeof dialog.showOpenDialog;
  }, folder);
}

/** The title of the screen card and whether it offers "Try again", once the card shows `title`. */
async function cardShown(page: Page, title: string): Promise<{title: string; tryAgain: number}> {
  await page.waitForFunction(expected => document.querySelector('.card h2')?.textContent === expected, title, {timeout: 15000});
  return {title: await page.locator('.card h2').innerText(), tryAgain: await page.getByRole('button', {name: 'Try again'}).count()};
}

test('try-again: "Try again" is offered when the window\'s own repository fails, and not after a failed pick from the chooser or the recent list', () => withStandInGit('try-again',
  // Every `git log` fails, so the practice repository opens but its commit list cannot load.
  failingLog,
  async ({folder, practice, app, page}) => {
    assert.deepEqual(await cardShown(page, FAILED), {title: FAILED, tryAgain: 1}, 'control: the window\'s own repository failed, so "Try again" reloads it');

    await chooseInDialog(app, practice);
    await page.locator('.card').getByRole('button', {name: 'Open repository…'}).click();
    await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).some(button => button.textContent === 'Try again'), null, {timeout: 15000}).catch(() => undefined);
    assert.deepEqual(await cardShown(page, FAILED), {title: FAILED, tryAgain: 0}, 'a failed pick from the chooser offers no "Try again"');

    // A folder that is not a repository leads to a screen with the recent list, which holds the practice repository.
    const plain = path.join(folder, 'plain');
    mkdirSync(plain);
    await chooseInDialog(app, plain);
    await page.locator('.card').getByRole('button', {name: 'Open repository…'}).click();
    await cardShown(page, 'This folder is not a git repository');
    await page.locator('.recent button', {hasText: practice}).click();
    assert.deepEqual(await cardShown(page, FAILED), {title: FAILED, tryAgain: 0}, 'a failed pick from the recent list offers no "Try again"');
  }));

const {scratch, sandbox} = scratchFolder('try-again-start');

/** Starts the app on a repository whose broken config stops the start, then repairs the config and calls `body`. */
async function withRepairedStart(name: string, body: (setup: {app: ElectronApplication; page: Page; folder: string; data: string}) => Promise<void>): Promise<void> {
  const box = sandbox(name);
  box.write('a.txt', 'one\n');
  box.commit('Start');
  const config = path.join(box.folder, '.git/config');
  const good = readFileSync(config);
  appendFileSync(config, '\n[broken\n');
  const data = path.join(scratch, `data-${name}`);
  mkdirSync(data);
  const app = await _electron.launch({args: [root, '--open', box.folder, '--data-dir', data], cwd: root, env: appEnv(), timeout: 30000});
  try {
    const page = await app.firstWindow();
    assert.deepEqual(await cardShown(page, FAILED), {title: FAILED, tryAgain: 1}, 'the broken config stops the start, and the card offers "Try again"');
    writeFileSync(config, good);
    await body({app, page, folder: realpathSync(box.folder), data});
  } finally { await app.close(); }
}

test('try-again: after a failed start, "Try again" opens the repository again and shows it once it is repaired', () => withRepairedStart('broken-config', async ({page}) => {
  await page.getByRole('button', {name: 'Try again'}).click();
  await page.waitForSelector('.commit', {timeout: 15000});
  assert.equal(await page.locator('.commit').count(), 1, 'the repaired repository shows its one commit');
}));

test('try-again: "Try again" after a failed start does not show a repository that another window already shows', () => withRepairedStart('shown-twice', async ({app, page, folder, data}) => {
  // A second app hands the repaired repository to the running one, which opens it in a new window.
  const readyFile = path.join(data, `ready-${randomUUID()}.json`);
  // spawn, not spawnSync: a blocked test process would stop Playwright from reading the running app's output.
  const second = spawn(electronBinary, [root, '--open', folder, '--data-dir', data, '--ready-file', readyFile], {cwd: root, env: appEnv(), stdio: 'ignore'});
  const code = await new Promise(resolve => second.once('exit', resolve));
  assert.equal(code, 0, `the hand-off answers ready: ${existsSync(readyFile) ? readFileSync(readyFile, 'utf8') : 'no ready file'}`);
  assert.equal(await waitFor(() => app.windows().length === 2, 5000), true, `control: the repository now shows in a second window (${app.windows().length} windows)`);
  await page.getByRole('button', {name: 'Try again'}).click();
  // The window settles on its repository's commits, or on the first-run card when another window already shows it.
  await page.waitForFunction(() => document.querySelector('.commit') !== null || document.querySelector('.card h2')?.textContent === 'Open a git repository', null, {timeout: 15000});
  const titles = await Promise.all(app.windows().map(each => each.title()));
  assert.equal(titles.filter(title => title.startsWith(path.basename(folder))).length, 1, `one window shows the repository: ${JSON.stringify(titles)}`);
  assert.equal(await page.locator('.commit').count(), 0, 'the failed window does not show the repository a second time');
}));
