import type { GrammarState, HighlighterCore, ThemeRegistration } from 'shiki/core';
import { plainVersion, splitLines } from '../domain/diff.ts';
import type { SharedRun, Version } from '../domain/diff.ts';
import type { Token, TokenColor } from '../domain/types.ts';

// Each loader is a fixed import() so the packager keeps the file; tsc keeps import() because the module setting is NodeNext.
const LOADERS = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  make: () => import('shiki/langs/make.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
  cmake: () => import('shiki/langs/cmake.mjs'),
};

type Language = keyof typeof LOADERS;
type Loaders = Record<Language, () => Promise<unknown>>;

/**
 * A longer line comes back from Shiki as one plain token. Measured on one-line minified files of 50 KB to 1 MB: 0.9 s to
 * 2.3 s per diff without this cap, 55 ms to 70 ms with it.
 */
const LONG_LINE_CHARACTERS = 10_000;

/** Loaded when the highlighter starts; they cover the most common source files. The rest load on first use. */
const UP_FRONT: readonly Language[] = ['typescript', 'javascript', 'json', 'css', 'html', 'markdown', 'python', 'shellscript', 'go', 'rust'];

const BY_NAME: Readonly<Record<string, Language>> = {
  makefile: 'make', gnumakefile: 'make', dockerfile: 'dockerfile', 'cmakelists.txt': 'cmake',
  '.bashrc': 'shellscript', '.zshrc': 'shellscript', '.profile': 'shellscript', '.bash_profile': 'shellscript',
};

const BY_EXTENSION: Readonly<Record<string, Language>> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  json: 'json', jsonc: 'jsonc', css: 'css', scss: 'scss', html: 'html', htm: 'html', md: 'markdown', markdown: 'markdown',
  py: 'python', sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', go: 'go', rs: 'rust', yml: 'yaml', yaml: 'yaml',
  toml: 'toml', ini: 'ini', cfg: 'ini', sql: 'sql', swift: 'swift', java: 'java', rb: 'ruby', c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', hpp: 'cpp', xml: 'xml', diff: 'diff', patch: 'diff', mk: 'make',
};

/** The Shiki language for a file path: the whole base name first, then its last extension; anything else is plain text. */
export function languageFor(path: string): Language | 'text' {
  const name = (path.split('/').pop() ?? '').toLowerCase();
  if (Object.hasOwn(BY_NAME, name)) return BY_NAME[name];
  if (name.startsWith('dockerfile.')) return 'dockerfile';
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1) : '';
  return Object.hasOwn(BY_EXTENSION, extension) ? BY_EXTENSION[extension] : 'text';
}

const COLOR = /^#[0-9a-fA-F]{3,8}$/;
const PAIRED = 'diff-viewer-github-pair';

/** Both theme colors, or null when either is missing or is not a plain hex color. */
export function tokenColor(light: string | undefined, dark: string | undefined): TokenColor | null {
  return light !== undefined && dark !== undefined && COLOR.test(light) && COLOR.test(dark) ? { light: light.toUpperCase(), dark: dark.toUpperCase() } : null;
}

/**
 * github-light and github-dark have the same rules in the same order and differ only in colors. One theme with a stand-in
 * color per rule therefore needs one grammar pass per file instead of one per theme, and each stand-in maps back to the
 * rule's light and dark colors. Throws if the two themes stop matching rule for rule.
 */
export function pairThemes(light: ThemeRegistration, dark: ThemeRegistration): { theme: ThemeRegistration; colors: ReadonlyMap<string, TokenColor | null> } {
  const shape = (theme: ThemeRegistration) => JSON.stringify(theme.tokenColors?.map(rule => [rule.scope, Object.keys(rule.settings).sort()]));
  if (!light.tokenColors || shape(light) !== shape(dark)) throw new Error(`Themes ${light.name} and ${dark.name} do not share their rules.`);
  const darkRules = dark.tokenColors ?? [];
  const colors = new Map<string, TokenColor | null>();
  const standIn = (lightColor: string | undefined, darkColor: string | undefined) => {
    const color = `#${(colors.size + 1).toString(16).padStart(6, '0').toUpperCase()}`;
    colors.set(color, tokenColor(lightColor, darkColor));
    return color;
  };
  const foreground = standIn(light.colors?.['editor.foreground'], dark.colors?.['editor.foreground']);
  const tokenColors = light.tokenColors.map((rule, index) => rule.settings.foreground === undefined ? rule
    : { ...rule, settings: { ...rule.settings, foreground: standIn(rule.settings.foreground, darkRules[index].settings.foreground) } });
  return { theme: { ...light, name: PAIRED, type: 'light', colors: { ...light.colors, 'editor.foreground': foreground }, tokenColors }, colors };
}

