import type { Line, Token } from './types.ts';

/** Lines longer than this, on either side, get no word marks. */
const WORD_MARK_MAX_CHARS = 2000;

/**
 * Below this share of common non-whitespace characters, a pair with more than one mark on a side gets no word marks.
 * Set by reading 4,207 real line pairs from the histories of two projects (TypeScript, Python, and shell).
 */
const WORD_MARK_MIN_SHARE = 0.4;

interface Word {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

const WORD = /[\p{L}\p{M}\p{N}_]+|\s+|[^\p{L}\p{M}\p{N}_\s]/gu;
const SPACE = /^\s+$/u;

/** Marks the words that differ between a removed line and the added line paired with it. */
export function markChangedWords(left: Line, right: Line): { left: Line; right: Line } {
  const leftText = joined(left);
  const rightText = joined(right);
  const leftMask = new Uint8Array(leftText.length);
  const rightMask = new Uint8Array(rightText.length);

  if (leftText.length <= WORD_MARK_MAX_CHARS && rightText.length <= WORD_MARK_MAX_CHARS) {
    const a = words(leftText);
    const b = words(rightText);
    const common = commonWords(a, b);
    markWords(a, common.map(([i]) => i), leftMask);
    markWords(b, common.map(([, j]) => j), rightMask);
    const shared = share(a, b, common);
    // One mark per side is never confetti, so it stays unless the lines share nothing.
    const readable = shared >= WORD_MARK_MIN_SHARE || (shared > 0 && marks(leftMask) <= 1 && marks(rightMask) <= 1);
    if (!readable) {
      leftMask.fill(0);
      rightMask.fill(0);
    }
  }

  return { left: applyMask(left, leftMask), right: applyMask(right, rightMask) };
}

function joined(line: Line): string {
  return line.tokens.map((token) => token.text).join('');
}

function words(text: string): Word[] {
  return Array.from(text.matchAll(WORD), (m) => ({ text: m[0], start: m.index, end: m.index + m[0].length }));
}

/** Index pairs [i, j] of a longest common subsequence of the two word lists, in order. */
function commonWords(a: readonly Word[], b: readonly Word[]): Array<[number, number]> {
  let head = 0;
  while (head < a.length && head < b.length && a[head].text === b[head].text) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail].text === b[b.length - 1 - tail].text) tail++;

  const n = a.length - head - tail;
  const m = b.length - head - tail;
  // lengths[i * (m + 1) + j] is the common length of a[head + i ..] and b[head + j ..] within the middle.
  const lengths = new Uint16Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i * (m + 1) + j] =
        a[head + i].text === b[head + j].text
          ? lengths[(i + 1) * (m + 1) + j + 1] + 1
          : Math.max(lengths[(i + 1) * (m + 1) + j], lengths[i * (m + 1) + j + 1]);
    }
  }

  const pairs: Array<[number, number]> = [];
  for (let k = 0; k < head; k++) pairs.push([k, k]);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[head + i].text === b[head + j].text) {
      pairs.push([head + i, head + j]);
      i++;
      j++;
    } else if (lengths[(i + 1) * (m + 1) + j] >= lengths[i * (m + 1) + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  for (let k = tail; k > 0; k--) pairs.push([a.length - k, b.length - k]);
  return pairs;
}

/** Common non-whitespace characters over the longer side's non-whitespace characters. */
function share(a: readonly Word[], b: readonly Word[], common: ReadonlyArray<[number, number]>): number {
  const visible = (list: readonly Word[]) => list.reduce((sum, w) => sum + (SPACE.test(w.text) ? 0 : w.text.length), 0);
  const total = Math.max(visible(a), visible(b));
  if (total === 0) return 1;
  const kept = common.reduce((sum, [i]) => sum + (SPACE.test(a[i].text) ? 0 : a[i].text.length), 0);
  return kept / total;
}

function markWords(list: readonly Word[], keptIndexes: readonly number[], mask: Uint8Array): void {
  const kept = new Set(keptIndexes);
  const changed = list.map((_, i) => !kept.has(i));
  // A space between two changed words joins them into one mark instead of two.
  for (let i = 1; i < list.length - 1; i++) {
    if (!changed[i] && SPACE.test(list[i].text) && changed[i - 1] && changed[i + 1]) changed[i] = true;
  }
  list.forEach((w, i) => {
    if (changed[i]) mask.fill(1, w.start, w.end);
  });
}

function marks(mask: Uint8Array): number {
  let count = 0;
  for (let k = 0; k < mask.length; k++) if (mask[k] === 1 && (k === 0 || mask[k - 1] === 0)) count++;
  return count;
}

function applyMask(line: Line, mask: Uint8Array): Line {
  const tokens: Token[] = [];
  let offset = 0;
  for (const token of line.tokens) {
    const end = offset + token.text.length;
    let start = offset;
    for (let k = offset + 1; k <= end; k++) {
      if (k === end || mask[k] !== mask[start]) {
        tokens.push({ text: token.text.slice(start - offset, k - offset), color: token.color, changed: mask[start] === 1 });
        start = k;
      }
    }
    if (token.text.length === 0) tokens.push({ text: '', color: token.color, changed: false });
    offset = end;
  }
  return { number: line.number, tokens };
}
