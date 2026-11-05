import {packager} from '@electron/packager';
import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {build} from './build.mts';

const root = path.resolve(import.meta.dirname, '..');
export const BUNDLE = path.join(root, '.local/build/diff-viewer.app');
export const BUNDLE_EXECUTABLE = path.join(BUNDLE, 'Contents/MacOS/diff-viewer');
const cache = path.join(root, '.local/electron-cache');

function findZip(folder: string, name: string): string | null {
  if (!existsSync(folder)) return null;
  for (const entry of readdirSync(folder, {withFileTypes: true})) {
    const full = path.join(folder, entry.name);
    if (entry.isFile() && entry.name === name) return folder;
    if (entry.isDirectory()) { const found = findZip(full, name); if (found) return found; }
  }
  return null;
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, {stdio: 'inherit'});
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status ?? 'none'}.`);
}

export async function packageApp(): Promise<string> {
  const version: string = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const gitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], {encoding: 'utf8', env: gitEnvironment}).trim();
  const identity = {version, revision: git(['rev-parse', 'HEAD']), modified: git(['status', '--porcelain']).length > 0};
  build();
  const electronVersion: string = JSON.parse(readFileSync(path.join(root, 'node_modules/electron/package.json'), 'utf8')).version;
  // The Electron install step already downloaded and checked this zip; reusing it keeps packaging offline.
  const zipDir = findZip(cache, `electron-v${electronVersion}-darwin-arm64.zip`);
  const out = path.join(root, '.local/build/packager');
  rmSync(out, {recursive: true, force: true});
  const [folder] = await packager({
    dir: root, out, name: 'diff-viewer', platform: 'darwin', arch: 'arm64', electronVersion, overwrite: true, asar: true, prune: true,
    appBundleId: 'local.diff-viewer', appVersion: version, quiet: true,
    ...(zipDir ? {electronZipDir: zipDir} : {download: {cacheRoot: cache}}),
    // Prune keeps only the production dependencies (Shiki and its tree) from node_modules.
    ignore: (file: string) => !(file === '' || file === '/package.json' || /^\/(dist|node_modules)(\/|$)/.test(file)),
  });
  rmSync(BUNDLE, {recursive: true, force: true});
  renameSync(path.join(folder, 'diff-viewer.app'), BUNDLE);
  rmSync(out, {recursive: true, force: true});
  writeFileSync(path.join(BUNDLE, 'Contents/Resources/build-identity.json'), JSON.stringify(identity) + '\n');
  run('codesign', ['--force', '--deep', '--sign', '-', BUNDLE]);
  return BUNDLE;
}

if (import.meta.main) {
  if (process.argv.length > 2) {
    console.log('scripts/package\nBuilds .local/build/diff-viewer.app with @electron/packager and signs it ad hoc (codesign --sign -). No Apple account.');
    process.exit(process.argv.includes('--help') ? 0 : 2);
  }
  packageApp().then(bundle => console.log(bundle), error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
}
