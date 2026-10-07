// Business logic. Every entry point takes the calling Principal and enforces
// permissions via src/shared/permissions.ts. Unreadable articles are reported
// as "not found" so their existence is not revealed.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type {
  Article, ArticleMeta, ArticleSummary, AuditEntry, Graph, GraphEdge, HistoryEntry, Principal, Role,
} from '../shared/types.js';
import { ROLES } from '../shared/types.js';
import {
  canChangePermissions, canCreate, canDelete, canRead, canWrite, isAdmin, isReadScopeWider, isWriteScopeWider, scopesValid,
} from '../shared/permissions.js';
import {
  articleToOkf, bundleIndex, BUNDLE_DIR, DEFAULT_TYPE, okfToArticleFields, parseOkfDocument, toBundleLinks,
} from '../shared/okf.js';
import { extractLinks, ID_RE, indexTerms, normalize, snippet, tokenize } from '../shared/text.js';
import { validateArticleInput, ValidationError } from '../shared/validate.js';
import { badRequest, ConflictError, forbidden, HttpError, notFound } from './errors.js';
import type { Store } from './store.js';
import { listKey } from './store.js';
import type { UserDirectory, UserInfo } from './users.js';
import { readZip, writeZip } from './zip.js';

export const MCP_ACTOR = 'mcpwiki-mcp/0.1';
const MAX_SCAN = 5000;
const MAX_GRAPH_NODES = 300;
const MAX_EXPORT_BYTES = 5 * 1024 * 1024;

export function newId(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(12);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/** Cursors are AES-GCM encrypted so they never reveal ids/timestamps of articles the caller cannot read. */
function encodeCursor(key: Buffer, s: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(s, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}

function decodeCursor(key: Buffer, c: string | undefined): string | undefined {
  if (!c) return undefined;
  let s: string;
  try {
    const raw = Buffer.from(c, 'base64url');
    const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    s = Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch {
    throw badRequest('invalid cursor');
  }
  if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z#[a-z0-9-]+$/.test(s)) throw badRequest('invalid cursor');
  return s;
}

/** Serialize and prove the document parses back to the same body (never store an unreadable document). */
function serializeChecked(meta: ArticleMeta, body: string): string {
  const text = articleToOkf(meta, body);
  try {
    if (parseOkfDocument(text).body === body) return text;
  } catch {
    /* fall through */
  }
  throw badRequest('the article metadata contains values that cannot be stored safely');
}

/** Body of a stored document; tolerates a frontmatter we can no longer parse. */
function bodyFromStored(text: string): string {
  try {
    return parseOkfDocument(text).body;
  } catch {
    const end = text.indexOf('\n---\n', 4);
    return text.startsWith('---\n') && end > 0 ? text.slice(end + 5).replace(/^\n/, '') : text;
  }
}

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

async function mapLimit<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]!);
      }
    }),
  );
  return out;
}

export interface SearchResult extends ArticleSummary {
  score: number;
  snippet: string;
}

export interface ImportReport {
  created: string[];
  updated: string[];
  skipped: { name: string; reason: string }[];
}

export class WikiService {
  private readonly cursorKey: Buffer;

  constructor(
    private readonly store: Store,
    private readonly users: UserDirectory,
    private readonly now: () => Date = () => new Date(),
    opts: { cursorKey?: Buffer } = {},
  ) {
    // Must be shared by all Lambda instances (derived from a deployment secret); random is fine for tests.
    this.cursorKey = opts.cursorKey ?? randomBytes(32);
  }

  private ts(): string {
    return this.now().toISOString();
  }

  summary(p: Principal, m: ArticleMeta): ArticleSummary {
    const s: ArticleSummary = {
      id: m.id, type: m.type, title: m.title, description: m.description, tags: m.tags, status: m.status,
      readScope: m.readScope, writeScope: m.writeScope, ownerName: m.ownerName, version: m.version,
      updatedAt: m.updatedAt, updatedBy: m.updatedBy, canEdit: canWrite(p, m),
    };
    if (m.deleted) s.deleted = true;
    return s;
  }

