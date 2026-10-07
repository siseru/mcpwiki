import { generateKeyPairSync, sign } from 'node:crypto';
import { TokenVerifier, type Jwk } from '../src/backend/auth.js';
import { createApp, type Req, type Res } from '../src/backend/app.js';
import { MemoryBlobs, MemoryStore } from '../src/backend/mem-store.js';
import { AttachmentService } from '../src/backend/attachments.js';
import { WikiService } from '../src/backend/service.js';
import { MemoryUserDirectory } from '../src/backend/users.js';

export const ISSUER = 'https://cognito-idp.us-west-2.amazonaws.com/us-west-2_TEST';
export const WEB = 'web-client';
export const CLI = 'cli-client';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as Jwk), kid: 'k1', use: 'sig', alg: 'RS256' };

export function makeToken(claims: Record<string, unknown>, opts: { kid?: string; key?: typeof privateKey } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: opts.kid ?? 'k1' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iss: ISSUER, token_use: 'access', iat: now, exp: now + 3600, client_id: WEB, ...claims }),
  ).toString('base64url');
  const sig = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), opts.key ?? privateKey).toString('base64url');
  return `${header}.${payload}.${sig}`;
}

export interface User {
  sub: string;
  username: string;
  groups: string[];
}

export const users = {
  admin: { sub: 'sub-admin', username: 'admin', groups: ['admin'] },
  alice: { sub: 'sub-alice', username: 'alice', groups: ['editor'] },
  bob: { sub: 'sub-bob', username: 'bob', groups: ['editor'] },
  vic: { sub: 'sub-vic', username: 'vic', groups: ['viewer'] },
  nobody: { sub: 'sub-nobody', username: 'nobody', groups: [] as string[] },
} satisfies Record<string, User>;

export function setup(opts: { rateLimit?: { perMinute: number; writesPerMinute: number }; originSecret?: string } = {}) {
  const store = new MemoryStore();
  const dir = new MemoryUserDirectory();
  const service = new WikiService(store, dir);
  const verifier = new TokenVerifier({
    issuer: ISSUER,
    store,
    clients: async () => ({ [WEB]: 'web', [CLI]: 'cli' }),
    fetchJwks: async () => ({ keys: [jwk] }),
  });
  const blobs = new MemoryBlobs();
  const attachments = new AttachmentService(store, blobs, service);
  const app = createApp({ service, attachments, verifier, store, publicUrl: 'https://wiki.example.com', issuer: ISSUER, ...opts });

  async function call(
    user: User | null,
    method: string,
    path: string,
    body?: unknown,
    o: { client?: string; headers?: Record<string, string>; raw?: Buffer; contentType?: string } = {},
  ): Promise<{ status: number; json: any; res: Res }> {
    const [p, qs] = path.split('?');
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (user) headers.authorization = `Bearer ${makeToken({ sub: user.sub, username: user.username, 'cognito:groups': user.groups, client_id: o.client ?? WEB })}`;
    let buf: Buffer | null = null;
    if (o.raw) {
      buf = o.raw;
      headers['content-type'] = o.contentType ?? 'application/octet-stream';
    } else if (body !== undefined) {
      buf = Buffer.from(JSON.stringify(body));
      headers['content-type'] = 'application/json';
    }
    const req: Req = { method, path: p!, query: Object.fromEntries(new URLSearchParams(qs ?? '')), headers, body: buf };
    const res = await app(req);
    let parsed: any = undefined;
    if (typeof res.body === 'string' && res.body && res.headers['content-type']?.startsWith('application/json')) parsed = JSON.parse(res.body);
    return { status: res.status, json: parsed, res };
  }

  let rpcId = 0;
  async function mcp(user: User, method: string, params?: Record<string, unknown>, client = CLI) {
    const r = await call(user, 'POST', '/mcp', { jsonrpc: '2.0', id: ++rpcId, method, params }, { client });
    return r.json;
  }
  async function tool(user: User, name: string, args: Record<string, unknown>): Promise<any> {
    const r = await mcp(user, 'tools/call', { name, arguments: args });
    if (r.error) return { error: r.error };
    const text: string = r.result.content[0].text;
    return { isError: !!r.result.isError, text, data: r.result.structuredContent };
  }

  return { store, dir, service, blobs, app, call, mcp, tool };
}
