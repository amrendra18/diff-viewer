import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const json = (file: string) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const EXACT = /^\d+\.\d+\.\d+$/;

const nestedVersions = (value: unknown): string[] => typeof value === 'string' ? [value] : Object.values(value as object).flatMap(nestedVersions);

test('dependency-pins: every version in package.json is exact, and every locked package comes from npm with a checksum', () => {
  const pkg = json('package.json');
  for (const [name, version] of Object.entries({...pkg.dependencies, ...pkg.devDependencies})) assert.match(version as string, EXACT, `${name} is pinned to an exact version`);
  for (const version of nestedVersions(pkg.overrides)) assert.match(version, EXACT, 'each override is an exact version');
  const locked = Object.entries(json('package-lock.json').packages as Record<string, {resolved?: string; integrity?: string}>).filter(([name]) => name !== '');
  assert.ok(locked.length > 0, 'the lock file lists packages');
  for (const [name, entry] of locked) {
    assert.match(entry.resolved ?? '', /^https:\/\/registry\.npmjs\.org\//, `${name} comes from the npm registry`);
    assert.match(entry.integrity ?? '', /^sha512-/, `${name} has a sha512 checksum`);
  }
});
