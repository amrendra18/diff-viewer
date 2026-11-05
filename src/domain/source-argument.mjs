/** Pure syntax check shared by the installed command and Electron. */
export function parseSourceArgument(value) {
  if (value === 'staged' || value === 'unstaged') return {kind: value};
  if (typeof value !== 'string' || !value.startsWith('commit:')) return null;
  const revision = value.slice('commit:'.length);
  if (!/^[A-Za-z0-9][A-Za-z0-9_./~^{}@-]{0,255}$/.test(revision) || revision.includes('..')) return null;
  return {kind: 'commit', revision};
}
