import {test} from 'node:test';
import assert from 'node:assert/strict';
import {displayName, journeyFailure, screenCheck} from '../scripts/screen.mts';

test('screen-lock: the doctor refuses when loginwindow is in front and allows any other front app', () => {
  const locked = screenCheck('loginwindow');
  assert.equal(locked.ok, false);
  assert.match(locked.detail, /the screen is locked/);
  assert.equal(screenCheck('Terminal').ok, true, 'positive control: an unlocked screen with Terminal in front is allowed');
  assert.equal(screenCheck(null).ok, true, 'no name from lsappinfo does not block a run');
});

test('screen-lock: the front app name comes from lsappinfo output', () => {
  assert.equal(displayName('"LSDisplayName"="Terminal"\n'), 'Terminal');
  assert.equal(displayName('"LSDisplayName"="loginwindow"\n'), 'loginwindow');
  assert.equal(displayName(''), null, 'empty output names no app');
});

test('screen-lock: a journey that fails while loginwindow is in front is reported as a lock, not as the feature failing', () => {
  const locked = journeyFailure('page.waitForFunction: Timeout 30000ms exceeded', 'loginwindow');
  assert.equal(locked.locked, true);
  assert.match(locked.reason, /^the screen locked during the run/);
  assert.deepEqual(journeyFailure('page.waitForFunction: Timeout 30000ms exceeded', 'Terminal'), {locked: false, reason: 'page.waitForFunction: Timeout 30000ms exceeded'},
    'positive control: with Terminal in front, the failure stays the feature\'s own');
});
