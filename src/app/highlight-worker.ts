import { parentPort } from 'node:worker_threads';
import { createHighlighter, packVersions } from './highlight.ts';
import type { PairJob, WorkerNote } from './highlight.ts';

const port = parentPort;
if (!port) throw new Error('highlight-worker runs only as a worker thread.');
const highlighter = createHighlighter();

port.on('message', async ({ id, oldText, oldPath, newText, newPath, shared }: PairJob) => {
  await highlighter.tryLoadLanguages(oldPath, newPath);
  port.postMessage({ id, kind: 'running' } satisfies WorkerNote);
  const packed = packVersions(await highlighter.pair(oldText, oldPath, newText, newPath, shared));
  port.postMessage({ id, kind: 'done', packed } satisfies WorkerNote, [packed.lengths.buffer, packed.paletteNumbers.buffer, packed.tokensPerLine.buffer]);
});
