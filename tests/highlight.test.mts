import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {codeToTokens} from 'shiki';

import {createHighlighter, languageFor, pairThemes, tokenColor} from '../src/app/highlight.ts';

const {version: compiledHighlightVersion} = (createRequire(import.meta.url)('../dist/src/app/highlight.js') as typeof import('../src/app/highlight.ts')).createHighlighter();

const HEX = /^#[0-9a-fA-F]{3,8}$/;
/** HTML grammars hand <style> and <script> to the CSS and JavaScript grammars. */
const EMBEDDED_LANGUAGES_PAGE = `<!doctype html>
<style>
/* a comment */
.row:hover { color: #24292e; margin: 4px; }
</style>
<p class="row">Text &amp; more</p>
<label for="pick">Pick</label><select id="pick"><option value="1" selected>One</option></select>
<script>
// a comment
const greet = (name) => \`hello \${name}\`;
for (const row of [1, 2]) console.log(greet(row), /a+/g.test('aa'));
const pattern = /(?:a|b)(?<!c)(?!d)(?=e)[^f]/;
let count = String.raw\`x\`.length + (1.5 << 2);
count--;
delete globalThis.count;
</script>
`;
const root = path.resolve(import.meta.dirname, '..');

/** One entry per character: its light and dark color, so token boundaries do not matter. */
const perCharacter = (lines: readonly (readonly {text: string; light: string | null; dark: string | null}[])[]) =>
  lines.map(line => line.flatMap(token => Array.from(token.text, () => `${token.light}/${token.dark}`)));

test('highlight: a TypeScript file gets light and dark colors on every token, one line per file line', async () => {
  const text = 'const greeting: string = "hi";\n\nexport function twice(n: number) {\n  return n * 2;\n}\n';
  const version = await compiledHighlightVersion(text, 'src/app.ts');
  assert.equal(version.length, 5);
  assert.deepEqual(version.map(line => line.map(token => token.text).join('')), text.split('\n').slice(0, 5));
  const tokens = version.flat();
  assert.ok(tokens.every(token => token.color && HEX.test(token.color.light) && HEX.test(token.color.dark) && !token.changed));
  const keyword = tokens.find(token => token.text === 'const');
  assert.deepEqual(keyword?.color, {light: '#D73A49', dark: '#F97583'}, 'github-light and github-dark keyword colors');
  assert.ok(new Set(tokens.map(token => token.color?.light)).size >= 4, 'several distinct colors, so the grammar ran');
});

test('highlight: a line over 10,000 characters comes back as one plain token, and shorter lines keep their colors', async () => {
  const long = `var a = "${'x'.repeat(10_000)}";`;
  const version = await compiledHighlightVersion(`${long}\nconst b = 1;\n`, 'bundle.js');
  assert.deepEqual(version[0].map(token => token.text), [long], 'the long line is not split into grammar tokens');
  assert.ok(version[1].length > 1, 'the next line is still highlighted');
});

test('highlight: language by file name, with unknown names as plain text', async () => {
  const cases: Record<string, string> = {
    'a/b.ts': 'typescript', 'x.MTS': 'typescript', 'App.tsx': 'tsx', 'run.cjs': 'javascript', 'package.json': 'json', 'conf.jsonc': 'jsonc',
    'README.md': 'markdown', 'tool.py': 'python', 'bin/spawn.sh': 'shellscript', '.zshrc': 'shellscript', 'main.go': 'go', 'lib.rs': 'rust',
    'ci.yml': 'yaml', 'Cargo.toml': 'toml', 'Makefile': 'make', 'rules.mk': 'make', 'Dockerfile': 'dockerfile', 'Dockerfile.dev': 'dockerfile',
    'CMakeLists.txt': 'cmake', 'x.h': 'c', 'x.hpp': 'cpp', 'fix.patch': 'diff',
    '.gitignore': 'text', 'LICENSE': 'text', 'notes.txt': 'text', 'archive.tar.gz': 'text', 'constructor': 'text', 'x.__proto__': 'text',
  };
  for (const [path, language] of Object.entries(cases)) assert.equal(languageFor(path), language, path);
  const plain = await compiledHighlightVersion('hello <b>\n', 'notes.txt');
  assert.deepEqual(plain, [[{text: 'hello <b>', color: null, changed: false}]]);
});

test('highlight: a language that fails to load falls back to plain text', async () => {
  const failing = createHighlighter({...Object.fromEntries(['typescript', 'javascript', 'json', 'css', 'html', 'markdown', 'python', 'shellscript', 'go', 'rust'].map(name => [name, () => import(`shiki/langs/${name}.mjs`)])),
    yaml: () => Promise.reject(new Error('missing grammar'))} as Parameters<typeof createHighlighter>[0]);
  const errors: string[] = [];
  const original = console.error;
  console.error = (message: string) => errors.push(message);
  try {
    assert.deepEqual(await failing.version('key: value\n', 'ci.yml'), [[{text: 'key: value', color: null, changed: false}]]);
  } finally {
    console.error = original;
  }
  assert.match(errors.join('\n'), /ci\.yml as yaml failed.*missing grammar/);
});

