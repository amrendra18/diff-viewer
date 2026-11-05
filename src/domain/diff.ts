import type { ContextRow, DiffRow, Line, Token } from './types.ts';
import { markChangedWords } from './words.ts';

/** One file version as the tokens of each line, in the same order and count as splitLines gives. */
export type Version = readonly (readonly Token[])[];

interface Hunk {
  readonly oldStart: number;
  readonly newStart: number;
  readonly body: readonly string[];
}

/**
 * Splits file text into lines the way git counts them: a final newline does not start an extra line. A CRLF line loses
 * its carriage return, as Shiki drops it, so a row's text and its highlighted tokens agree.
 */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** A version with no highlighting: one uncolored token per non-empty line. */
export function plainVersion(text: string): Version {
  return splitLines(text).map(line => line === '' ? [] : [{ text: line, color: null, changed: false }]);
}

function parseHunks(diffText: string): Hunk[] {
  const hunks: Hunk[] = [];
  const lines = splitLines(diffText);
  for (let index = 0; index < lines.length; index++) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[index]);
    if (!header) continue;
    let oldLeft = Number(header[2] ?? 1), newLeft = Number(header[4] ?? 1);
    const body: string[] = [];
    while (oldLeft > 0 || newLeft > 0) {
      const text = lines[++index];
      if (text === undefined) throw new Error('The diff ends inside a hunk.');
      if (text.startsWith('\\')) continue;
      const kind = text[0] ?? ' ';
      if (kind !== '+') oldLeft--;
      if (kind !== '-') newLeft--;
      body.push(text);
    }
    // A hunk with a zero line count names the line before it, so the first line it covers is one later.
    hunks.push({
      oldStart: Number(header[1]) + (header[2] === '0' ? 1 : 0),
      newStart: Number(header[3]) + (header[4] === '0' ? 1 : 0),
      body,
    });
  }
  return hunks;
}

/** Lines both versions share: the first line in each version (1-based) and how many follow in step. */
export interface SharedRun {
  readonly oldStart: number;
  readonly newStart: number;
  readonly length: number;
}

/** The unchanged runs git's diff implies, in file order: the lines outside the hunks and the context lines inside them. */
export function sharedRuns(diffText: string, oldLength: number): SharedRun[] {
  const runs: SharedRun[] = [];
  let oldNext = 1, newNext = 1;
  const keep = (length: number) => {
    const last = runs.at(-1);
    if (length <= 0) return;
    if (last && last.oldStart + last.length === oldNext && last.newStart + last.length === newNext) runs[runs.length - 1] = { ...last, length: last.length + length };
    else runs.push({ oldStart: oldNext, newStart: newNext, length });
    oldNext += length;
    newNext += length;
  };
  for (const hunk of parseHunks(diffText)) {
    keep(hunk.oldStart - oldNext);
    for (const text of hunk.body) {
      if (text[0] === '-') oldNext++;
      else if (text[0] === '+') newNext++;
      else keep(1);
    }
  }
  keep(oldLength + 1 - oldNext);
  return runs;
}

/**
 * Builds side-by-side rows from git's unified diff of one file and both whole versions of that file, already highlighted.
 * Rows take their tokens from the versions, so highlighting reflects the whole file. Unchanged lines outside the hunks
 * become 'hidden' rows, so every line of both versions appears once. A change row with both sides gets changed-word marks.
 */
export function diffRows(diffText: string, oldVersion: Version, newVersion: Version): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNext = 1, newNext = 1;
  const line = (side: Version, number: number): Line => {
    if (number < 1 || number > side.length) throw new Error(`The diff names line ${number}, but the file version has ${side.length} lines.`);
    return { number, tokens: side[number - 1] };
  };
  const hide = (oldEnd: number, newEnd: number) => {
    if (oldEnd - oldNext !== newEnd - newNext) throw new Error('The diff does not match the file versions: unchanged runs differ in length.');
    const hidden: ContextRow[] = [];
    while (oldNext < oldEnd) hidden.push({ kind: 'context', left: line(oldVersion, oldNext++), right: line(newVersion, newNext++) });
    if (hidden.length) rows.push({ kind: 'hidden', rows: hidden });
  };
  for (const hunk of parseHunks(diffText)) {
    hide(hunk.oldStart, hunk.newStart);
    let removed: Line[] = [], added: Line[] = [];
    const pair = () => {
      for (let index = 0; index < Math.max(removed.length, added.length); index++) {
        const left = removed[index], right = added[index];
        rows.push(left && right ? { kind: 'change', ...markChangedWords(left, right) } : { kind: 'change', left: left ?? null, right: right ?? null });
      }
      removed = []; added = [];
    };
    for (const text of hunk.body) {
      if (text[0] === '-') removed.push(line(oldVersion, oldNext++));
      else if (text[0] === '+') added.push(line(newVersion, newNext++));
      else { pair(); rows.push({ kind: 'context', left: line(oldVersion, oldNext++), right: line(newVersion, newNext++) }); }
    }
    pair();
  }
  hide(oldVersion.length + 1, newVersion.length + 1);
  return rows;
}
