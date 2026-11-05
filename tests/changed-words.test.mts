import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Line, TokenColor } from '../src/domain/types.ts';
import { markChangedWords } from '../src/domain/words.ts';

const KEYWORD: TokenColor = { light: '#0000ff', dark: '#569cd6' };
const NAME: TokenColor = { light: '#001080', dark: '#9cdcfe' };
const PLAIN: TokenColor = { light: '#000000', dark: '#d4d4d4' };

const line = (...tokens: Array<[string, TokenColor | null]>): Line => ({
  number: 1,
  tokens: tokens.map(([text, color]) => ({ text, color, changed: false })),
});
const plain = (text: string): Line => line([text, null]);
const changedTexts = (l: Line): string[] => l.tokens.filter((t) => t.changed).map((t) => t.text);
const joined = (l: Line): string => l.tokens.map((t) => t.text).join('');

describe('changed-words', () => {
  test('one word replaced', () => {
    const result = markChangedWords(plain('const total = count + 1;'), plain('const total = amount + 1;'));
    assert.deepEqual(changedTexts(result.left), ['count']);
    assert.deepEqual(changedTexts(result.right), ['amount']);

    const accent = markChangedWords(plain('un café'), plain('un thé'));
    assert.deepEqual(changedTexts(accent.left), ['café']);
    assert.deepEqual(changedTexts(accent.right), ['thé']);
  });

  test('neighboring changed words join into one mark', () => {
    const result = markChangedWords(plain('let label = old value;'), plain('let label = new text;'));
    assert.deepEqual(changedTexts(result.left), ['old value']);
    assert.deepEqual(changedTexts(result.right), ['new text']);
  });

  test('words added at the end', () => {
    const result = markChangedWords(plain('return value'), plain('return value ?? fallback'));
    assert.deepEqual(changedTexts(result.left), []);
    assert.deepEqual(changedTexts(result.right), [' ?? fallback']);
  });

  test('whitespace-only change', () => {
    const result = markChangedWords(plain('if (a  &&  b)'), plain('if (a && b)'));
    assert.deepEqual(changedTexts(result.left), ['  ', '  ']);
    assert.deepEqual(changedTexts(result.right), [' ', ' ']);

    const indent = markChangedWords(plain('  x();'), plain('    x();'));
    assert.deepEqual(changedTexts(indent.left), ['  ']);
    assert.deepEqual(changedTexts(indent.right), ['    ']);
  });

  test('punctuation change', () => {
    const result = markChangedWords(plain('call(a, b);'), plain('call(a; b);'));
    assert.deepEqual(changedTexts(result.left), [',']);
    assert.deepEqual(changedTexts(result.right), [';']);
  });

  test('tokens already split by color keep their colors after splitting', () => {
    const result = markChangedWords(
      line(['const', KEYWORD], [' ', null], ['total', NAME], [' = count + 1;', PLAIN]),
      line(['const', KEYWORD], [' ', null], ['total', NAME], [' = amount + 1;', PLAIN]),
    );
    assert.deepEqual(result.left, {
      number: 1,
      tokens: [
        { text: 'const', color: KEYWORD, changed: false },
        { text: ' ', color: null, changed: false },
        { text: 'total', color: NAME, changed: false },
        { text: ' = ', color: PLAIN, changed: false },
        { text: 'count', color: PLAIN, changed: true },
        { text: ' + 1;', color: PLAIN, changed: false },
      ],
    });
    assert.deepEqual(result.right.tokens.map((t) => [t.text, t.color, t.changed]), [
      ['const', KEYWORD, false],
      [' ', null, false],
      ['total', NAME, false],
      [' = ', PLAIN, false],
      ['amount', PLAIN, true],
      [' + 1;', PLAIN, false],
    ]);

    const across = markChangedWords(line(['let ', KEYWORD], ['a', NAME]), line(['let ', KEYWORD], ['b', NAME]));
    assert.deepEqual(across.right.tokens.map((t) => [t.text, t.changed]), [['let ', false], ['b', true]]);
  });

  test('the share cut-off', () => {
    // Real pair from a JavaScript project: share 0.395 with several marks per side, so it reads as confetti.
    const confetti = markChangedWords(
      plain("const {test}=require('node:test');"),
      plain("module.exports = require('./setup.test.mts');"),
    );
    assert.deepEqual(changedTexts(confetti.left), []);
    assert.deepEqual(changedTexts(confetti.right), []);

    // Real pair from a Python project: share 0.40 with two marks per side, at the cut-off, so marks stay.
    const atCutOff = markChangedWords(
      plain('print("--file needs a path", file=sys.stderr)'),
      plain('explain("--file needs a path", "it was the last argument",'),
    );
    assert.deepEqual(changedTexts(atCutOff.left), ['print', 'file=sys.stderr)']);
    assert.deepEqual(changedTexts(atCutOff.right), ['explain', '"it was the last argument",']);

    // Real pair from a shell project: share 0.288 but one mark, so it stays.
    const appended = markChangedWords(plain('tmp="$(mktemp -d)"'), plain('tmp="$(mktemp -d "${TMPDIR:-/tmp}/sample-check-test.XXXXXX")"'));
    assert.deepEqual(changedTexts(appended.left), []);
    assert.deepEqual(changedTexts(appended.right), [' "${TMPDIR:-/tmp}/sample-check-test.XXXXXX"']);

    const nothingShared = markChangedWords(plain('alpha beta'), plain('gamma delta'));
    assert.deepEqual(changedTexts(nothingShared.left), []);
    assert.deepEqual(changedTexts(nothingShared.right), []);
  });

  test('the long-line limit', () => {
    const shared = 'ab '.repeat(666);
    const chars2000 = shared + 'ok';
    const other2000 = shared + 'no';
    const chars2001 = shared + 'okk';
    assert.deepEqual([chars2000.length, other2000.length, chars2001.length], [2000, 2000, 2001]);

    const atLimit = markChangedWords(plain(chars2000), plain(other2000));
    assert.deepEqual(changedTexts(atLimit.left), ['ok']);
    assert.deepEqual(changedTexts(atLimit.right), ['no']);

    const leftLong = markChangedWords(plain(chars2001), plain(other2000));
    assert.deepEqual(changedTexts(leftLong.left), []);
    assert.deepEqual(changedTexts(leftLong.right), []);

    const rightLong = markChangedWords(plain(other2000), plain(chars2001));
    assert.equal(joined(rightLong.right), chars2001);
    assert.deepEqual(changedTexts(rightLong.left), []);
    assert.deepEqual(changedTexts(rightLong.right), []);
  });

  test('real pairs near the cut-off', () => {
    // Pairs from the histories of two real projects, with their share of common characters.
    const cases: Array<{share: number; old: string; new: string; left: string[]; right: string[]}> = [
      {share: 0.352, old: 'let message = (error as? NativeFailure)?.message ?? error.localizedDescription', new: 'let failure = error as? NativeFailure', left: [], right: []},
      {share: 0.302, old: "const ts=require('typescript');", new: "module.exports = require('./boundaries.mts');", left: [], right: []},
      {share: 0.391, old: '## Current repair result', new: '## Current check execution', left: ['repair result'], right: ['check execution']},
      {share: 0.375, old: 'if fails:', new: 'if shown:', left: ['fails'], right: ['shown']},
      {share: 0.34, old: '"node_modules/@electron/get/node_modules/undici": {', new: '"node_modules/minimatch": {', left: ['@electron/get/node_modules/undici'], right: ['minimatch']},
      {share: 0.443, old: "const ordinaryFolder = path.join(fixtureRoot, 'ordinary-folder');", new: "const gitFolder = path.join(branch, 'git folder café');", left: ['ordinaryFolder', 'fixtureRoot', 'ordinary-'], right: ['gitFolder', 'branch', 'git ', ' café']},
      {share: 0.438, old: 'lines = p.read_text(encoding="utf-8").splitlines()', new: 'lines = read(p).splitlines()', left: ['p.read_text', 'encoding="utf-8"'], right: ['read', 'p']},
    ];
    for (const pair of cases) {
      const result = markChangedWords(plain(pair.old), plain(pair.new));
      assert.deepEqual([changedTexts(result.left), changedTexts(result.right)], [pair.left, pair.right], `share ${pair.share}: ${pair.old}`);
    }
  });
});
