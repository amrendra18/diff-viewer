import { Worker } from 'node:worker_threads';
import { plainVersion } from '../domain/diff.ts';
import type { SharedRun, Version } from '../domain/diff.ts';
import { languageFor, unpackVersions } from './highlight.ts';
import type { PairJob, WorkerNote } from './highlight.ts';

const GRAMMAR_WORK_LIMIT_MS = 2_000;
const LOAD_LIMIT_MS = 30_000;
/** This file is `.mts` so it has import.meta in both forms: run from `src/` by Node in the tests, and compiled in `dist/` and the packaged app. */
export const WORKER_FILE = new URL(import.meta.url.endsWith('.mts') ? './highlight-worker.ts' : './highlight-worker.js', import.meta.url);

type Pair = [Version, Version];
export interface WorkerOptions { readonly workerFile?: URL; readonly grammarWorkLimitMs?: number; readonly loadLimitMs?: number }

export function createPairHighlighter({ workerFile = WORKER_FILE, grammarWorkLimitMs = GRAMMAR_WORK_LIMIT_MS, loadLimitMs = LOAD_LIMIT_MS }: WorkerOptions = {}) {
  const queue: { job: PairJob; finish: (versions: Pair) => void }[] = [];
  let active: (typeof queue)[number] | null = null;
  let worker: Worker | null = null;
  let limit: NodeJS.Timeout | undefined;
  let lastId = 0;

  const settle = (versions: Pair) => {
    clearTimeout(limit);
    const finished = active;
    active = null;
    finished?.finish(versions);
    startNext();
  };
  const giveUp = (reason: string) => {
    const stale = worker;
    worker = null;
    void stale?.terminate();
    if (!active) return;
    const { newPath, oldText, newText } = active.job;
    console.error(`Highlighting ${newPath} as ${languageFor(newPath)} failed, shown as plain text: ${reason}`);
    settle([plainVersion(oldText), plainVersion(newText)]);
  };
  const holdProcessForLimit = (ms: number, reason: string) => {
    clearTimeout(limit);
    limit = setTimeout(() => giveUp(reason), ms);
  };
  const startWorker = () => {
    const fresh = new Worker(workerFile);
    const isCurrent = () => fresh === worker;
    fresh.on('message', (note: WorkerNote) => {
      if (!isCurrent() || note.id !== active?.job.id) return;
      if (note.kind === 'running') holdProcessForLimit(grammarWorkLimitMs, `it took over ${grammarWorkLimitMs} ms`);
      else settle(unpackVersions(note.packed));
    });
    fresh.on('error', (error: unknown) => { if (isCurrent()) giveUp(`the worker failed: ${error instanceof Error ? error.message : String(error)}`); });
    fresh.on('exit', code => { if (isCurrent()) giveUp(`the worker stopped with exit code ${code}`); });
    // After the listeners, because adding a message listener references the worker again.
    fresh.unref();
    return fresh;
  };
  function startNext() {
    active = queue.shift() ?? null;
    if (!active) return;
    holdProcessForLimit(loadLimitMs, `the worker did not start it within ${loadLimitMs} ms`);
    try { (worker ??= startWorker()).postMessage(active.job); }
    catch (error) { giveUp(`the worker could not start: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return (oldText: string, oldPath: string, newText: string, newPath: string, shared: readonly SharedRun[]): Promise<Pair> => {
    if (languageFor(oldPath) === 'text' && languageFor(newPath) === 'text') return Promise.resolve([plainVersion(oldText), plainVersion(newText)]);
    return new Promise(finish => {
      queue.push({ job: { id: ++lastId, oldText, oldPath, newText, newPath, shared }, finish });
      if (!active) startNext();
    });
  };
}

export const highlightPair = createPairHighlighter();