  private async audit(p: Principal, action: string, articleId?: string, detail?: string): Promise<void> {
    const e: AuditEntry = { ts: this.ts(), actor: p.username, sub: p.sub, via: p.via, action };
    if (articleId) e.articleId = articleId;
    if (detail) e.detail = detail.slice(0, 500);
    try {
      await this.store.putAudit(e);
    } catch (err) {
      console.error(JSON.stringify({ msg: 'audit write failed', action, err: String(err) }));
    }
  }

  private async readable(p: Principal, id: string): Promise<ArticleMeta> {
    if (!ID_RE.test(id)) throw notFound();
    const m = await this.store.getMeta(id);
    if (!m || !canRead(p, m)) throw notFound();
    return m;
  }

  private async bodyOf(m: ArticleMeta): Promise<string> {
    return bodyFromStored(await this.store.getBody(m.id, m.s3VersionId));
  }

  /** All readable, non-deleted metas (bounded). */
  private async allReadable(p: Principal, deleted = false): Promise<{ items: ArticleMeta[]; truncated: boolean }> {
    const items: ArticleMeta[] = [];
    let after: string | undefined;
    let scanned = 0;
    do {
      const page = await this.store.listMetas({ deleted, after, limit: 500 });
      scanned += page.items.length;
      for (const m of page.items) if (canRead(p, m)) items.push(m);
      after = page.next;
    } while (after && scanned < MAX_SCAN);
    return { items, truncated: !!after };
  }

  // ------------------------------------------------------------- read

  async list(
    p: Principal,
    opts: { tag?: string; mine?: boolean; limit?: unknown; cursor?: string; deleted?: boolean },
  ): Promise<{ items: ArticleSummary[]; cursor?: string }> {
    if (opts.deleted && !isAdmin(p)) throw forbidden('only admins can list deleted articles');
    const limit = clampInt(opts.limit, 50, 1, 200);
    const tag = opts.tag ? normalize(opts.tag) : undefined;
    let after = decodeCursor(this.cursorKey, opts.cursor);
    const out: ArticleMeta[] = [];
    let scanned = 0;
    let more = true;
    while (out.length < limit && scanned < MAX_SCAN) {
      const page = await this.store.listMetas({ deleted: !!opts.deleted, after, limit: 200 });
      scanned += page.items.length;
      let stoppedEarly = false;
      for (let i = 0; i < page.items.length; i++) {
        const m = page.items[i]!;
        after = listKey(m);
        if (!canRead(p, m)) continue;
        if (tag && !m.tags.some((t) => normalize(t) === tag)) continue;
        if (opts.mine && m.owner !== p.sub) continue;
        out.push(m);
        if (out.length >= limit) {
          stoppedEarly = i < page.items.length - 1;
          break;
        }
      }
      if (!page.next) {
        more = stoppedEarly;
        break;
      }
    }
    const res: { items: ArticleSummary[]; cursor?: string } = { items: out.map((m) => this.summary(p, m)) };
    if (more && after) res.cursor = encodeCursor(this.cursorKey, after);
    return res;
  }
  async get(p: Principal, id: string, version?: number): Promise<Article & { canEdit: boolean; okf: string }> {
    const m = await this.readable(p, id);
    if (version !== undefined && version !== m.version) {
      const h = await this.store.getHistory(id, version);
      // A revision is only visible if it was readable under the scope it was written with (entries
      // without a recorded scope are treated as owner-only).
      if (!h || !canRead(p, { ...m, readScope: h.readScope ?? 'owner', deleted: false })) throw notFound('version');
      const text = await this.store.getBody(id, h.s3VersionId);
      let f;
      try {
        f = okfToArticleFields(parseOkfDocument(text));
      } catch {
        f = { body: bodyFromStored(text), extra: {} } as ReturnType<typeof okfToArticleFields>;
      }
      return {
        ...m, title: f.title ?? m.title, description: f.description ?? '', tags: f.tags ?? [], status: f.status ?? 'stable',
        version: h.version, updatedAt: h.updatedAt, updatedBy: h.updatedBy, body: f.body, canEdit: false, okf: text,
      };
    }
    const text = await this.store.getBody(id, m.s3VersionId);
    return { ...m, body: bodyFromStored(text), canEdit: canWrite(p, m), okf: text };
  }

