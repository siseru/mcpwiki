// OAuth 2.0 Authorization Code + PKCE against Cognito managed login.
// Tokens live in sessionStorage (per tab); CSP blocks third-party script.
import type { PublicConfig } from '../shared/types.js';

interface Tokens {
  access: string;
  refresh?: string;
  expiresAt: number;
}

const OAUTH_ERRORS = new Set(['invalid_request', 'unauthorized_client', 'access_denied', 'unsupported_response_type', 'invalid_scope', 'server_error', 'temporarily_unavailable', 'invalid_grant']);
const KEY = 'mcpwiki.tokens';
const PKCE = 'mcpwiki.pkce';
let cfg: PublicConfig;

export async function loadConfig(): Promise<PublicConfig> {
  const r = await fetch('/config.json', { cache: 'no-store' });
  cfg = (await r.json()) as PublicConfig;
  return cfg;
}

const redirectUri = () => `${location.origin}/callback`;

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function random(n: number): string {
  return b64url(crypto.getRandomValues(new Uint8Array(n)));
}

function save(t: Tokens | null) {
  if (t) sessionStorage.setItem(KEY, JSON.stringify(t));
  else sessionStorage.removeItem(KEY);
}

function load(): Tokens | null {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as Tokens | null;
  } catch {
    return null;
  }
}

export async function login(): Promise<never> {
  const verifier = random(32);
  const state = random(16);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  sessionStorage.setItem(PKCE, JSON.stringify({ verifier, state, returnTo: location.pathname + location.search }));
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.webClientId,
    redirect_uri: redirectUri(),
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  location.assign(`${cfg.cognitoDomain}/oauth2/authorize?${q}`);
  return new Promise<never>(() => undefined);
}

async function tokenRequest(params: Record<string, string>): Promise<Tokens> {
  const r = await fetch(`${cfg.cognitoDomain}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.webClientId, ...params }),
  });
  if (!r.ok) throw new Error(`token endpoint returned ${r.status}`);
  const j = await r.json();
  return { access: j.access_token, refresh: j.refresh_token ?? params.refresh_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 };
}

/** Completes the redirect from Cognito. Returns the path to continue to, or null if not a callback. */
export async function handleCallback(): Promise<string | null> {
  if (location.pathname !== '/callback') return null;
  const q = new URLSearchParams(location.search);
  const pkce = JSON.parse(sessionStorage.getItem(PKCE) ?? 'null') as { verifier: string; state: string; returnTo: string } | null;
  sessionStorage.removeItem(PKCE);
  if (!pkce || q.get('state') !== pkce.state) throw new Error('login state mismatch; please try again');
  const err = q.get('error');
  // Never echo URL content back to the user (it is attacker-controllable); map to known OAuth codes.
  if (err) throw new Error(`login failed: ${OAUTH_ERRORS.has(err) ? err : 'unknown_error'}`);
  const code = q.get('code');
  if (!code) throw new Error('missing authorization code');
  save(await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: pkce.verifier }));
  const returnTo = pkce.returnTo.startsWith('/') && !pkce.returnTo.startsWith('//') && !pkce.returnTo.startsWith('/callback') ? pkce.returnTo : '/';
  history.replaceState(null, '', returnTo);
  return returnTo;
}

let refreshing: Promise<string | null> | null = null;

export async function accessToken(force = false): Promise<string | null> {
  const t = load();
  if (!t) return null;
  if (!force && t.expiresAt - Date.now() > 60_000) return t.access;
  if (!t.refresh) return null;
  refreshing ??= tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh })
    .then((n) => (save(n), n.access))
    .catch(() => (save(null), null))
    .finally(() => (refreshing = null));
  return refreshing;
}

export function isSignedIn(): boolean {
  return !!load();
}

export async function logout(): Promise<never> {
  const t = load();
  save(null);
  if (t?.refresh) {
    await fetch(`${cfg.cognitoDomain}/oauth2/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: t.refresh, client_id: cfg.webClientId }),
    }).catch(() => undefined);
  }
  location.assign(`${cfg.cognitoDomain}/logout?${new URLSearchParams({ client_id: cfg.webClientId, logout_uri: `${location.origin}/` })}`);
  return new Promise<never>(() => undefined);
}
