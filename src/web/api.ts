import { accessToken, login } from './auth.js';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public body: any) {
    super(message);
  }
}

async function send(method: string, path: string, body?: BodyInit, contentType?: string, accept = 'application/json'): Promise<Response> {
  const go = async (token: string) =>
    fetch(path, {
      method,
      headers: { authorization: `Bearer ${token}`, accept, ...(contentType ? { 'content-type': contentType } : {}) },
      body,
    });
  let token = await accessToken();
  if (!token) return login();
  let r = await go(token);
  if (r.status === 401) {
    token = await accessToken(true);
    if (!token) return login();
    r = await go(token);
  }
  return r;
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await send(method, path, body === undefined ? undefined : JSON.stringify(body), body === undefined ? undefined : 'application/json');
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = j?.error ?? {};
    const extra = Array.isArray(e.errors) ? `: ${e.errors.join('; ')}` : '';
    throw new ApiError(r.status, e.code ?? 'error', (e.message ?? r.statusText) + extra, j);
  }
  return j as T;
}

export async function apiBlob(method: string, path: string, body?: Blob, contentType?: string): Promise<{ ok: boolean; status: number; blob: Blob; json?: any }> {
  const r = await send(method, path, body, contentType, '*/*');
  const isJson = r.headers.get('content-type')?.startsWith('application/json');
  if (isJson) return { ok: r.ok, status: r.status, blob: new Blob(), json: await r.json() };
  return { ok: r.ok, status: r.status, blob: await r.blob() };
}
