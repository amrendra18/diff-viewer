import {spawnSync} from 'node:child_process';
import {cpSync, rmSync} from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

export function build(): void {
  rmSync(path.join(root, 'dist'), {recursive: true, force: true});
  for (const config of ['tsconfig.json', 'tsconfig.web.json']) {
    const result = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(root, config), '--pretty', 'false'], {cwd: root, stdio: 'inherit'});
    if (result.status !== 0) throw new Error(`TypeScript failed for ${config} with exit ${result.status ?? 'none'}.`);
  }
  for (const name of ['index.html', 'styles.css']) cpSync(path.join(root, 'src/web', name), path.join(root, 'dist/src/web', name));
  cpSync(path.join(root, 'src/domain/source-argument.mjs'), path.join(root, 'dist/src/domain/source-argument.mjs'));
}

if (import.meta.main) {
  try { build(); console.log('Built main, preload, and page into dist/.'); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
}
