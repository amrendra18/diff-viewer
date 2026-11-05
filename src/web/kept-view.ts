/** What a refresh keeps of the open file. */
export interface KeptView {
  readonly path: string;
  readonly scrollTop: number;
  readonly showLarge: boolean;
}

/**
 * The open file stays open across a refresh. Its scroll position and "Show anyway" belong to the diff on screen, so they are
 * kept only when that diff is the open file's: a refresh that lands between a file click and its answer starts the clicked
 * file at the top, collapsed.
 */
export function keptView(open: string | null, onScreen: { readonly path: string; readonly showLarge: boolean } | null, scrollTop: number): KeptView | null {
  if (open === null) return null;
  return onScreen?.path === open ? { path: open, scrollTop, showLarge: onScreen.showLarge } : { path: open, scrollTop: 0, showLarge: false };
}
