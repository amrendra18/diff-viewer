import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {Worker} from 'node:worker_threads';

import {bigModule, denseModule, SLOW_CPP_LINES} from '../scripts/fixtures.mts';
import {plainVersion} from '../src/domain/diff.ts';
import type {SharedRun, Version} from '../src/domain/diff.ts';
import {LARGE_FILE_BYTES} from '../src/domain/types.ts';
import {createHighlighter, packVersions, unpackVersions} from '../src/app/highlight.ts';
import type {WorkerNote} from '../src/app/highlight.ts';
import {createPairHighlighter, highlightPair, WORKER_FILE} from '../src/app/highlight-client.mts';

const HEX = /^#[0-9a-fA-F]{3,8}$/;
const EVIL = `${SLOW_CPP_LINES.join('\n')}\n`;
const ORDINARY = 'export const greeting: string = "hi";\n';
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const round = (ms: number) => Math.round(ms * 10) / 10;

const assertColored = (version: Version) => {
  const tokens = version.flat();
  assert.ok(tokens.length > 3, 'the grammar split the line into tokens');
  assert.ok(tokens.every(token => token.color && HEX.test(token.color.light) && HEX.test(token.color.dark)), 'every token holds plain hex colors');
};

async function logged<T>(work: () => Promise<T>): Promise<{result: T; errors: string[]}> {
  const errors: string[] = [], original = console.error;
  console.error = (message: string) => errors.push(message);
  try { return {result: await work(), errors}; }
  finally { console.error = original; }
}

const STAND_IN = new URL(`data:text/javascript,${encodeURIComponent(`
import {parentPort, threadId} from 'node:worker_threads';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
parentPort.on('message', async ({id, newPath}) => {
  if (newPath === 'exits.ts') process.exit(3);
  if (newPath === 'throws.ts') throw new Error('planted failure');
  if (newPath === 'never-starts.ts') return;
  if (newPath === 'slow-load.ts') await wait(400);
  parentPort.postMessage({id, kind: 'running'});
  if (newPath === 'stuck.ts') for (;;);
  if (newPath === 'slow.ts') await wait(150);
  const text = 'thread ' + threadId;
  parentPort.postMessage({id, kind: 'done', packed: {text, lengths: [text.length], paletteNumbers: [0], tokensPerLine: [1], oldLineCount: 0, palette: []}});
});`)}`);
const standIn = (limits: {grammarWorkLimitMs?: number; loadLimitMs?: number} = {}) => {
  const pair = createPairHighlighter({workerFile: STAND_IN, ...limits});
  return (file: string) => pair('old\n', file, 'new\n', file, []);
};
const PLAIN = [plainVersion('old\n'), plainVersion('new\n')];
const threadOf = (versions: [Version, Version]) => versions[1][0][0].text;

test('highlight-worker: packing gives back the same tokens, with one color object per color', () => {
  const blue = {light: '#0000FF', dark: '#00FFFF'}, red = {light: '#FF0000', dark: '#FF00FF'};
  const token = (text: string, color: {light: string; dark: string} | null) => ({text, color, changed: false});
  const versions: [Version, Version] = [
    [[token('const', blue), token(' x', null)], [], [token('é😀', red)]],
    [[], [token('const', blue), token('', null), token(' y', red)]],
  ];
  const unpacked = unpackVersions(packVersions(versions));
  assert.deepEqual(unpacked, versions);
  assert.equal(unpacked[0][0][0].color, unpacked[1][1][0].color, 'one color object is shared across both versions');
  assert.deepEqual(unpackVersions(packVersions([[], []])), [[], []]);
});

test('highlight-worker: a slow C++ file comes back as plain text in under 3,000 ms while a main-thread timer keeps ticking', async () => {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 100);
  const started = performance.now();
  const {result, errors} = await logged(() => highlightPair('', 'evil.cpp', EVIL, 'evil.cpp', []));
  const ms = performance.now() - started;
  clearInterval(timer);
  assert.deepEqual(result, [plainVersion(''), plainVersion(EVIL)]);
  assert.ok(ms < 3000, `returned in ${Math.round(ms)} ms, limit 3,000 ms`);
  assert.ok(ticks >= 15, `the main-thread timer ticked ${ticks} times, at least 15 expected`);
  assert.deepEqual(errors, ['Highlighting evil.cpp as cpp failed, shown as plain text: it took over 2000 ms']);
});

test('highlight-worker: after that timeout an ordinary file gets colors, and only plain hex colors cross to main', async () => {
  const [, version] = await highlightPair('', 'after.ts', ORDINARY, 'after.ts', []);
  assertColored(version);
});

test('highlight-worker: terminate() really ends a job stuck inside one regular expression match', async () => {
  const worker = new Worker(WORKER_FILE);
  const notes: WorkerNote[] = [];
  const running = new Promise<void>(resolve => worker.on('message', (note: WorkerNote) => { notes.push(note); if (note.kind === 'running') resolve(); }));
  const exited = new Promise<number>(resolve => worker.on('exit', resolve));
  worker.postMessage({id: 1, oldText: '', oldPath: 'evil.cpp', newText: EVIL, newPath: 'evil.cpp', shared: []});
  await running;
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.deepEqual(notes, [{id: 1, kind: 'running'}], 'after 1 s the job is still inside its match');
  const started = performance.now();
  await worker.terminate();
  const ms = performance.now() - started;
  assert.equal(await exited, 1, 'the thread ended as a terminated thread');
  assert.ok(ms < 1000, `terminate() ended the thread in ${Math.round(ms)} ms`);
  assert.deepEqual(notes, [{id: 1, kind: 'running'}], 'the job never finished');
});