  async history(p: Principal, id: string): Promise<HistoryEntry[]> {
    const m = await this.readable(p, id);
    return (await this.store.listHistory(id, 100)).filter((h) => canRead(p, { ...m, readScope: h.readScope ?? 'owner', deleted: false }));
  }

  async backlinks(p: Principal, id: string): Promise<ArticleSummary[]> {
    await this.readable(p, id);
    const ids = await this.store.getBacklinks(id);
    const metas = await this.store.batchGetMeta(ids);
    return metas.filter((m) => !m.deleted && canRead(p, m)).map((m) => this.summary(p, m));
  }

  async tags(p: Principal): Promise<{ tag: string; count: number }[]> {
    const { items } = await this.allReadable(p);
    const counts = new Map<string, number>();
    for (const m of items) for (const t of m.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  async search(p: Principal, query: string, opts: { tag?: string; limit?: unknown } = {}): Promise<SearchResult[]> {
    const q = (query ?? '').trim();
    if (!q) throw badRequest('query is required');
    if (q.length > 200) throw badRequest('query is too long');
    const limit = clampInt(opts.limit, 20, 1, 50);
    const tag = opts.tag ? normalize(opts.tag) : undefined;
    const tokens = [...new Set(tokenize(q))].slice(0, 12);
    const scores = new Map<string, { score: number; matched: number }>();
    if (tokens.length) {
      const postings = await Promise.all(tokens.map((t) => this.store.queryTerm(t, 3000)));
      for (const list of postings) {
        for (const { id, w } of list) {
          const s = scores.get(id) ?? { score: 0, matched: 0 };
          s.score += w;
          s.matched++;
          scores.set(id, s);
        }
      }
    }
    // Filter by readability BEFORE choosing AND/partial matches and before truncating, so results never
    // depend on articles the caller cannot read (no existence/content oracle).
    const candidates = [...scores.entries()]
      .sort((a, b) => b[1].matched - a[1].matched || b[1].score - a[1].score)
      .slice(0, 2000)
      .map(([id]) => id);
    const readable = (await this.store.batchGetMeta(candidates)).filter(
      (m) => !m.deleted && canRead(p, m) && (!tag || m.tags.some((t) => normalize(t) === tag)),
    );
    let metas = readable.filter((m) => scores.get(m.id)!.matched === tokens.length);
    if (!metas.length) metas = readable.filter((m) => scores.get(m.id)!.matched >= Math.max(1, Math.ceil(tokens.length / 2)));
    const nq = normalize(q);
    if (!metas.length) {
      // Substring fallback over titles/descriptions/tags (covers partial words and 1-char queries).
      const { items } = await this.allReadable(p);
      metas = items.filter(
        (m) =>
          (!tag || m.tags.some((t) => normalize(t) === tag)) &&
          (normalize(m.title).includes(nq) || normalize(m.description).includes(nq) || m.tags.some((t) => normalize(t).includes(nq))),
      );
    }
    const ranked = metas
      .map((m) => ({ m, score: (scores.get(m.id)?.score ?? 1) + (normalize(m.title).includes(nq) ? 50 : 0) }))
      .sort((a, b) => b.score - a.score || (a.m.updatedAt < b.m.updatedAt ? 1 : -1))
      .slice(0, limit);
    return mapLimit(ranked, 8, async ({ m, score }) => {
      let snip = m.description;
      try {
        snip = snippet(await this.bodyOf(m), q);
      } catch {
        /* keep description */
      }
      return { ...this.summary(p, m), score, snippet: snip };
    });
  }

  async graph(p: Principal, opts: { id?: string; depth?: unknown; tagEdges?: boolean; limit?: unknown }): Promise<Graph> {
    const maxNodes = clampInt(opts.limit, 200, 1, MAX_GRAPH_NODES);
    const nodes = new Map<string, ArticleMeta>();
    let truncated = false;
    if (opts.id) {
      const root = await this.readable(p, opts.id);
      if (root.deleted) throw notFound();
      nodes.set(root.id, root);
      const depth = clampInt(opts.depth, 1, 1, 3);
      let frontier = [root];
      for (let d = 0; d < depth && frontier.length; d++) {
        const neighborIds = new Set<string>();
        const backs = await mapLimit(frontier, 8, (m) => this.store.getBacklinks(m.id));
        frontier.forEach((m, i) => {
          for (const t of m.links) neighborIds.add(t);
          for (const b of backs[i]!) neighborIds.add(b);
        });
        for (const id of nodes.keys()) neighborIds.delete(id);
        const ids = [...neighborIds];
        if (ids.length > 500) truncated = true; // bound the work per request
        const metas = (await this.store.batchGetMeta(ids.slice(0, 500))).filter((m) => !m.deleted && canRead(p, m));
        frontier = [];
        for (const m of metas) {
          if (nodes.size >= maxNodes) {
            truncated = true;
            break;
          }
          nodes.set(m.id, m);
          frontier.push(m);
        }
      }
    } else {
      const { items, truncated: t } = await this.allReadable(p);
      truncated = t || items.length > maxNodes;
      for (const m of items.slice(0, maxNodes)) nodes.set(m.id, m);
    }
    const edges: GraphEdge[] = [];
    for (const m of nodes.values()) for (const t of m.links) if (nodes.has(t)) edges.push({ from: m.id, to: t, kind: 'link' });
    if (opts.tagEdges) {
      const byTag = new Map<string, string[]>();
      for (const m of nodes.values()) for (const t of m.tags) byTag.set(t, [...(byTag.get(t) ?? []), m.id]);
      const pairs = new Map<string, string[]>();
      for (const [tag, ids] of byTag) {
        if (ids.length > 30) continue; // very common tags carry little signal
        for (let i = 0; i < ids.length; i++)
          for (let j = i + 1; j < ids.length; j++) {
            const [a, b] = [ids[i]!, ids[j]!].sort();
            const k = `${a}\u0000${b}`;
            pairs.set(k, [...(pairs.get(k) ?? []), tag]);
          }
      }
      for (const [k, tags] of [...pairs.entries()].slice(0, 2000)) {
        const [from, to] = k.split('\u0000') as [string, string];
        edges.push({ from, to, kind: 'tag', tags });
      }
    }
    return {
      nodes: [...nodes.values()].map((m) => ({ id: m.id, title: m.title, type: m.type, tags: m.tags, status: m.status, updatedAt: m.updatedAt })),
      edges,
      truncated,
    };
  }

  // ------------------------------------------------------------- write

  private actorFor(p: Principal): string {
    return p.via === 'mcp' ? MCP_ACTOR : `human:${p.username}`;
  }

  private historyEntry(m: ArticleMeta, p: Principal, action: HistoryEntry['action']): HistoryEntry {
    return {
      id: m.id, version: m.version, s3VersionId: m.s3VersionId, title: m.title, updatedAt: m.updatedAt, updatedBy: p.username, via: p.via, action,
      readScope: m.readScope,
    };
  }

  private async reindexOne(m: ArticleMeta, body: string, prevLinks: string[]): Promise<void> {
    const prev = await this.store.getIndexTerms(m.id);
    await this.store.replaceIndex(m.id, indexTerms(m.title, m.tags, m.description, body), prev);
    await this.store.replaceBacklinks(m.id, m.links, prevLinks);
  }

  private async afterWrite(m: ArticleMeta, body: string, prevLinks: string[]): Promise<void> {
    try {
      await this.reindexOne(m, body, prevLinks);
    } catch (err) {
      // The article itself is saved; the index can be rebuilt with POST /api/admin/reindex.
      console.error(JSON.stringify({ msg: 'index update failed', id: m.id, err: String(err) }));
    }
  }

  async create(p: Principal, raw: unknown, opts: { generatedBy?: string; action?: HistoryEntry['action'] } = {}): Promise<ArticleMeta> {
    if (!canCreate(p)) throw forbidden('your role cannot create articles');
    const input = this.validate(raw, false);
    const id = input.id ?? newId();
    const readScope = input.readScope ?? 'all';
    const writeScope = input.writeScope ?? (readScope === 'admin' ? 'admin' : 'owner');
    if (!scopesValid(readScope, writeScope)) throw badRequest('writeScope must not be wider than readScope');
    const body = input.body ?? '';
    const now = this.ts();
    const meta: ArticleMeta = {
      id, type: input.type ?? DEFAULT_TYPE, title: input.title!, description: input.description ?? '', tags: input.tags ?? [],
      status: input.status ?? (p.via === 'mcp' ? 'draft' : 'stable'), readScope, writeScope, owner: p.sub, ownerName: p.username,
      version: 1, createdAt: now, updatedAt: now, updatedBy: p.username, generatedBy: opts.generatedBy ?? this.actorFor(p),
      verified: [], extra: input.extra ?? {}, links: extractLinks(body, id), s3VersionId: '', deleted: false,
    };
    const text = serializeChecked(meta, body);
    // Reserve-check before writing to S3 so a taken id never gets a foreign object version.
    if (await this.store.getMeta(id)) throw new HttpError(409, 'conflict', `the id "${id}" is not available`);
    meta.s3VersionId = await this.store.putBody(id, text);
    try {
      await this.store.createMeta(meta, this.historyEntry(meta, p, opts.action ?? 'create'));
    } catch (e) {
      if (e instanceof ConflictError) throw new HttpError(409, 'conflict', `the id "${id}" is not available`);
      throw e;
    }
    await this.afterWrite(meta, body, []);
    await this.audit(p, opts.action ?? 'create', id);
    return meta;
  }

  private validate(raw: unknown, partial: boolean) {
    try {
      return validateArticleInput(raw, partial);
    } catch (e) {
      if (e instanceof ValidationError) throw badRequest(e.message, { errors: e.errors });
      throw e;
    }
  }

  async update(
    p: Principal,
    id: string,
    expectedVersion: unknown,
    raw: unknown,
    opts: { generatedBy?: string; action?: HistoryEntry['action'] } = {},
  ): Promise<ArticleMeta> {
    const cur = await this.readable(p, id);
    if (!canWrite(p, cur)) throw forbidden('you cannot edit this article');
    if (cur.deleted) throw new HttpError(409, 'deleted', 'article is deleted');
    if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion)) {
      throw badRequest('version (the version you based your edit on) is required');
    }
    if (expectedVersion !== cur.version) {
      throw new HttpError(409, 'version_conflict', `article was modified (current version ${cur.version}); re-read it and apply your change again`, {
        currentVersion: cur.version,
      });
    }
    const input = this.validate(raw, true);
    if (input.id !== undefined && input.id !== id) throw badRequest('id cannot be changed');
    const readScope = input.readScope ?? cur.readScope;
    const writeScope = input.writeScope ?? cur.writeScope;
    if (readScope !== cur.readScope || writeScope !== cur.writeScope) {
      if (!canChangePermissions(p, cur)) throw forbidden('only the owner or an admin can change permissions');
      // Tokens usable by agents (CLI / MCP / API) may only narrow permissions: a prompt-injected agent
      // with shell access could otherwise publish private articles through the CLI.
      if (p.via !== 'web' && (isReadScopeWider(readScope, cur.readScope) || isWriteScopeWider(writeScope, cur.writeScope))) {
        throw forbidden('permissions can only be widened from the web UI');
      }
      if (!scopesValid(readScope, writeScope)) throw badRequest('writeScope must not be wider than readScope');
    }
    const body = input.body ?? (await this.bodyOf(cur));
    const next: ArticleMeta = {
      ...cur,
      type: input.type ?? cur.type,
      title: input.title ?? cur.title,
      description: input.description ?? cur.description,
      tags: input.tags ?? cur.tags,
      status: input.status ?? cur.status,
      readScope,
      writeScope,
      extra: input.extra ?? cur.extra,
      version: cur.version + 1,
      updatedAt: this.ts(),
      updatedBy: p.username,
      generatedBy: opts.generatedBy ?? this.actorFor(p),
      links: extractLinks(body, id),
    };
    const contentChanged = input.body !== undefined || next.title !== cur.title || next.description !== cur.description;
    if (contentChanged) next.verified = []; // verification applied to the previous content
    next.s3VersionId = await this.store.putBody(id, serializeChecked(next, body));
    try {
      await this.store.updateMeta(next, cur.version, this.historyEntry(next, p, opts.action ?? 'update'));
    } catch (e) {
      if (e instanceof ConflictError) throw new HttpError(409, 'version_conflict', 'article was modified concurrently; re-read and retry');
      throw e;
    }
    await this.afterWrite(next, body, cur.links);
    await this.audit(p, opts.action ?? 'update', id, readScope !== cur.readScope || writeScope !== cur.writeScope ? `scopes ${readScope}/${writeScope}` : undefined);
    return next;
  }

