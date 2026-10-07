// Cognito access-token verification (RS256, JWKS) using node:crypto only.
import { createPublicKey, verify as cryptoVerify, type JsonWebKey, type KeyObject } from 'node:crypto';
import type { Principal, Via } from '../shared/types.js';
import { roleFromGroups } from '../shared/permissions.js';
import { HttpError } from './errors.js';
import type { Store } from './store.js';

export interface Jwk extends JsonWebKey {
  kid?: string;
  alg?: string;
  use?: string;
}

export interface VerifierOptions {
  issuer: string;
  /** client_id -> default channel ("web" or "cli"). Tokens from other clients are rejected. */
  clients: () => Promise<Record<string, 'web' | 'cli'>>;
  fetchJwks: () => Promise<{ keys: Jwk[] }>;
  store: Store;
  now?: () => number; // epoch seconds
  clockSkewSec?: number;
}

export interface AccessClaims {
  sub: string;
  username: string;
  client_id: string;
  token_use: string;
  iss: string;
  exp: number;
  iat: number;
  'cognito:groups'?: string[];
}

export const unauthorized = (message = 'authentication required') => new HttpError(401, 'unauthorized', message);

function b64urlJson(part: string): Record<string, unknown> {
  try {
    const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw unauthorized('malformed token');
  }
}

export class TokenVerifier {
  private keys = new Map<string, KeyObject>();
  private lastFetch = 0;

  constructor(private readonly o: VerifierOptions) {}

  private now(): number {
    return this.o.now ? this.o.now() : Math.floor(Date.now() / 1000);
  }

  private async key(kid: string): Promise<KeyObject> {
    const cached = this.keys.get(kid);
    if (cached) return cached;
    // Refetch at most once per minute (key rotation), never on every bad token.
    if (this.now() - this.lastFetch < 60 && this.keys.size) throw unauthorized('unknown signing key');
    this.lastFetch = this.now();
    const { keys } = await this.o.fetchJwks();
    const next = new Map<string, KeyObject>();
    for (const k of keys) {
      if (k.kty !== 'RSA' || !k.kid || (k.use && k.use !== 'sig')) continue;
      next.set(k.kid, createPublicKey({ key: k, format: 'jwk' }));
    }
    this.keys = next;
    const found = this.keys.get(kid);
    if (!found) throw unauthorized('unknown signing key');
    return found;
  }

  async verify(token: string): Promise<AccessClaims> {
    if (token.length > 8192) throw unauthorized('token too large');
    const parts = token.split('.');
    if (parts.length !== 3) throw unauthorized('malformed token');
    const [h, p, s] = parts as [string, string, string];
    const header = b64urlJson(h);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw unauthorized('unsupported token');
    const key = await this.key(header.kid);
    const ok = cryptoVerify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
    if (!ok) throw unauthorized('invalid signature');
    const c = b64urlJson(p) as unknown as AccessClaims;
    const skew = this.o.clockSkewSec ?? 60;
    const now = this.now();
    if (c.iss !== this.o.issuer) throw unauthorized('wrong issuer');
    if (c.token_use !== 'access') throw unauthorized('an access token is required');
    if (typeof c.exp !== 'number' || c.exp + skew < now) throw unauthorized('token expired');
    if (typeof c.iat !== 'number' || c.iat - skew > now) throw unauthorized('token not yet valid');
    if (typeof c.sub !== 'string' || typeof c.client_id !== 'string') throw unauthorized('malformed token');
    const clients = await this.o.clients();
    if (!Object.prototype.hasOwnProperty.call(clients, c.client_id)) throw unauthorized('token was issued to an unknown client');
    return c;
  }

  /** Verify a bearer token and build the Principal. `path` decides the channel for CLI tokens. */
  async authenticate(authorization: string | undefined, path: string): Promise<Principal> {
    const m = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/.exec(authorization ?? '');
    if (!m) throw unauthorized();
    const c = await this.verify(m[1]!);
    const state = await this.o.store.getUserState(c.sub);
    if (state?.disabled) throw unauthorized('account disabled');
    if (state && c.iat < state.minIat) throw unauthorized('token revoked; sign in again');
    const role = roleFromGroups(c['cognito:groups']);
    if (!role) throw new HttpError(403, 'no_role', 'your account has no role assigned; ask an admin');
    const kind = (await this.o.clients())[c.client_id]!;
    let via: Via = kind;
    if (path === '/mcp') via = 'mcp';
    return { sub: c.sub, username: c.username ?? c.sub, role, clientId: c.client_id, via, issuedAt: c.iat };
  }
}
