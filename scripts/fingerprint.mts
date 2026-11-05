import {createHash} from 'node:crypto';
import {lstatSync, readdirSync, readFileSync, readlinkSync} from 'node:fs';
import path from 'node:path';

/**
 * sha256 over every entry under `folder`, .git included: each path with its type and permission bits, and a file's content
 * or a link's target. Folders count too, so an empty one changes it. File times are not part of it.
 */
export function fingerprint(folder: string): string {
  const entries: string[][] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort((a, b) => a.localeCompare(b))) {
      const full = path.join(dir, name);
      const stat = lstatSync(full);
      const mode = (stat.mode & 0o7777).toString(8);
      const where = path.relative(folder, full);
      if (stat.isSymbolicLink()) entries.push([where, 'link', mode, readlinkSync(full)]);
      else if (stat.isDirectory()) { entries.push([where, 'folder', mode]); walk(full); }
      else if (stat.isFile()) entries.push([where, 'file', mode, createHash('sha256').update(readFileSync(full)).digest('hex')]);
      else entries.push([where, 'other', mode]);
    }
  };
  walk(folder);
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}
