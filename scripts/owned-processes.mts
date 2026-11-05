import {spawnSync} from 'node:child_process';

/** Adds every live descendant of an owned process to the owned set, so cleanup can account for helpers too. */
export function sampleOwnedDescendants(owned: Set<number>): void {
  const result = spawnSync('/bin/ps', ['-ax', '-o', 'pid=', '-o', 'ppid='], {encoding: 'utf8'});
  if (result.status !== 0) throw new Error(`Process listing failed: ${result.error?.message || result.stderr.trim() || String(result.status)}`);
  const rows = result.stdout.trim().split('\n').map(line => {
    const [pid, parent] = line.trim().split(/\s+/).map(Number);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(parent) || parent < 0) throw new Error('Process listing returned an invalid row.');
    return {pid, parent};
  });
  let changed = true;
  while (changed) {
    changed = false;
    for (const {pid, parent} of rows) if (owned.has(parent) && !owned.has(pid)) { owned.add(pid); changed = true; }
  }
}

export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw new Error(`Cannot tell whether owned process ${pid} ended: ${String(error)}`, {cause: error});
  }
}
