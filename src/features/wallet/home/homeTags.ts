export type HomeTagId = 'moveFunds' | 'backUp' | 'keyBlocked' | 'privateHold' | 'setupPrivate';

export interface HomeTagFlags {
  padded: boolean;
  backup: boolean;
  keyBlocked: boolean;
  privateHold?: boolean;
  setupPrivate: boolean;
}

export function homeTagOrder(f: HomeTagFlags): HomeTagId[] {
  const tags: HomeTagId[] = [];
  if (f.padded) tags.push('moveFunds');
  if (f.backup) tags.push('backUp');
  if (f.keyBlocked) tags.push('keyBlocked');
  else if (f.privateHold) tags.push('privateHold');
  else if (f.setupPrivate) tags.push('setupPrivate');
  return tags;
}