export interface Highlighter {
  /** One whole file version; a version that cannot be highlighted comes back as plain text. */
  version(text: string, path: string): Promise<Version>;
  /**
   * Both versions of a changed file. The new version is tokenized once. An unchanged run of the old version reuses the new
   * version's tokens when the grammar state before the run is equal in both, the same test editors use to skip re-tokenizing,
   * so the old version costs only its changed lines plus any run a change re-colors.
   */
  pair(oldText: string, oldPath: string, newText: string, newPath: string, shared: readonly SharedRun[]): Promise<[Version, Version]>;
  tryLoadLanguages(...paths: readonly string[]): Promise<void>;
}

export interface PairJob {
  readonly id: number;
  readonly oldText: string;
  readonly oldPath: string;
  readonly newText: string;
  readonly newPath: string;
  readonly shared: readonly SharedRun[];
}

export interface PackedVersions {
  readonly text: string;
  readonly lengths: Uint32Array<ArrayBuffer>;
  readonly paletteNumbers: Uint16Array<ArrayBuffer>;
  readonly tokensPerLine: Uint32Array<ArrayBuffer>;
  readonly oldLineCount: number;
  readonly palette: readonly TokenColor[];
}

export type WorkerNote = { readonly id: number; readonly kind: 'running' } | { readonly id: number; readonly kind: 'done'; readonly packed: PackedVersions };

const NO_COLOR = 0;

export function packVersions([oldVersion, newVersion]: readonly [Version, Version]): PackedVersions {
  const lines = [...oldVersion, ...newVersion];
  const tokenCount = lines.reduce((total, line) => total + line.length, 0);
  const lengths = new Uint32Array(tokenCount), paletteNumbers = new Uint16Array(tokenCount), texts: string[] = [];
  const palette: TokenColor[] = [], colorIds = new Map<TokenColor, number>();
  let index = 0;
  for (const line of lines) {
    for (const { text, color } of line) {
      let number = NO_COLOR;
      if (color) {
        number = colorIds.get(color) ?? palette.push(color);
        colorIds.set(color, number);
      }
      lengths[index] = text.length;
      paletteNumbers[index++] = number;
      texts.push(text);
    }
  }
  return { text: texts.join(''), lengths, paletteNumbers, tokensPerLine: Uint32Array.from(lines, line => line.length), oldLineCount: oldVersion.length, palette };
}

export function unpackVersions({ text, lengths, paletteNumbers, tokensPerLine, oldLineCount, palette }: PackedVersions): [Version, Version] {
  const lines: Token[][] = [];
  let index = 0, offset = 0;
  for (const tokenCount of tokensPerLine) {
    const line: Token[] = [];
    for (const end = index + tokenCount; index < end; index++) {
      const number = paletteNumbers[index];
      line.push({ text: text.slice(offset, offset += lengths[index]), color: number === NO_COLOR ? null : palette[number - 1], changed: false });
    }
    lines.push(line);
  }
  return [lines.slice(0, oldLineCount), lines.slice(oldLineCount)];
}

/** Lines tokenized from a grammar state, and the state after the last of them. */
interface Segment {
  readonly lines: Version;
  readonly after: GrammarState | undefined;
}

const append = (target: (readonly Token[])[], lines: Version) => { for (const line of lines) target.push(line); };

/** Both undefined means both start at the grammar's initial state. */
const sameState = (a: GrammarState | undefined, b: GrammarState | undefined) => {
  const [left, right] = [a?.getInternalStack(PAIRED), b?.getInternalStack(PAIRED)];
  return a === b || (left !== undefined && right !== undefined && left.equals(right));
};

