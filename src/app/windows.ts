import type { RepoPath } from '../domain/types.ts';

/** Where a repository chosen in one window opens: each repository has one window. */
export type OpenPlan =
  | { readonly kind: 'here' }
  | { readonly kind: 'focus'; readonly window: number }
  | { readonly kind: 'new' };

/**
 * `shown` maps each open window to the repository it shows, or null for a window with none (the first-run or error screen).
 * A repository already open focuses its window; otherwise an empty calling window takes it, and a busy one opens a new window.
 */
export function planOpen(shown: ReadonlyMap<number, RepoPath | null>, caller: number, path: RepoPath): OpenPlan {
  for (const [window, repository] of shown) {
    if (repository === path) return window === caller ? { kind: 'here' } : { kind: 'focus', window };
  }
  const callerShows = shown.get(caller) ?? null;
  return callerShows === null ? { kind: 'here' } : { kind: 'new' };
}
