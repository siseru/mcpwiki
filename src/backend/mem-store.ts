// In-memory Store for tests and local development.
import type { ArticleMeta, Attachment, AuditEntry, HistoryEntry, SiteSettings } from '../shared/types.js';
import { ConflictError } from './errors.js';
import type { AttachmentBlobs, MetaPage, Store, UserState } from './store.js';
import { listKey } from './store.js';

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryStore implements Store {
  bodies = new Map<string, string[]>();
  metas = new Map<string, ArticleMeta>();
  history = new Map<string, HistoryEntry[]>();
  terms = new Map<string, Record<string, number>>();
  postings = new Map<string, Map<string, number>>();
  backlinks = new Map<string, Set<string>>();
  audit: AuditEntry[] = [];
  users = new Map<string, UserState>();
  counters = new Map<string, number>();
  attachments = new Map<string, Attachment>();

  async putBody(id: string, text: string): Promise<string> {
    const list = this.bodies.get(id) ?? [];
    list.push(text);
    this.bodies.set(id, list);
    return `v${list.length}`;
  }

  async getBody(id: string, versionId: string): Promise<string> {
    const text = this.bodies.get(id)?.[Number(versionId.slice(1)) - 1];
    if (text === undefined) throw new Error('no such body');
    return text;
  }

  async getMeta(id: string) {
    const m = this.metas.get(id);
    return m ? clone(m) : null;
  }

  async batchGetMeta(ids: string[]) {
    return ids.map((id) => this.metas.get(id)).filter((m): m is ArticleMeta => !!m).map(clone);
  }

  async listMetas(opts: { deleted: boolean; after?: string; limit: number }): Promise<MetaPage> {
    const all = [...this.metas.values()]
      .filter((m) => m.deleted === opts.deleted)
      .sort((a, b) => (listKey(a) < listKey(b) ? 1 : -1))
      .filter((m) => opts.after === undefined || listKey(m) < opts.after);
    const items = all.slice(0, opts.limit).map(clone);
    const last = items.at(-1);
    return { items, next: all.length > opts.limit && last ? listKey(last) : undefined };
  }

  async createMeta(meta: ArticleMeta, h: HistoryEntry) {
    if (this.metas.has(meta.id)) throw new ConflictError('exists');
    this.metas.set(meta.id, clone(meta));
    this.history.set(meta.id, [clone(h)]);
  }

  async updateMeta(meta: ArticleMeta, expectedVersion: number, h: HistoryEntry) {
    const cur = this.metas.get(meta.id);
    if (!cur || cur.version !== expectedVersion) throw new ConflictError('version mismatch');
    this.metas.set(meta.id, clone(meta));
    this.history.get(meta.id)!.push(clone(h));
  }

  async listHistory(id: string, limit: number) {
    return [...(this.history.get(id) ?? [])].reverse().slice(0, limit).map(clone);
  }

  async getHistory(id: string, version: number) {
    const h = this.history.get(id)?.find((e) => e.version === version);
    return h ? clone(h) : null;
  }

  async getIndexTerms(id: string) {
    return clone(this.terms.get(id) ?? {});
  }

  async replaceIndex(id: string, terms: Record<string, number>, prev: Record<string, number>) {
    for (const t of Object.keys(prev)) if (!(t in terms)) this.postings.get(t)?.delete(id);
    for (const [t, w] of Object.entries(terms)) {
      if (!this.postings.has(t)) this.postings.set(t, new Map());
      this.postings.get(t)!.set(id, w);
    }
    this.terms.set(id, clone(terms));
  }

  async queryTerm(token: string, limit: number) {
    return [...(this.postings.get(token) ?? new Map<string, number>()).entries()].slice(0, limit).map(([id, w]) => ({ id, w }));
  }

  async getBacklinks(id: string) {
    return [...(this.backlinks.get(id) ?? [])];
  }

  async replaceBacklinks(id: string, links: string[], prev: string[]) {
    for (const t of prev) if (!links.includes(t)) this.backlinks.get(t)?.delete(id);
    for (const t of links) {
      if (!this.backlinks.has(t)) this.backlinks.set(t, new Set());
      this.backlinks.get(t)!.add(id);
    }
  }

  async putAudit(e: AuditEntry) {
    this.audit.push(clone(e));
  }

  async listAudit(date: string, limit: number) {
    return this.audit.filter((e) => e.ts.startsWith(date)).reverse().slice(0, limit).map(clone);
  }

  async getUserState(sub: string) {
    const s = this.users.get(sub);
    return s ? clone(s) : null;
  }

  async putUserState(sub: string, state: UserState) {
    this.users.set(sub, clone(state));
  }

  private settings: SiteSettings | null = null;
  async getSettings() {
    return this.settings ? clone(this.settings) : null;
  }
  async putSettings(s: SiteSettings) {
    this.settings = clone(s);
  }

  async hit(key: string, windowSec: number, limit: number) {
    const k = `${key}#${Math.floor(Date.now() / 1000 / windowSec)}`;
    const n = (this.counters.get(k) ?? 0) + 1;
    this.counters.set(k, n);
    return n <= limit;
  }

  async putAttachment(a: Attachment) {
    this.attachments.set(`${a.articleId}/${a.fileId}`, clone(a));
  }

  async getAttachment(articleId: string, fileId: string) {
    const a = this.attachments.get(`${articleId}/${fileId}`);
    return a ? clone(a) : null;
  }

  async listAttachments(articleId: string) {
    return [...this.attachments.values()].filter((a) => a.articleId === articleId).map(clone);
  }
}

/** In-memory object storage for tests: "uploads" are simulated with put(). */
export class MemoryBlobs implements AttachmentBlobs {
  objects = new Map<string, Buffer>();
  /** Base URL of a fake object store (tests point this at a local server). */
  constructor(public baseUrl = 'https://blobs.test') {}
  async put(key: string, data: Buffer, _contentType?: string) {
    this.objects.set(key, data);
  }
  presignUpload(key: string, contentType: string, maxBytes: number) {
    return { url: `${this.baseUrl}/`, fields: { key, 'Content-Type': contentType, maxBytes: String(maxBytes) } };
  }
  presignDownload(key: string, contentType: string, disposition: string) {
    return `${this.baseUrl}/${key}?type=${encodeURIComponent(contentType)}&disposition=${encodeURIComponent(disposition)}`;
  }
  async head(key: string, bytes: number) {
    const o = this.objects.get(key);
    return o ? { size: o.length, head: o.subarray(0, bytes) } : null;
  }
  async read(key: string, maxBytes: number) {
    const o = this.objects.get(key);
    if (!o) throw new Error('no such object');
    if (o.length > maxBytes) throw new Error('object too large');
    return o;
  }
  async remove(key: string) {
    this.objects.delete(key);
  }
}
