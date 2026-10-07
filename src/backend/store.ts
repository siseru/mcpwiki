// Persistence interface. Implemented by DynamoStore (AWS) and MemoryStore (tests/local).
import type { ArticleMeta, AuditEntry, HistoryEntry } from '../shared/types.js';

export interface UserState {
  disabled: boolean;
  /** Tokens issued (iat) before this epoch second are rejected. */
  minIat: number;
}

export interface MetaPage {
  items: ArticleMeta[];
  /** Opaque position after the last item, if more may exist. */
  next?: string;
}

export interface Store {
  /** Store the OKF document; returns the storage version id. */
  putBody(id: string, text: string): Promise<string>;
  getBody(id: string, versionId: string): Promise<string>;

  getMeta(id: string): Promise<ArticleMeta | null>;
  batchGetMeta(ids: string[]): Promise<ArticleMeta[]>;
  /** Most recently updated first. `after` is a value previously returned as `next`. */
  listMetas(opts: { deleted: boolean; after?: string; limit: number }): Promise<MetaPage>;
  /** Throws ConflictError if the id exists. */
  createMeta(meta: ArticleMeta, history: HistoryEntry): Promise<void>;
  /** Throws ConflictError if the stored version differs from expectedVersion. */
  updateMeta(meta: ArticleMeta, expectedVersion: number, history: HistoryEntry): Promise<void>;
  listHistory(id: string, limit: number): Promise<HistoryEntry[]>;
  getHistory(id: string, version: number): Promise<HistoryEntry | null>;

  getIndexTerms(id: string): Promise<Record<string, number>>;
  replaceIndex(id: string, terms: Record<string, number>, prev: Record<string, number>): Promise<void>;
  queryTerm(token: string, limit: number): Promise<{ id: string; w: number }[]>;

  getBacklinks(id: string): Promise<string[]>;
  replaceBacklinks(id: string, links: string[], prev: string[]): Promise<void>;

  putAudit(entry: AuditEntry): Promise<void>;
  listAudit(date: string, limit: number): Promise<AuditEntry[]>;

  getUserState(sub: string): Promise<UserState | null>;
  putUserState(sub: string, state: UserState): Promise<void>;

  /** Fixed-window counter. Returns false when the limit is exceeded. */
  hit(key: string, windowSec: number, limit: number): Promise<boolean>;
}

export const listKey = (m: Pick<ArticleMeta, 'updatedAt' | 'id'>) => `${m.updatedAt}#${m.id}`;
