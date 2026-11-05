import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';

const css = readFileSync(path.resolve(import.meta.dirname, '../src/web/styles.css'), 'utf8');

/** The color tokens of the first `:root{...}` after `start`: the light block, or the dark block inside the media query. */
function tokens(start: number): Map<string, string> {
  const open = css.indexOf(':root{', start);
  const body = css.slice(open, css.indexOf('}', open));
  const full = (color: string) => color.length === 4 ? `#${[...color.slice(1)].map(digit => digit + digit).join('')}` : color;
  return new Map([...body.matchAll(/--([a-z-]+):(#[0-9a-f]{6}|#[0-9a-f]{3})(?=[;\s])/gi)].map(([, name, color]) => [name, full(color.toLowerCase())]));
}

/** The token a rule's `color` uses, read from the rule's own text. */
function colorToken(selector: string): string {
  const rule = css.split('\n').find(line => line.startsWith(`${selector}{`));
  const match = rule && /[{;]color:var\(--([a-z-]+)\)/.exec(rule);
  assert.ok(match, `${selector} sets its color from a token`);
  return match[1];
}

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => { const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (high + 0.05) / (low + 0.05); };

test('contrast: line numbers and hidden-line ranges reach 4.5:1 on every background they sit on, light and dark', () => {
  const themes = {light: tokens(0), dark: tokens(css.indexOf('@media (prefers-color-scheme:dark)'))};
  // td.ln sits on the plain, removed, and added number cells; the range sits on the gap row and its hover color.
  const uses = [['td.ln', ['surface', 'del-ln', 'add-ln']], ['tr.gap .range', ['pale', 'hover']]] as const;
  const low: string[] = [];
  for (const [theme, colors] of Object.entries(themes)) {
    for (const [selector, backgrounds] of uses) {
      const ink = colors.get(colorToken(selector))!;
      for (const background of backgrounds) {
        const value = ratio(ink, colors.get(background)!);
        if (value < 4.5) low.push(`${theme} ${selector} on --${background}: ${value.toFixed(2)}:1`);
      }
    }
  }
  assert.deepEqual(low, []);
});