test('highlight: only plain hex colors leave the highlighter', () => {
  assert.deepEqual(tokenColor('#24292e', '#E1E4E8'), {light: '#24292E', dark: '#E1E4E8'});
  assert.deepEqual(tokenColor('#758575DD', '#fff'), {light: '#758575DD', dark: '#FFF'});
  for (const bad of ['red', '#12', '#123456789', 'url(x)', '#fff;background:url(x)', 'var(--x)', '']) {
    assert.equal(tokenColor(bad, '#fff'), null, bad);
    assert.equal(tokenColor('#fff', bad), null, bad);
  }
  assert.equal(tokenColor(undefined, '#fff'), null);
});

test('highlight: one grammar pass gives the same colors as Shiki highlighting with both themes', async () => {
  const files = ['src/app/git.ts', 'scripts/check', 'README.md', 'src/web/index.html', 'package.json', 'src/web/styles.css', 'scripts/check.mts'];
  const samples = [
    ...files.map(file => ({file, name: file === 'scripts/check' ? 'check.sh' : file, text: readFileSync(path.join(root, file), 'utf8')})),
    {file: 'page with embedded CSS and script', name: 'page.html', text: EMBEDDED_LANGUAGES_PAGE},
  ];
  for (const {file, name, text} of samples) {
    const language = languageFor(name);
    const ours = await compiledHighlightVersion(text, name);
    const shiki = await codeToTokens(text, {lang: language, themes: {light: 'github-light', dark: 'github-dark'}, defaultColor: false});
    const reference = shiki.tokens.slice(0, ours.length).map(line => line.map(token => ({text: token.content, light: token.htmlStyle?.['--shiki-light'] ?? null, dark: token.htmlStyle?.['--shiki-dark'] ?? null})));
    const mine = ours.map(line => line.map(token => ({text: token.text, light: token.color?.light ?? null, dark: token.color?.dark ?? null})));
    assert.deepEqual(perCharacter(mine), perCharacter(reference), `${file} as ${language}`);
  }
});

test('highlight: themes whose rules differ are refused rather than paired wrongly', () => {
  const rule = (scope: string, foreground: string) => ({scope, settings: {foreground}});
  const light = {name: 'a', tokenColors: [rule('comment', '#111111'), rule('string', '#222222')]};
  const paired = pairThemes(light, {name: 'b', tokenColors: [rule('comment', '#333333'), rule('string', '#444444')]});
  assert.deepEqual([...paired.colors.values()].slice(1), [{light: '#111111', dark: '#333333'}, {light: '#222222', dark: '#444444'}]);
  assert.throws(() => pairThemes(light, {name: 'c', tokenColors: [rule('string', '#444444'), rule('comment', '#333333')]}), /do not share their rules/);
});

test('highlight-pair: both versions match separate highlighting, and an unchanged line after a change reuses the new tokens', async () => {
  const {version, pair} = createHighlighter();
  const lines = Array.from({length: 20}, (_, index) => `export const value${index + 1} = ${index + 1}; // note`);
  const edited = lines.map((line, index) => index === 9 ? 'export const value10 = "ten";' : line);
  const [oldText, newText] = [lines, edited].map(rows => rows.join('\n') + '\n');
  const shared = [{oldStart: 1, newStart: 1, length: 9}, {oldStart: 11, newStart: 11, length: 10}];
  const [oldVersion, newVersion] = await pair(oldText, 'a.ts', newText, 'a.ts', shared);
  assert.deepEqual([oldVersion, newVersion], [await version(oldText, 'a.ts'), await version(newText, 'a.ts')]);
  assert.equal(oldVersion[14], newVersion[14], 'line 15 is the same token list in both versions');
});

test('highlight-pair: a change that opens a block comment re-colors the shared lines after it in the new version only', async () => {
  const {version, pair} = createHighlighter();
  const lines = ['const a = 1;', 'const b = 2;', 'const c = 3;', 'const d = 4; */', 'const e = 5;'];
  const edited = lines.map((line, index) => index === 1 ? '/* const b = 2;' : line);
  const [oldText, newText] = [lines, edited].map(rows => rows.join('\n') + '\n');
  const shared = [{oldStart: 1, newStart: 1, length: 1}, {oldStart: 3, newStart: 3, length: 3}];
  const [oldVersion, newVersion] = await pair(oldText, 'a.ts', newText, 'a.ts', shared);
  assert.deepEqual([oldVersion, newVersion], [await version(oldText, 'a.ts'), await version(newText, 'a.ts')]);
  assert.notDeepEqual(oldVersion[2], newVersion[2], 'line 3 is code in the old version and comment in the new one');
  assert.deepEqual(oldVersion[4], newVersion[4], 'after the comment closes, line 5 is the same code again');
});