  /** Metadata-only state change that also rewrites the OKF document. */
  private async mutate(p: Principal, cur: ArticleMeta, action: HistoryEntry['action'], change: (m: ArticleMeta) => void): Promise<ArticleMeta> {
    const body = await this.bodyOf(cur);
    const next: ArticleMeta = { ...cur, version: cur.version + 1, updatedAt: this.ts(), updatedBy: p.username };
    change(next);
    next.s3VersionId = await this.store.putBody(cur.id, serializeChecked(next, body));
    try {
      await this.store.updateMeta(next, cur.version, this.historyEntry(next, p, action));
    } catch (e) {
      if (e instanceof ConflictError) throw new HttpError(409, 'version_conflict', 'article was modified concurrently; retry');
      throw e;
    }
    await this.audit(p, action, cur.id);
    return next;
  }

  async remove(p: Principal, id: string): Promise<void> {
    if (p.via !== 'web') throw forbidden('articles can only be deleted from the web UI');
    const cur = await this.readable(p, id);
    if (cur.deleted) return;
    if (!canDelete(p, cur)) throw forbidden('only the owner or an admin can delete this article');
    await this.mutate(p, cur, 'delete', (m) => {
      m.deleted = true;
      m.deletedAt = m.updatedAt;
      m.deletedBy = p.username;
    });
  }

