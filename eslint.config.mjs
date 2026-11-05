import globals from 'globals';
import tseslint from 'typescript-eslint';

const unused = ['error', {args: 'after-used', caughtErrors: 'all', ignoreRestSiblings: true}];

export default [
  {ignores: ['node_modules/**', 'dist/**', '.local/**']},
  {files: ['**/*.{js,mjs,ts,mts}', 'bin/diff-viewer'], linterOptions: {noInlineConfig: true}, rules: {
    'no-undef': 'error', 'no-unused-vars': unused, 'no-unreachable': 'error', 'no-dupe-keys': 'error',
    'no-constant-condition': ['error', {checkLoops: 'all'}], 'no-debugger': 'error', 'no-eval': 'error', 'no-implied-eval': 'error',
  }},
  {files: ['scripts/**/*.mts', 'tests/**/*.mts', 'src/app/**/*.ts', '*.mjs'], languageOptions: {globals: globals.node}},
  // The installed command has no file extension, so it is named here; it is an ES module with top-level await.
  {files: ['bin/diff-viewer'], languageOptions: {sourceType: 'module', globals: globals.node}},
  {files: ['src/web/**/*.ts'], languageOptions: {globals: globals.browser}},
  {files: ['scripts/verify.mts', 'tests/boundary.test.mts'], languageOptions: {globals: {...globals.node, ...globals.browser}}},
  {files: ['src/web/**/*.ts'], rules: {'no-restricted-properties': ['error',
    {property: 'innerHTML', message: 'Render untrusted text with textContent.'},
    {property: 'outerHTML', message: 'Render untrusted text with textContent.'},
    {property: 'insertAdjacentHTML', message: 'Render untrusted text with textContent.'}]}},
  {files: ['**/*.{ts,mts}'], languageOptions: {parser: tseslint.parser}, plugins: {'@typescript-eslint': tseslint.plugin},
    rules: {'no-undef': 'off', 'no-unused-vars': 'off', '@typescript-eslint/no-unused-vars': unused}},
];
