export type SourceArgument = {readonly kind: 'staged' | 'unstaged'} | {readonly kind: 'commit'; readonly revision: string};
export function parseSourceArgument(value: unknown): SourceArgument | null;
