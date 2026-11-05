import {test} from 'node:test';
import assert from 'node:assert/strict';
import {diffRows as highlightedRows, plainVersion, sharedRuns} from '../src/domain/diff.ts';
import type {DiffRow, Line} from '../src/domain/types.ts';

const side = (line: Line | null) => line ? `${line.number}:${line.tokens.map(token => token.text).join('')}` : '-';
function view(rows: readonly DiffRow[]): string[] {
  return rows.map(row => row.kind === 'hidden'
    ? `hidden ${row.rows.map(inner => `${side(inner.left)}|${side(inner.right)}`).join(' ')}`
    : `${row.kind} ${side(row.left)}|${side(row.right)}`);
}
const diffRows = (diff: string, oldText: string, newText: string) => highlightedRows(diff, plainVersion(oldText), plainVersion(newText));
const text = (...lines: string[]) => lines.map(line => line + '\n').join('');
const numbered = (count: number, change: Record<number, string> = {}) => text(...Array.from({length: count}, (_, index) => change[index + 1] ?? `line ${index + 1}`));

test('diff-rows: an added file is all additions on the right', () => {
  const diff = 'diff --git a/a.txt b/a.txt\nnew file mode 100644\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n';
  assert.deepEqual(view(diffRows(diff, '', text('one', 'two'))), ['change -|1:one', 'change -|2:two']);
});

test('diff-rows: a deleted file is all deletions on the left', () => {
  const diff = '--- a/a.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two\n';
  assert.deepEqual(view(diffRows(diff, text('one', 'two'), '')), ['change 1:one|-', 'change 2:two|-']);
});

test('diff-rows: a replaced block pairs removed and added lines in order, extras stand alone', () => {
  const diff = '@@ -1,4 +1,3 @@\n a\n-b\n-c\n+B\n d\n';
  assert.deepEqual(view(diffRows(diff, text('a', 'b', 'c', 'd'), text('a', 'B', 'd'))), ['context 1:a|1:a', 'change 2:b|2:B', 'change 3:c|-', 'context 4:d|3:d']);
  const grow = '@@ -1,3 +1,4 @@\n a\n-b\n+B\n+C\n d\n';
  assert.deepEqual(view(diffRows(grow, text('a', 'b', 'd'), text('a', 'B', 'C', 'd'))), ['context 1:a|1:a', 'change 2:b|2:B', 'change -|3:C', 'context 3:d|4:d']);
});

test('diff-rows: unchanged lines between and around two hunks become hidden rows holding their context rows', () => {
  const oldText = numbered(20), newText = numbered(20, {5: 'five', 16: 'sixteen'});
  const diff = '@@ -2,7 +2,7 @@\n line 2\n line 3\n line 4\n-line 5\n+five\n line 6\n line 7\n line 8\n@@ -13,7 +13,7 @@\n line 13\n line 14\n line 15\n-line 16\n+sixteen\n line 17\n line 18\n line 19\n';
  const rows = diffRows(diff, oldText, newText);
  assert.deepEqual(rows.map(row => row.kind), ['hidden', 'context', 'context', 'context', 'change', 'context', 'context', 'context', 'hidden', 'context', 'context', 'context', 'change', 'context', 'context', 'context', 'hidden']);
  assert.deepEqual(view(rows)[0], 'hidden 1:line 1|1:line 1');
  assert.deepEqual(view(rows)[8], 'hidden 9:line 9|9:line 9 10:line 10|10:line 10 11:line 11|11:line 11 12:line 12|12:line 12');
  assert.deepEqual(view(rows)[16], 'hidden 20:line 20|20:line 20');
  assert.equal(view(rows)[4], 'change 5:line 5|5:five');
  const oldNumbers = rows.flatMap(row => row.kind === 'hidden' ? row.rows.map(inner => inner.left.number) : row.left ? [row.left.number] : []);
  assert.deepEqual(oldNumbers, Array.from({length: 20}, (_, index) => index + 1), 'every old line appears once, in order');
});

test('diff-rows: a file with no trailing newline keeps its last line and skips git\'s marker', () => {
  const diff = '@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n';
  assert.deepEqual(view(diffRows(diff, 'a\nb', 'a\nc')), ['context 1:a|1:a', 'change 2:b|2:c']);
  const addNewline = '@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+a\n';
  assert.deepEqual(view(diffRows(addNewline, 'a', 'a\n')), ['change 1:a|1:a']);
});

test('diff-rows: a rename with edits reads the headers, then shows old and new names\' lines side by side', () => {
  const diff = 'diff --git a/old.ts b/new.ts\nsimilarity index 80%\nrename from old.ts\nrename to new.ts\nindex 1111111..2222222 100644\n--- a/old.ts\n+++ b/new.ts\n@@ -1,3 +1,3 @@\n keep\n-old\n+new\n same\n';
  assert.deepEqual(view(diffRows(diff, text('keep', 'old', 'same', 'tail'), text('keep', 'new', 'same', 'tail'))), ['context 1:keep|1:keep', 'change 2:old|2:new', 'context 3:same|3:same', 'hidden 4:tail|4:tail']);
  assert.deepEqual(view(diffRows('', text('x', 'y'), text('x', 'y'))), ['hidden 1:x|1:x 2:y|2:y'], 'a pure rename has one hidden run');
});

test('diff-rows: an empty context line and a mismatched diff are handled', () => {
  assert.deepEqual(view(diffRows('@@ -1,2 +1,2 @@\n\n-b\n+c\n', text('', 'b'), text('', 'c'))), ['context 1:|1:', 'change 2:b|2:c']);
  assert.throws(() => diffRows('@@ -1,1 +1,1 @@\n-a\n+b\n', text('a', 'x'), text('b')), /unchanged runs differ/);
});

test('diff-rows: a paired change row carries changed-word marks, a lone added line does not', () => {
  const rows = diffRows('@@ -1,1 +1,2 @@\n-let total = count;\n+let total = amount;\n+next();\n', text('let total = count;'), text('let total = amount;', 'next();'));
  const marked = (line: Line | null) => line?.tokens.filter(token => token.changed).map(token => token.text);
  assert.deepEqual(rows.map(row => row.kind === 'change' ? [marked(row.left), marked(row.right)] : row.kind), [[['count'], ['amount']], [undefined, []]]);
});

test('shared-runs: the unchanged lines outside and inside the hunks, joined where they touch', () => {
  const diff = '@@ -2,7 +2,8 @@\n line 2\n line 3\n line 4\n-line 5\n+five\n+five and a half\n line 6\n line 7\n line 8\n@@ -17,3 +18,2 @@\n line 17\n-line 18\n line 19\n';
  assert.deepEqual(sharedRuns(diff, 20), [
    {oldStart: 1, newStart: 1, length: 4}, {oldStart: 6, newStart: 7, length: 12}, {oldStart: 19, newStart: 19, length: 2},
  ]);
  assert.deepEqual(sharedRuns('@@ -0,0 +1,2 @@\n+one\n+two\n', 0), [], 'an added file shares nothing');
  assert.deepEqual(sharedRuns('', 3), [{oldStart: 1, newStart: 1, length: 3}], 'no hunks: every line is shared');
});