  async restore(p: Principal, id: string): Promise<ArticleMeta> {
    if (p.via !== 'web' || !isAdmin(p)) throw forbidden('only admins can restore articles from the web UI');
    const cur = await this.readable(p, id);
    if (!cur.deleted) return cur;
    return this.mutate(p, cur, 'restore', (m) => {
      m.deleted = false;
      delete m.deletedAt;
      delete m.deletedBy;
    });
  }

  /** OKF `verified` entry by a human reviewer (web UI only). */
  async verify(p: Principal, id: string): Promise<ArticleMeta> {
    if (p.via !== 'web') throw forbidden('verification is only possible from the web UI');
    if (p.role === 'viewer') throw forbidden('viewers cannot verify articles');
    const cur = await this.readable(p, id);
    if (cur.deleted) throw notFound();
    if (!canWrite(p, cur)) throw forbidden('you can only verify articles you can edit');
    return this.mutate(p, cur, 'verify', (m) => {
      m.verified = [...cur.verified.filter((v) => v.by !== `human:${p.username}`), { by: `human:${p.username}`, at: m.updatedAt }];
    });
  }

  // ------------------------------------------------------------- OKF bundles

  async exportBundle(p: Principal): Promise<Buffer> {
    const { items } = await this.allReadable(p);
    let total = 0;
    const files = await mapLimit(items, 10, async (m) => {
      const text = toBundleLinks(articleToOkf(m, await this.bodyOf(m)));
      total += Buffer.byteLength(text);
      if (total > MAX_EXPORT_BYTES) throw new HttpError(413, 'too_large', 'export exceeds 5MB; contact an admin');
      return { name: `${BUNDLE_DIR}/${m.id}.md`, data: Buffer.from(text, 'utf8') };
    });
    files.unshift({ name: 'index.md', data: Buffer.from(bundleIndex(items, 'MCPWiki'), 'utf8') });
    await this.audit(p, 'export', undefined, `${items.length} articles`);
    return writeZip(files, this.now());
  }

