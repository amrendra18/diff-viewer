import {spawnSync} from 'node:child_process';

/** The display name in `lsappinfo info -only name` output, such as `"LSDisplayName"="Terminal"`. Null when there is none. */
export function displayName(info: string): string | null {
  return /"LSDisplayName"="([^"]*)"/.exec(info)?.[1] ?? null;
}

/** The name macOS gives the frontmost app, from `lsappinfo`. Null when lsappinfo gives no name. */
export function frontAppName(): string | null {
  const front = spawnSync('lsappinfo', ['front'], {encoding: 'utf8'});
  if (front.status !== 0 || !front.stdout.trim()) return null;
  return displayName(spawnSync('lsappinfo', ['info', '-only', 'name', front.stdout.trim()], {encoding: 'utf8'}).stdout);
}

/**
 * A locked screen puts loginwindow in front. Windows then get no focus and paint late, so journeys and timings fail for a
 * reason that has nothing to do with the app.
 */
export function screenCheck(front: string | null): {ok: boolean; detail: string} {
  if (front === 'loginwindow') return {ok: false, detail: 'the screen is locked (lsappinfo front names loginwindow). Unlock the Mac and run again.'};
  return {ok: true, detail: front === null ? 'lsappinfo named no front app; going ahead.' : `front app: ${front}`};
}

/** A failed journey, read with the front app at the time it failed: a locked screen is not the app's failure. */
export function journeyFailure(reason: string, front: string | null): {locked: boolean; reason: string} {
  if (front === 'loginwindow') return {locked: true, reason: `the screen locked during the run (lsappinfo front names loginwindow); the journey's own error was: ${reason}`};
  return {locked: false, reason};
}