test('highlight-worker: jobs queued behind a job that times out still run, and queue time does not count against them', async () => {
  const highlight = standIn({grammarWorkLimitMs: 300});
  const before = threadOf(await highlight('first.ts'));
  const {result, errors} = await logged(() => Promise.all([highlight('stuck.ts'), highlight('slow.ts'), highlight('slow.ts'), highlight('slow.ts')]));
  assert.deepEqual(result[0], PLAIN, 'the job past its deadline shows as plain text');
  const after = result.slice(1).map(threadOf);
  assert.equal(new Set(after).size, 1, 'one fresh worker runs the queued jobs one at a time');
  assert.notEqual(after[0], before, 'the worker that held the stuck job is gone');
  assert.deepEqual(errors, ['Highlighting stuck.ts as typescript failed, shown as plain text: it took over 300 ms'], 'the third queued job waited about 600 ms and kept its colors path');
});

test('highlight-worker: a worker that exits or throws gives plain text, and the next job gets a fresh worker', async () => {
  for (const [file, reason] of [['exits.ts', 'the worker stopped with exit code 3'], ['throws.ts', 'the worker failed: planted failure']]) {
    const highlight = standIn();
    const before = threadOf(await highlight('first.ts'));
    const {result, errors} = await logged(() => highlight(file));
    assert.deepEqual(result, PLAIN, file);
    assert.deepEqual(errors, [`Highlighting ${file} as typescript failed, shown as plain text: ${reason}`]);
    assert.notEqual(threadOf(await highlight('after.ts')), before, `a fresh worker after ${file}`);
  }
});

test('highlight-worker: loading does not spend the deadline, and a load that never ends has its own limit', async () => {
  assert.notDeepEqual(await standIn({grammarWorkLimitMs: 200})('slow-load.ts'), PLAIN, 'a 400 ms load before `running` is fine with a 200 ms deadline');
  const highlight = standIn({loadLimitMs: 300});
  const {result, errors} = await logged(() => highlight('never-starts.ts'));
  assert.deepEqual(result, PLAIN);
  assert.deepEqual(errors, ['Highlighting never-starts.ts as typescript failed, shown as plain text: the worker did not start it within 300 ms']);
  assert.notDeepEqual(await highlight('after.ts'), PLAIN, 'the next job gets a fresh worker');
});

test('highlight-worker: a file with no grammar never starts a worker', async () => {
  const broken = createPairHighlighter({workerFile: new URL('file:///no/such/worker.js')});
  const {result, errors} = await logged(() => broken('old\n', 'notes.txt', 'new\n', 'notes.txt', []));
  assert.deepEqual(result, PLAIN);
  assert.deepEqual(errors, []);
});

test('highlight-worker: a worker file that does not load gives plain text', async () => {
  const broken = createPairHighlighter({workerFile: new URL('file:///no/such/worker.js')});
  const {result, errors} = await logged(() => broken('old\n', 'a.ts', 'new\n', 'a.ts', []));
  assert.deepEqual(result, PLAIN);
  assert.match(errors.join('\n'), /^Highlighting a\.ts as typescript failed, shown as plain text: the worker failed: /);
});

test('highlight-worker: the compiled client finds its compiled worker', async () => {
  const compiled = createRequire(import.meta.url)('../dist/src/app/highlight-client.mjs') as typeof import('../src/app/highlight-client.mts');
  assert.match(compiled.WORKER_FILE.pathname, /\/dist\/src\/app\/highlight-worker\.js$/);
  const [, version] = await compiled.highlightPair('', 'compiled.ts', ORDINARY, 'compiled.ts', []);
  assertColored(version);
});

function sharedRunsOf(oldText: string, newText: string): SharedRun[] {
  const oldLines = oldText.split('\n'), newLines = newText.split('\n'), runs: SharedRun[] = [];
  for (let index = 0; index < newLines.length - 1; index++) {
    if (oldLines[index] !== newLines[index]) continue;
    const last = runs.at(-1);
    if (last && last.oldStart + last.length === index + 1) runs[runs.length - 1] = {...last, length: last.length + 1};
    else runs.push({oldStart: index + 1, newStart: index + 1, length: 1});
  }
  return runs;
}

test('highlight-worker: measures an ordinary 5,000-line TypeScript file through the worker against in-process highlighting', async t => {
  const oldText = bigModule(false), newText = bigModule(true), shared = sharedRunsOf(oldText, newText), file = 'src/big.ts';
  const pairs = {
    'in process': createHighlighter().pair,
    'through the worker': createPairHighlighter(),
  };
  const report: Record<string, unknown> = {};
  let baseline: [Version, Version] | undefined;
  for (const [name, pair] of Object.entries(pairs)) {
    const samples: number[] = [];
    for (let sample = 0; sample < 6; sample++) {
      const started = performance.now();
      const versions = await pair(oldText, file, newText, file, shared);
      samples.push(performance.now() - started);
      baseline ??= versions;
      assert.deepEqual(versions, baseline, `${name} gives the same tokens`);
    }
    report[name] = {firstMs: round(samples[0]), medianMs: round(median(samples.slice(1))), samplesMs: samples.map(round)};
  }
  t.diagnostic(`big file ${JSON.stringify(report)}`);
  const startedCold = performance.now();
  const dense = denseModule(false, LARGE_FILE_BYTES);
  const [, denseVersion] = await createPairHighlighter()('', 'dense.ts', dense, 'dense.ts', []);
  t.diagnostic(`densest allowed file on a cold worker: ${round(performance.now() - startedCold)} ms`);
  assert.ok(denseVersion.flat().some(token => token.color), 'the densest allowed file keeps its colors on a cold worker');
});
