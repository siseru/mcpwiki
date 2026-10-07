// HTTP routing for /api/*, /mcp and /.well-known/*. Transport-agnostic (see handler.ts).
import { timingSafeEqual } from 'node:crypto';
import type { Principal } from '../shared/types.js';
import { TokenVerifier } from './auth.js';
import { badRequest, forbidden, HttpError, notFound } from './errors.js';
import { handleMcpMessage } from './mcp.js';
import type { WikiService } from './service.js';
import type { Store } from './store.js';

export interface Req {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>; // lower-case keys
  body: Buffer | null;
  requestId?: string;
}

export interface Res {
  status: number;
  headers: Record<string, string>;
  body: string | Buffer;
}

export interface AppDeps {
  service: WikiService;
  verifier: TokenVerifier;
  store: Store;
  /** Public base URL, e.g. https://d123.cloudfront.net */
  publicUrl: string;
  issuer: string;
  /** If set, requests must carry this x-origin-verify header (added by CloudFront). */
  originSecret?: string;
  rateLimit?: { perMinute: number; writesPerMinute: number };
}

const BASE_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

function json(status: number, body: unknown, extra: Record<string, string> = {}): Res {
  return { status, headers: { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8', ...extra }, body: JSON.stringify(body) };
}

function errorRes(e: HttpError, extra: Record<string, string> = {}): Res {
  return json(e.status, { error: { code: e.code, message: e.message, ...(e.details ?? {}) } }, extra);
}

function parseJson(req: Req): unknown {
  if (!req.body || req.body.length === 0) return {};
  const ct = req.headers['content-type'] ?? '';
  if (!/^application\/json\b/i.test(ct)) throw new HttpError(415, 'unsupported_media_type', 'content-type must be application/json');
  try {
    return JSON.parse(req.body.toString('utf8'));
  } catch {
    throw badRequest('invalid JSON');
  }
}

function secretMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MCP_WRITE_TOOLS = new Set(['create_article', 'update_article']);

function isMcpWrite(msg: unknown): boolean {
  const m = msg as { method?: unknown; params?: { name?: unknown } } | null;
  return !!m && m.method === 'tools/call' && MCP_WRITE_TOOLS.has(String(m.params?.name));
}

type Handler = (p: Principal, req: Req, params: string[]) => Promise<Res>;
interface Route {
  method: string;
  re: RegExp;
  handler: Handler;
}

export function createApp(d: AppDeps): (req: Req) => Promise<Res> {
  const svc = d.service;
  const resourceMetadataUrl = `${d.publicUrl}/.well-known/oauth-protected-resource`;
  const wwwAuth = { 'www-authenticate': `Bearer realm="mcpwiki", resource_metadata="${resourceMetadataUrl}"` };
  const webOnly = (p: Principal) => {
    if (p.via !== 'web') throw forbidden('this operation is only available from the web UI');
  };

  const routes: Route[] = [
    { method: 'GET', re: /^\/api\/me$/, handler: async (p) => json(200, { username: p.username, role: p.role, via: p.via }) },
    {
      method: 'GET',
      re: /^\/api\/articles$/,
      handler: async (p, r) =>
        json(200, await svc.list(p, { tag: r.query.tag, mine: r.query.mine === '1' || r.query.mine === 'true', limit: r.query.limit, cursor: r.query.cursor })),
    },
    { method: 'POST', re: /^\/api\/articles$/, handler: async (p, r) => json(201, svc.summary(p, await svc.create(p, parseJson(r)))) },
    {
      method: 'GET',
      re: /^\/api\/articles\/([^/]+)$/,
      handler: async (p, r, [id]) => {
        const v = r.query.version ? Number(r.query.version) : undefined;
        if (v !== undefined && !Number.isInteger(v)) throw badRequest('version must be an integer');
        const a = await svc.get(p, id!, v);
        if (r.query.format === 'okf') return { status: 200, headers: { ...BASE_HEADERS, 'content-type': 'text/markdown; charset=utf-8' }, body: a.okf };
        const { okf: _okf, owner: _owner, s3VersionId: _s3, ...rest } = a;
        return json(200, rest);
      },
    },
    {
      method: 'PUT',
      re: /^\/api\/articles\/([^/]+)$/,
      handler: async (p, r, [id]) => {
        const body = parseJson(r) as Record<string, unknown>;
        const { version, ...fields } = body ?? {};
        return json(200, svc.summary(p, await svc.update(p, id!, version, fields)));
      },
    },
    {
      method: 'DELETE',
      re: /^\/api\/articles\/([^/]+)$/,
      handler: async (p, _r, [id]) => {
        webOnly(p);
        await svc.remove(p, id!);
        return json(200, { ok: true });
      },
    },
    { method: 'POST', re: /^\/api\/articles\/([^/]+)\/restore$/, handler: async (p, _r, [id]) => (webOnly(p), json(200, svc.summary(p, await svc.restore(p, id!)))) },
    { method: 'POST', re: /^\/api\/articles\/([^/]+)\/verify$/, handler: async (p, _r, [id]) => (webOnly(p), json(200, svc.summary(p, await svc.verify(p, id!)))) },
    { method: 'GET', re: /^\/api\/articles\/([^/]+)\/history$/, handler: async (p, _r, [id]) => json(200, { items: await svc.history(p, id!) }) },
    { method: 'GET', re: /^\/api\/articles\/([^/]+)\/backlinks$/, handler: async (p, _r, [id]) => json(200, { items: await svc.backlinks(p, id!) }) },
    { method: 'GET', re: /^\/api\/search$/, handler: async (p, r) => json(200, { items: await svc.search(p, r.query.q ?? '', { tag: r.query.tag, limit: r.query.limit }) }) },
    { method: 'GET', re: /^\/api\/tags$/, handler: async (p) => json(200, { items: await svc.tags(p) }) },
    {
      method: 'GET',
      re: /^\/api\/graph$/,
      handler: async (p, r) => json(200, await svc.graph(p, { id: r.query.id, depth: r.query.depth, tagEdges: r.query.tags === '1', limit: r.query.limit })),
    },
    {
      method: 'GET',
      re: /^\/api\/export$/,
      handler: async (p) => ({
        status: 200,
        headers: { ...BASE_HEADERS, 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="mcpwiki-okf.zip"' },
        body: await svc.exportBundle(p),
      }),
    },
    // ---- admin (web UI only)
    { method: 'GET', re: /^\/api\/admin\/users$/, handler: async (p) => (webOnly(p), json(200, { items: await svc.listUsers(p) })) },
    { method: 'POST', re: /^\/api\/admin\/users$/, handler: async (p, r) => (webOnly(p), json(201, await svc.inviteUser(p, parseJson(r)))) },
    {
      method: 'PUT',
      re: /^\/api\/admin\/users\/([^/]+)$/,
      handler: async (p, r, [u]) => {
        webOnly(p);
        let username: string;
        try {
          username = decodeURIComponent(u!);
        } catch {
          throw badRequest('invalid username');
        }
        return json(200, await svc.updateUser(p, username, parseJson(r)));
      },
    },
    { method: 'GET', re: /^\/api\/admin\/audit$/, handler: async (p, r) => (webOnly(p), json(200, { items: await svc.listAudit(p, r.query.date) })) },
    {
      method: 'GET',
      re: /^\/api\/admin\/articles$/,
      handler: async (p, r) => (webOnly(p), json(200, await svc.list(p, { deleted: r.query.deleted === '1', limit: r.query.limit, cursor: r.query.cursor }))),
    },
    {
      method: 'POST',
      re: /^\/api\/admin\/import$/,
      handler: async (p, r) => {
        webOnly(p);
        if (!/^application\/zip\b/i.test(r.headers['content-type'] ?? '')) throw new HttpError(415, 'unsupported_media_type', 'content-type must be application/zip');
        return json(200, await svc.importBundle(p, r.body ?? Buffer.alloc(0)));
      },
    },
    { method: 'POST', re: /^\/api\/admin\/reindex$/, handler: async (p, r) => (webOnly(p), json(200, await svc.reindex(p, (parseJson(r) as { cursor?: string }).cursor))) },
  ];

  return async (req: Req): Promise<Res> => {
    const started = Date.now();
    let principal: Principal | undefined;
    let res: Res;
    try {
      if (d.originSecret && !secretMatches(req.headers['x-origin-verify'], d.originSecret)) throw forbidden('direct access is not allowed');
      res = await route(req);
    } catch (e) {
      if (e instanceof HttpError) res = errorRes(e, e.status === 401 ? wwwAuth : {});
      else {
        console.error(JSON.stringify({ msg: 'unhandled error', requestId: req.requestId, err: e instanceof Error ? e.stack : String(e) }));
        res = json(500, { error: { code: 'internal', message: 'internal error' } });
      }
    }
    console.log(
      JSON.stringify({
        msg: 'request', requestId: req.requestId, method: req.method, path: req.path, status: res.status, ms: Date.now() - started,
        user: principal?.username, via: principal?.via,
        // Set by the CloudFront viewer-request function (overwrites any client-supplied value).
        ip: req.headers['x-viewer-address']?.slice(0, 64),
      }),
    );
    return res;

    async function route(r: Req): Promise<Res> {
      if (r.path === '/api/health' && r.method === 'GET') return json(200, { ok: true });
      if (r.path.startsWith('/.well-known/oauth-protected-resource') && r.method === 'GET') {
        return json(200, {
          resource: `${d.publicUrl}/mcp`,
          authorization_servers: [d.issuer],
          bearer_methods_supported: ['header'],
          scopes_supported: ['openid', 'email', 'profile'],
          resource_name: 'MCPWiki',
        });
      }
      if (r.path === '/mcp') {
        if (r.method !== 'POST') return json(405, { error: { code: 'method_not_allowed', message: 'use POST' } }, { allow: 'POST' });
        const origin = r.headers.origin;
        if (origin && origin !== new URL(d.publicUrl).origin) throw forbidden('origin not allowed');
      }
      principal = await d.verifier.authenticate(r.headers.authorization, r.path);
      const p = principal;
      let msg: unknown;
      if (r.path === '/mcp') {
        try {
          msg = JSON.parse((r.body ?? Buffer.alloc(0)).toString('utf8'));
        } catch {
          return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        }
      }
      if (d.rateLimit) {
        const okAll = await d.store.hit(`all#${p.sub}`, 60, d.rateLimit.perMinute);
        const isWrite = r.path === '/mcp' ? isMcpWrite(msg) : WRITE_METHODS.has(r.method);
        const okWrite = !isWrite || (await d.store.hit(`w#${p.sub}`, 60, d.rateLimit.writesPerMinute));
        if (!okAll || !okWrite) throw new HttpError(429, 'rate_limited', 'too many requests; slow down', { retryAfterSeconds: 60 });
      }
      if (r.path === '/mcp') {
        const out = await handleMcpMessage(svc, p, msg, r.headers['mcp-protocol-version']);
        if (out.body === undefined) return { status: out.status, headers: { ...BASE_HEADERS }, body: '' };
        return json(out.status, out.body);
      }
      for (const rt of routes) {
        if (rt.method !== r.method) continue;
        const m = rt.re.exec(r.path);
        if (m) return rt.handler(p, r, m.slice(1));
      }
      if (routes.some((rt) => rt.re.test(r.path))) throw new HttpError(405, 'method_not_allowed', 'method not allowed');
      throw notFound('route');
    }
  };
}