  async importBundle(p: Principal, zip: Buffer): Promise<ImportReport> {
    if (p.via !== 'web' || !isAdmin(p)) throw forbidden('only admins can import from the web UI');
    let entries;
    try {
      entries = readZip(zip, { maxEntries: 1000, maxEntryBytes: 512 * 1024, maxTotalBytes: 20 * 1024 * 1024 });
    } catch (e) {
      throw badRequest(`invalid bundle: ${(e as Error).message}`);
    }
    const report: ImportReport = { created: [], updated: [], skipped: [] };
    for (const e of entries) {
      const base = e.name.split('/').pop()!;
      if (!base.endsWith('.md') || base === 'index.md' || base === 'log.md') {
        report.skipped.push({ name: e.name, reason: 'not a concept document' });
        continue;
      }
      try {
        const doc = parseOkfDocument(Buffer.from(e.data).toString('utf8'));
        const f = okfToArticleFields(doc);
        const fromPath = base.slice(0, -3).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
        const id = f.id && ID_RE.test(f.id) ? f.id : fromPath;
        if (!ID_RE.test(id)) throw new Error('cannot derive a valid id');
        const fm = doc.frontmatter;
        const gen = fm.generated && typeof fm.generated === 'object' && !Array.isArray(fm.generated) ? fm.generated.by : undefined;
        const input = {
          id, type: f.type, title: f.title ?? base.slice(0, -3), description: f.description, tags: f.tags, status: f.status,
          readScope: f.readScope, writeScope: f.writeScope, body: f.body, extra: f.extra,
        };
        const opts = { generatedBy: typeof gen === 'string' ? gen.slice(0, 200) : `human:${p.username}`, action: 'import' as const };
        const existing = await this.store.getMeta(id);
        if (existing) {
          await this.update(p, id, existing.version, { ...input, id: undefined }, opts);
          report.updated.push(id);
        } else {
          await this.create(p, input, opts);
          report.created.push(id);
        }
      } catch (err) {
        report.skipped.push({ name: e.name, reason: err instanceof HttpError || err instanceof Error ? err.message.slice(0, 300) : 'error' });
      }
    }
    await this.audit(p, 'import', undefined, `created ${report.created.length}, updated ${report.updated.length}, skipped ${report.skipped.length}`);
    return report;
  }