/** Highlights file versions with one Shiki instance. */
export function createHighlighter(loaders: Loaders = LOADERS): Highlighter {
  let core: Promise<{ highlighter: HighlighterCore; colors: ReadonlyMap<string, TokenColor | null> }> | undefined;
  const loading = new Map<Language, Promise<void>>();
  const start = async () => {
    const [{ createHighlighterCore }, { createOnigurumaEngine }, light, dark] = await Promise.all([
      import('shiki/core'), import('shiki/engine/oniguruma'), import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs'),
    ]);
    const { theme, colors } = pairThemes(light.default, dark.default);
    const highlighter = await createHighlighterCore({
      themes: [theme],
      // `as never`: Loaders returns Promise<unknown> so a test can pass its own loaders; each real one is a Shiki grammar module.
      langs: UP_FRONT.map(language => loaders[language]() as never),
      engine: createOnigurumaEngine(import('shiki/wasm')),
    });
    return { highlighter, colors };
  };
  /** Returns a tokenizer for the language: lines in, tokens and the grammar state after them out. */
  const ready = async (language: Language) => {
    const { highlighter, colors } = await (core ??= start());
    if (!highlighter.getLoadedLanguages().includes(language)) {
      if (!loading.has(language)) loading.set(language, highlighter.loadLanguage(loaders[language]() as never));
      await loading.get(language);
    }
    return (lines: readonly string[], before: GrammarState | undefined): Segment => {
      if (!lines.length) return { lines: [], after: before };
      const { tokens, grammarState } = highlighter.codeToTokens(lines.join('\n'), { lang: language, theme: PAIRED, grammarState: before, tokenizeMaxLineLength: LONG_LINE_CHARACTERS });
      // Any difference in line count means the tokens no longer align with git's lines.
      if (tokens.length !== lines.length) throw new Error(`Shiki returned ${tokens.length} lines for ${lines.length}.`);
      return {
        lines: tokens.map(line => line.filter(token => token.content !== '').map(token => ({ text: token.content, color: colors.get(token.color?.toUpperCase() ?? '') ?? null, changed: false }))),
        after: grammarState,
      };
    };
  };
  const orPlain = async <T>(path: string, language: Language, work: () => Promise<T>, plain: () => T): Promise<T> => {
    try { return await work(); }
    catch (error) {
      console.error(`Highlighting ${path} as ${language} failed, shown as plain text: ${error instanceof Error ? error.message : String(error)}`);
      return plain();
    }
  };
  const version = async (text: string, path: string): Promise<Version> => {
    const language = languageFor(path);
    if (language === 'text' || text === '') return plainVersion(text);
    return orPlain(path, language, async () => (await ready(language))(splitLines(text), undefined).lines, () => plainVersion(text));
  };
  const pair = async (oldText: string, oldPath: string, newText: string, newPath: string, shared: readonly SharedRun[]): Promise<[Version, Version]> => {
    const language = languageFor(newPath);
    if (language === 'text' || language !== languageFor(oldPath)) return [await version(oldText, oldPath), await version(newText, newPath)];
    return orPlain(newPath, language, async () => {
      const tokenize = await ready(language);
      const oldLines = splitLines(oldText), newLines = splitLines(newText);
      const newVersion: (readonly Token[])[] = [], known: { before: GrammarState | undefined; run: Segment }[] = [];
      let state: GrammarState | undefined, next = 0;
      for (const run of shared) {
        const gap = tokenize(newLines.slice(next, run.newStart - 1), state);
        const inside = tokenize(newLines.slice(run.newStart - 1, run.newStart - 1 + run.length), gap.after);
        append(newVersion, gap.lines);
        append(newVersion, inside.lines);
        known.push({ before: gap.after, run: inside });
        state = inside.after;
        next = run.newStart - 1 + run.length;
      }
      append(newVersion, tokenize(newLines.slice(next), state).lines);
      const oldVersion: (readonly Token[])[] = [];
      state = undefined;
      next = 0;
      shared.forEach((run, index) => {
        const gap = tokenize(oldLines.slice(next, run.oldStart - 1), state);
        const inside = sameState(gap.after, known[index].before) ? known[index].run : tokenize(oldLines.slice(run.oldStart - 1, run.oldStart - 1 + run.length), gap.after);
        append(oldVersion, gap.lines);
        append(oldVersion, inside.lines);
        state = inside.after;
        next = run.oldStart - 1 + run.length;
      });
      append(oldVersion, tokenize(oldLines.slice(next), state).lines);
      return [oldVersion, newVersion];
    }, () => [plainVersion(oldText), plainVersion(newText)]);
  };
  const tryLoadLanguages = async (...paths: readonly string[]): Promise<void> => {
    for (const path of paths) {
      const language = languageFor(path);
      if (language !== 'text') await ready(language).catch(() => undefined);
    }
  };
  return { version, pair, tryLoadLanguages };
}
