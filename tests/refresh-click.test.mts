import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {withStandInGit} from './electron-test.mts';


test('refresh-click: a Refresh click while a refresh still runs is not lost', () => withStandInGit('refresh-click',
  // A git that answers as usual, then waits 1 s before it exits while the flag file exists, so a refresh is still running.
  // While the flag exists, the untracked-file listing (`ls-files --others`) also writes the marker file after git returns.
  (real, folder) => {
    const flag = path.join(folder, 'slow'), listed = path.join(folder, 'listed');
    const markListing = `case " $* " in *" ls-files "*"--others "*) [ -e '${flag}' ] && : > '${listed}' ;; esac`;
    return `#!/bin/sh\n'${real}' "$@"\nstatus=$?\n${markListing}\n[ -e '${flag}' ] && sleep 1\nexit $status\n`;
  },
  async ({folder, practice, page}) => {
    const flag = path.join(folder, 'slow'), listed = path.join(folder, 'listed');
    await page.waitForSelector('.commit');
    const unstaged = () => page.evaluate(() => document.getElementById('unstaged-count')?.textContent);
    const before = Number(await unstaged());
    writeFileSync(flag, '');
    await page.locator('#refresh').click();
    // Wait until the first refresh has listed untracked files and is held by the slow git; the new file comes after that listing.
    const deadline = Date.now() + 10000;
    while (!existsSync(listed)) {
      assert(Date.now() < deadline, 'the first refresh listed untracked files within 10 s');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(await page.locator('#refresh').getAttribute('aria-busy'), 'true', 'the Refresh button shows it is busy while a refresh runs');
    writeFileSync(path.join(practice, 'written-during-refresh.txt'), 'new\n');
    await page.locator('#refresh').click();
    rmSync(flag);
    const shown = await page.waitForFunction(expected => document.getElementById('unstaged-count')?.textContent === expected, String(before + 1), {timeout: 10000}).then(() => true, () => false);
    assert.equal(shown, true, `the second click refreshes again and counts the new file (count shown: ${await unstaged()}, wanted ${before + 1})`);
    await page.waitForFunction(() => !document.getElementById('refresh')?.hasAttribute('aria-busy'), null, {timeout: 10000});
}));