  /** Rebuild search postings and backlinks (admin backfill). Processes one page per call. */
  async reindex(p: Principal, cursor?: string): Promise<{ processed: number; failed: string[]; cursor?: string }> {
    if (!isAdmin(p)) throw forbidden();
    const page = await this.store.listMetas({ deleted: false, after: decodeCursor(this.cursorKey, cursor), limit: 25 });
    const failed: string[] = [];
    for (const m of page.items) {
      try {
        // Puts are idempotent, so passing [] as "previous" restores any missing backlinks.
        await this.reindexOne(m, await this.bodyOf(m), []);
      } catch (err) {
        failed.push(m.id);
        console.error(JSON.stringify({ msg: 'reindex failed', id: m.id, err: String(err) }));
      }
    }
    await this.audit(p, 'reindex', undefined, `${page.items.length} processed, ${failed.length} failed`);
    const res: { processed: number; failed: string[]; cursor?: string } = { processed: page.items.length, failed };
    if (page.next) res.cursor = encodeCursor(this.cursorKey, page.next);
    return res;
  }

  // ------------------------------------------------------------- admin

  async listAudit(p: Principal, date?: string): Promise<AuditEntry[]> {
    if (!isAdmin(p)) throw forbidden();
    const d = date ?? this.ts().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw badRequest('date must be YYYY-MM-DD');
    return this.store.listAudit(d, 500);
  }

