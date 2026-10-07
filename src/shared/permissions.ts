// Single source of truth for authorization. Used by the API, MCP and UI.
import type { ArticleMeta, Principal, ReadScope, Role, WriteScope } from './types.js';
import { ROLES } from './types.js';

type Subject = Pick<Principal, 'sub' | 'role'>;
type Target = Pick<ArticleMeta, 'owner' | 'readScope' | 'writeScope' | 'deleted'>;

const READ_WIDTH: Record<ReadScope, number> = { admin: 1, owner: 2, all: 3 };
const WRITE_WIDTH: Record<WriteScope, number> = { none: 0, admin: 1, owner: 2, all: 3 };

/** Highest role among Cognito groups, or null if the user has none. */
export function roleFromGroups(groups: readonly string[] | undefined): Role | null {
  if (!groups) return null;
  for (const r of ROLES) if (groups.includes(r)) return r; // ROLES is ordered highest first
  return null;
}

export function isAdmin(p: Subject): boolean {
  return p.role === 'admin';
}

export function canRead(p: Subject, a: Target): boolean {
  if (isAdmin(p)) return true;
  if (a.deleted) return false;
  switch (a.readScope) {
    case 'all':
      return true;
    case 'owner':
      return p.sub === a.owner;
    case 'admin':
      return false;
  }
}

export function canWrite(p: Subject, a: Target): boolean {
  if (isAdmin(p)) return true;
  if (p.role !== 'editor') return false; // viewers never edit
  if (!canRead(p, a)) return false;
  switch (a.writeScope) {
    case 'all':
      return true;
    case 'owner':
      return p.sub === a.owner;
    case 'admin':
    case 'none':
      return false;
  }
}

export function canCreate(p: Subject): boolean {
  return p.role === 'admin' || p.role === 'editor';
}

/** Changing readScope/writeScope: owner (editor) or admin. */
export function canChangePermissions(p: Subject, a: Target): boolean {
  if (isAdmin(p)) return true;
  return p.role === 'editor' && p.sub === a.owner && !a.deleted;
}

/** Soft delete (web UI only — enforced by the caller): owner (editor) or admin. */
export function canDelete(p: Subject, a: Target): boolean {
  return canChangePermissions(p, a);
}

/** Write access must never be wider than read access. */
export function scopesValid(readScope: ReadScope, writeScope: WriteScope): boolean {
  return WRITE_WIDTH[writeScope] <= READ_WIDTH[readScope];
}

export function isReadScopeWider(next: ReadScope, prev: ReadScope): boolean {
  return READ_WIDTH[next] > READ_WIDTH[prev];
}

export function isWriteScopeWider(next: WriteScope, prev: WriteScope): boolean {
  return WRITE_WIDTH[next] > WRITE_WIDTH[prev];
}
