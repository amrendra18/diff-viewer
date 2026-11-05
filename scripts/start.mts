import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import path from 'node:path';
import {build} from './build.mts';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('scripts/start [--open REPOSITORY] [--data-dir FOLDER]\nBuilds the app and runs it from this checkout.\nWithout --data-dir, app data goes to .local/app-data in this checkout.');
  process.exit(0);
}
const open = args.indexOf('--open');
// Electron runs with this checkout as its working folder, so a relative repository path is resolved here, against the folder you run it from.
if (open >= 0 && args[open + 1] && !args[open + 1].startsWith('--')) args[open + 1] = path.resolve(args[open + 1]);
build();
const electron: unknown = createRequire(import.meta.url)('electron');
if (typeof electron !== 'string') throw new Error('Electron is missing. Run npm ci --ignore-scripts and the Electron install step.');
const dataDir = args.includes('--data-dir') ? [] : ['--data-dir', path.join(root, '.local/app-data')];
const env = {...process.env};
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [root, ...dataDir, ...args], {cwd: root, env, stdio: 'inherit'});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
child.on('exit', code => { process.exitCode = code ?? 1; });