  async listUsers(p: Principal): Promise<UserInfo[]> {
    if (!isAdmin(p)) throw forbidden();
    return this.users.list();
  }

  async inviteUser(p: Principal, raw: unknown): Promise<UserInfo> {
    if (!isAdmin(p) || p.via !== 'web') throw forbidden('only admins can invite users from the web UI');
    const r = (raw ?? {}) as Record<string, unknown>;
    const username = typeof r.username === 'string' ? r.username.trim() : '';
    const email = typeof r.email === 'string' ? r.email.trim() : '';
    const role = r.role as Role;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}$/.test(username)) throw badRequest('username must be 2-64 chars of letters, digits, . _ -');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw badRequest('invalid email');
    if (!(ROLES as readonly string[]).includes(role)) throw badRequest(`role must be one of ${ROLES.join(', ')}`);
    try {
      const u = await this.users.invite(username, email, role);
      await this.audit(p, 'user.invite', undefined, `${username} as ${role}`);
      return u;
    } catch (e) {
      if (e instanceof ConflictError) throw new HttpError(409, 'conflict', 'username already exists');
      throw e;
    }
  }

  async updateUser(p: Principal, username: string, raw: unknown): Promise<UserInfo> {
    if (!isAdmin(p) || p.via !== 'web') throw forbidden('only admins can manage users from the web UI');
    const r = (raw ?? {}) as Record<string, unknown>;
    const u = await this.users.get(username);
    if (!u) throw notFound('user');
    if (u.sub === p.sub) throw badRequest('you cannot change your own role or status');
    const changes: string[] = [];
    // Revoke before AND after the Cognito changes (minIat = now + 1): a token minted mid-change must not survive.
    const revoke = (disabled: boolean) => this.store.putUserState(u.sub, { disabled, minIat: Math.floor(this.now().getTime() / 1000) + 1 });
    await revoke(r.enabled === false || !u.enabled);
    if (r.role !== undefined) {
      if (!(ROLES as readonly unknown[]).includes(r.role)) throw badRequest(`role must be one of ${ROLES.join(', ')}`);
      await this.users.setRole(username, r.role as Role);
      changes.push(`role=${r.role}`);
    }
    if (r.enabled !== undefined) {
      if (typeof r.enabled !== 'boolean') throw badRequest('enabled must be boolean');
      await this.users.setEnabled(username, r.enabled);
      changes.push(`enabled=${r.enabled}`);
    }
    if (!changes.length) throw badRequest('nothing to change');
    // Invalidate tokens issued before this change (role is read from the token).
    await revoke(r.enabled === false || (r.enabled === undefined && !u.enabled));
    await this.audit(p, 'user.update', undefined, `${username}: ${changes.join(', ')}`);
    return (await this.users.get(username))!;
  }
}
