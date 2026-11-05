import {test} from 'node:test';
import assert from 'node:assert/strict';
import {keptView} from '../src/web/kept-view.ts';

test('kept-view: a refresh keeps the open file\'s scroll position and "Show anyway" only when the diff on screen is that file\'s', () => {
  assert.deepEqual(keptView('big.ts', {path: 'big.ts', showLarge: true}, 250), {path: 'big.ts', scrollTop: 250, showLarge: true}, 'the open file\'s own diff keeps its place');
  assert.deepEqual(keptView('clicked.ts', {path: 'big.ts', showLarge: true}, 250), {path: 'clicked.ts', scrollTop: 0, showLarge: false},
    'a refresh between a click and its answer keeps the clicked file, at the top and collapsed');
  assert.deepEqual(keptView('clicked.ts', null, 250), {path: 'clicked.ts', scrollTop: 0, showLarge: false}, 'no diff on screen: the open file starts at the top');
  assert.equal(keptView(null, {path: 'big.ts', showLarge: true}, 250), null, 'no open file: nothing is kept');
});
