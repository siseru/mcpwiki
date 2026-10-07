// mcpwiki — command-line client and MCP stdio bridge. Zero runtime dependencies.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { PublicConfig } from '../shared/types.js';
import { okfToArticleFields, parseOkfDocument } from '../shared/okf.js';

const VERSION = '0.1.0';

// ------------------------------------------------------------------ config

interface EnvConfig {
  url: string;
}
interface ConfigFile {
  defaultEnv?: string;
  envs: Record<string, EnvConfig>;
}
interface Credentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // epoch ms
  username?: string;
}

const configDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'mcpwiki');
const configPath = join(configDir, 'config.json');
const credPath = join(configDir, 'credentials.json');

function ensureDir() {
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true, mode: 0o700 });
  chmodSync(configDir, 0o700);
}

function readJson<T>(path: string, def: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return def;
  }
}

function writeSecret(path: string, data: unknown) {
  ensureDir();
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}

const loadConfig = () => readJson<ConfigFile>(configPath, { envs: {} });
const loadCreds = () => readJson<Record<string, Credentials>>(credPath, {});

class CliError extends Error {}

function envName(flags: Flags): string {
  const cfg = loadConfig();
  const name = (flags.env as string) || process.env.MCPWIKI_ENV || cfg.defaultEnv || Object.keys(cfg.envs)[0];
  if (!name) throw new CliError('no environment configured; run: mcpwiki configure --env dev --url https://<your-wiki>');
  if (!cfg.envs[name]) throw new CliError(`unknown environment "${name}"; run: mcpwiki configure --env ${name} --url https://<your-wiki>`);
  return name;
}

// ------------------------------------------------------------------ args

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { cmd: string; args: string[]; flags: Flags } {
  const flags: Flags = {};
  const args: string[] = [];
  const booleans = new Set(['json', 'mine', 'no-browser', 'tags', 'raw', 'help', 'default', 'force']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      args.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) flags[key] = a.slice(eq + 1);
      else if (booleans.has(key)) flags[key] = true;
      else {
        const v = argv[++i];
        if (v === undefined) throw new CliError(`--${key} needs a value`);
        flags[key] = v;
      }
    } else if (a === '-h') flags.help = true;
    else args.push(a);
  }
  return { cmd: args.shift() ?? 'help', args, flags };
}

// ------------------------------------------------------------------ auth

const b64url = (b: Buffer) => b.toString('base64url');

async function fetchPublicConfig(url: string): Promise<PublicConfig> {
  const r = await fetch(`${url}/config.json`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new CliError(`cannot fetch ${url}/config.json (${r.status})`);
  return (await r.json()) as PublicConfig;
}

async function tokenRequest(cfg: PublicConfig, params: Record<string, string>): Promise<Credentials> {
  const r = await fetch(`${cfg.cognitoDomain}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.cliClientId, ...params }),
    signal: AbortSignal.timeout(15000),
  });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new CliError(`token request failed: ${String(j.error ?? r.status)}`);
  const accessToken = String(j.access_token);
  let username: string | undefined;
  try {
    username = JSON.parse(Buffer.from(accessToken.split('.')[1]!, 'base64url').toString()).username;
  } catch {
    /* ignore */
  }
  return {
    accessToken,
    refreshToken: (j.refresh_token as string | undefined) ?? params.refresh_token,
    expiresAt: Date.now() + Number(j.expires_in ?? 3600) * 1000,
    username,
  };
}

function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    /* no browser available */
  }
}

async function login(flags: Flags) {
  const env = envName(flags);
  const { url } = loadConfig().envs[env]!;
  const cfg = await fetchPublicConfig(url);
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));
  const redirect = new URL(cfg.cliRedirectUri);
  const authUrl =
    `${cfg.cognitoDomain}/oauth2/authorize?` +
    new URLSearchParams({
      response_type: 'code',
      client_id: cfg.cliClientId,
      redirect_uri: cfg.cliRedirectUri,
      scope: 'openid email profile',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

  const servers: Server[] = [];
  const rl = createInterface({ input: process.stdin });
  const code = await new Promise<string>((resolve, reject) => {
    const accept = (u: URL): boolean => {
      if (u.searchParams.get('state') !== state) return false;
      const err = u.searchParams.get('error');
      if (err) reject(new CliError(`login failed: ${err}`));
      const c = u.searchParams.get('code');
      if (c) resolve(c);
      return !!c || !!err;
    };
    for (const host of ['127.0.0.1', '::1']) {
      const srv = createServer((req, res) => {
        const u = new URL(req.url ?? '/', `http://localhost:${redirect.port}`);
        const ok = u.pathname === redirect.pathname && accept(u);
        res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(ok ? 'MCPWiki: signed in. You can close this tab.\n' : 'Invalid request\n');
      });
      srv.on('error', () => undefined); // e.g. IPv6 unavailable
      srv.listen(Number(redirect.port), host);
      servers.push(srv);
    }
    process.stderr.write(`Open this URL in a browser and sign in (MFA required):\n\n  ${authUrl}\n\n`);
    process.stderr.write(
      `If the browser runs on another machine, the final page will fail to load; copy its full URL\n(starting with ${cfg.cliRedirectUri}) and paste it here:\n> `,
    );
    if (!flags['no-browser']) openBrowser(authUrl);
    rl.on('line', (line) => {
      try {
        if (!accept(new URL(line.trim()))) process.stderr.write('That URL does not match this login attempt.\n> ');
      } catch {
        process.stderr.write('Not a URL.\n> ');
      }
    });
    setTimeout(() => reject(new CliError('login timed out')), 10 * 60_000).unref();
  }).finally(() => {
    rl.close();
    for (const s of servers) s.close();
  });
  const creds = await tokenRequest(cfg, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.cliRedirectUri,
    code_verifier: verifier,
  });
  const all = loadCreds();
  all[env] = creds;
  writeSecret(credPath, all);
  process.stderr.write(`\nSigned in to ${env} as ${creds.username ?? 'unknown user'}.\n`);
  process.exit(0);
}

async function accessToken(env: string, force = false): Promise<string> {
  const all = loadCreds();
  const c = all[env];
  if (!c) throw new CliError(`not signed in to ${env}; run: mcpwiki login --env ${env}`);
  if (!force && c.expiresAt - Date.now() > 60_000) return c.accessToken;
  if (!c.refreshToken) throw new CliError(`session expired; run: mcpwiki login --env ${env}`);
  const cfg = await fetchPublicConfig(loadConfig().envs[env]!.url);
  try {
    all[env] = await tokenRequest(cfg, { grant_type: 'refresh_token', refresh_token: c.refreshToken });
  } catch {
    throw new CliError(`session expired; run: mcpwiki login --env ${env}`);
  }
  writeSecret(credPath, all);
  return all[env]!.accessToken;
}

// ------------------------------------------------------------------ http

async function api(env: string, method: string, path: string, body?: unknown, accept = 'application/json'): Promise<Response> {
  const url = loadConfig().envs[env]!.url + path;
  const send = async (token: string) =>
    fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, accept, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
  let r = await send(await accessToken(env));
  if (r.status === 401) r = await send(await accessToken(env, true));
  return r;
}

async function apiJson(env: string, method: string, path: string, body?: unknown): Promise<any> {
  const r = await api(env, method, path, body);
  const j = (await r.json().catch(() => ({}))) as any;
  if (!r.ok) {
    const e = j?.error ?? {};
    throw new CliError(`${r.status} ${e.code ?? ''}: ${e.message ?? r.statusText}${e.errors ? '\n  - ' + e.errors.join('\n  - ') : ''}`);
  }
  return j;
}

// ------------------------------------------------------------------ output

const out = (s: string) => process.stdout.write(s.endsWith('\n') ? s : s + '\n');
const printJson = (v: unknown) => out(JSON.stringify(v, null, 2));

function table(rows: string[][]) {
  if (!rows.length) return;
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => [...(r[i] ?? '')].length)));
  for (const r of rows) out(r.map((c, i) => (i === r.length - 1 ? c : c + ' '.repeat(widths[i]! - [...c].length))).join('  '));
}

function summaryRows(items: any[]): string[][] {
  return [
    ['ID', 'VER', 'UPDATED', 'STATUS', 'TITLE'],
    ...items.map((a) => [a.id, String(a.version), String(a.updatedAt).slice(0, 16).replace('T', ' '), a.status, `${a.title}${a.tags?.length ? `  [${a.tags.join(', ')}]` : ''}`]),
  ];
}

// ------------------------------------------------------------------ commands

function readInput(file: string | boolean | undefined): string {
  if (!file || file === true) throw new CliError('--file <path> (or - for stdin) is required');
  return readFileSync(file === '-' ? 0 : file, 'utf8');
}

function fieldsFromFlags(flags: Flags): Record<string, unknown> {
  const f: Record<string, unknown> = {};
  if (typeof flags.title === 'string') f.title = flags.title;
  if (typeof flags.description === 'string') f.description = flags.description;
  if (typeof flags.tags === 'string') f.tags = flags.tags.split(',').map((t) => t.trim()).filter(Boolean);
  if (typeof flags.status === 'string') f.status = flags.status;
  if (typeof flags['read-scope'] === 'string') f.readScope = flags['read-scope'];
  if (typeof flags['write-scope'] === 'string') f.writeScope = flags['write-scope'];
  if (typeof flags.id === 'string') f.id = flags.id;
  return f;
}

function fieldsFromDocument(text: string): Record<string, unknown> {
  const f = okfToArticleFields(parseOkfDocument(text));
  const r: Record<string, unknown> = { body: f.body };
  for (const k of ['type', 'title', 'description', 'tags', 'status', 'readScope', 'writeScope', 'id'] as const) if (f[k] !== undefined) r[k] = f[k];
  if (Object.keys(f.extra).length) r.extra = f.extra;
  return r;
}

const qs = (o: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== false && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

async function cmdList(env: string, flags: Flags) {
  const all: any[] = [];
  let cursor: string | undefined;
  const limit = Number(flags.limit ?? 50);
  do {
    const r = await apiJson(env, 'GET', `/api/articles${qs({ tag: flags.tag, mine: flags.mine ? '1' : undefined, limit: Math.min(200, limit - all.length), cursor })}`);
    all.push(...r.items);
    cursor = r.cursor;
  } while (cursor && all.length < limit);
  if (flags.json) return printJson(all);
  if (!all.length) return out('(no articles)');
  table(summaryRows(all));
}

async function cmdGet(env: string, id: string, flags: Flags) {
  if (!id) throw new CliError('usage: mcpwiki get <id> [--version N] [--json]');
  if (flags.json) return printJson(await apiJson(env, 'GET', `/api/articles/${encodeURIComponent(id)}${qs({ version: flags.version })}`));
  const r = await api(env, 'GET', `/api/articles/${encodeURIComponent(id)}${qs({ version: flags.version, format: 'okf' })}`, undefined, 'text/markdown');
  if (!r.ok) throw new CliError(`${r.status}: ${((await r.json().catch(() => ({}))) as any)?.error?.message ?? r.statusText}`);
  out(await r.text());
}

async function cmdSearch(env: string, words: string[], flags: Flags) {
  const q = words.join(' ');
  if (!q) throw new CliError('usage: mcpwiki search <query...> [--tag t] [--limit n]');
  const r = await apiJson(env, 'GET', `/api/search${qs({ q, tag: flags.tag, limit: flags.limit })}`);
  if (flags.json) return printJson(r.items);
  if (!r.items.length) return out('(no results)');
  for (const i of r.items) out(`${i.id}  ${i.title}${i.tags.length ? `  [${i.tags.join(', ')}]` : ''}\n    ${i.snippet}`);
}

async function cmdCreate(env: string, flags: Flags) {
  const body = flags.file ? fieldsFromDocument(readInput(flags.file)) : { body: '' };
  const input = { ...body, ...fieldsFromFlags(flags) };
  if (!input.title) throw new CliError('--title is required (or a title in the file frontmatter)');
  const r = await apiJson(env, 'POST', '/api/articles', input);
  if (flags.json) return printJson(r);
  out(`created ${r.id} (version ${r.version})`);
}

async function cmdEdit(env: string, id: string, flags: Flags) {
  if (!id) throw new CliError('usage: mcpwiki edit <id> [--file path|-] [--title ..] [--tags a,b]');
  const cur = await apiJson(env, 'GET', `/api/articles/${encodeURIComponent(id)}`);
  if (!cur.canEdit) throw new CliError('you do not have permission to edit this article');
  let fields: Record<string, unknown>;
  if (flags.file) {
    fields = fieldsFromDocument(readInput(flags.file));
  } else if (Object.keys(fieldsFromFlags(flags)).length) {
    fields = {};
  } else {
    const r = await api(env, 'GET', `/api/articles/${encodeURIComponent(id)}?format=okf`, undefined, 'text/markdown');
    const original = await r.text();
    const dir = mkdtempSync(join(tmpdir(), 'mcpwiki-'));
    const file = join(dir, `${id}.md`);
    try {
      writeFileSync(file, original, { mode: 0o600 });
      // "code --wait" style values are split on whitespace; no shell is involved.
      const [cmd, ...editorArgs] = (process.env.VISUAL || process.env.EDITOR || 'vi').trim().split(/\s+/);
      const res = spawnSync(cmd!, [...editorArgs, file], { stdio: 'inherit' });
      if (res.status !== 0) throw new CliError(`editor exited with status ${res.status}`);
      const edited = readFileSync(file, 'utf8');
      if (edited === original) return out('no changes');
      fields = fieldsFromDocument(edited);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  delete fields.id;
  const update = { ...fields, ...fieldsFromFlags(flags), version: cur.version };
  delete (update as Record<string, unknown>).id;
  const r = await apiJson(env, 'PUT', `/api/articles/${encodeURIComponent(id)}`, update);
  if (flags.json) return printJson(r);
  out(`updated ${r.id} (version ${r.version})`);
}

async function cmdTags(env: string, flags: Flags) {
  const r = await apiJson(env, 'GET', '/api/tags');
  if (flags.json) return printJson(r.items);
  table([['COUNT', 'TAG'], ...r.items.map((t: any) => [String(t.count), t.tag])]);
}

async function cmdGraph(env: string, id: string | undefined, flags: Flags) {
  const r = await apiJson(env, 'GET', `/api/graph${qs({ id, depth: flags.depth, tags: flags.tags ? '1' : undefined, limit: flags.limit })}`);
  if (flags.json) return printJson(r);
  const title = new Map<string, string>(r.nodes.map((n: any) => [n.id, n.title]));
  out(`${r.nodes.length} nodes, ${r.edges.length} edges${r.truncated ? ' (truncated)' : ''}`);
  for (const e of r.edges) {
    out(e.kind === 'link' ? `${e.from} (${title.get(e.from)}) -> ${e.to} (${title.get(e.to)})` : `${e.from} <-> ${e.to}  tags: ${e.tags.join(', ')}`);
  }
}

async function cmdBacklinks(env: string, id: string, flags: Flags) {
  if (!id) throw new CliError('usage: mcpwiki backlinks <id>');
  const r = await apiJson(env, 'GET', `/api/articles/${encodeURIComponent(id)}/backlinks`);
  if (flags.json) return printJson(r.items);
  if (!r.items.length) return out('(no backlinks)');
  table(summaryRows(r.items));
}

async function cmdHistory(env: string, id: string, flags: Flags) {
  if (!id) throw new CliError('usage: mcpwiki history <id>');
  const r = await apiJson(env, 'GET', `/api/articles/${encodeURIComponent(id)}/history`);
  if (flags.json) return printJson(r.items);
  table([['VER', 'UPDATED', 'BY', 'VIA', 'ACTION', 'TITLE'], ...r.items.map((h: any) => [String(h.version), h.updatedAt.slice(0, 16).replace('T', ' '), h.updatedBy, h.via, h.action, h.title])]);
}

// ------------------------------------------------------------------ attachments

const ATTACH_TYPES: Record<string, { type: string; magic: (b: Buffer) => boolean }> = {
  '.png': { type: 'image/png', magic: (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) },
  '.jpg': { type: 'image/jpeg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 },
  '.jpeg': { type: 'image/jpeg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 },
  '.gif': { type: 'image/gif', magic: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
  '.webp': { type: 'image/webp', magic: (b) => b.subarray(8, 12).toString('latin1') === 'WEBP' },
  '.pdf': { type: 'application/pdf', magic: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
};

async function cmdAttach(env: string, id: string, file: string, flags: Flags) {
  if (!id || !file) throw new CliError('usage: mcpwiki attach <article-id> <file> [--name display-name]');
  const kind = ATTACH_TYPES[extname(file).toLowerCase()];
  if (!kind) throw new CliError(`unsupported file type; allowed: ${Object.keys(ATTACH_TYPES).join(' ')}`);
  const data = readFileSync(file);
  if (!kind.magic(data)) throw new CliError(`${file} does not look like ${kind.type}`);
  const name = typeof flags.name === 'string' ? flags.name : basename(file);
  const req = await apiJson(env, 'POST', `/api/articles/${encodeURIComponent(id)}/attachments`, { name, contentType: kind.type, size: data.length });
  const form = new FormData();
  for (const [k, v] of Object.entries(req.upload.fields as Record<string, string>)) form.append(k, v);
  form.append('file', new Blob([data], { type: kind.type }), name); // must be the last field
  const up = await fetch(req.upload.url, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) });
  if (!up.ok) throw new CliError(`upload failed: HTTP ${up.status}`);
  const done = await apiJson(env, 'POST', `/api/articles/${encodeURIComponent(id)}/attachments/${req.fileId}/complete`);
  if (flags.json) return printJson(done);
  out(`attached ${done.name} (${done.size} bytes)\n${done.markdown}`);
}

async function cmdAttachments(env: string, id: string, flags: Flags) {
  if (!id) throw new CliError('usage: mcpwiki attachments <article-id>');
  const r = await apiJson(env, 'GET', `/api/articles/${encodeURIComponent(id)}/attachments`);
  if (flags.json) return printJson(r.items);
  if (!r.items.length) return out('(no attachments)');
  table([['FILE ID', 'SIZE', 'TYPE', 'NAME'], ...r.items.map((f: any) => [f.fileId, String(f.size), f.contentType, f.name])]);
}

async function cmdDownload(env: string, id: string, fileId: string, flags: Flags) {
  if (!id || !fileId) throw new CliError('usage: mcpwiki download <article-id> <file-id> [--out path] [--force]');
  const r = await apiJson(env, 'GET', `/api/articles/${encodeURIComponent(id)}/attachments/${encodeURIComponent(fileId)}/url`);
  // Never trust the server-provided name as a path: keep only a safe base name.
  const target = typeof flags.out === 'string' ? flags.out : basename(String(r.name)).replace(/[^\p{L}\p{N}._ -]+/gu, '_').replace(/^\.+/, '_') || fileId;
  const res = await fetch(r.url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new CliError(`download failed: HTTP ${res.status}`);
  try {
    // "wx": create atomically, fail if the path exists (no check-then-write race, no following a planted file).
    writeFileSync(target, Buffer.from(await res.arrayBuffer()), { flag: flags.force ? 'w' : 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new CliError(`${target} exists (use --force to overwrite)`);
    throw e;
  }
  out(`wrote ${target}`);
}

async function cmdExport(env: string, flags: Flags) {
  const file = typeof flags.out === 'string' ? flags.out : `mcpwiki-${env}-okf.zip`;
  const r = await api(env, 'GET', '/api/export', undefined, 'application/zip');
  if (!r.ok) throw new CliError(`${r.status}: ${((await r.json().catch(() => ({}))) as any)?.error?.message ?? r.statusText}`);
  writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  out(`wrote ${file}`);
}

/** MCP stdio <-> Streamable HTTP bridge. stdout carries protocol messages only. */
async function cmdMcp(env: string) {
  const url = loadConfig().envs[env]!.url + '/mcp';
  let protocolVersion: string | undefined;
  const write = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');
  const forward = async (line: string): Promise<void> => {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    const send = async (token: string) =>
      fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(protocolVersion && msg.method !== 'initialize' ? { 'mcp-protocol-version': protocolVersion } : {}),
        },
        body: line,
        signal: AbortSignal.timeout(60000),
      });
    try {
      let r = await send(await accessToken(env));
      if (r.status === 401) r = await send(await accessToken(env, true));
      if (r.status === 202 || r.status === 204) return;
      const text = await r.text();
      let body: any;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      if (body && (body.result || body.error)) {
        if (msg.method === 'initialize' && body.result?.protocolVersion) protocolVersion = body.result.protocolVersion;
        write(body);
        return;
      }
      const message = body?.error?.message ?? `HTTP ${r.status}`;
      if (msg.id !== undefined) write({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `mcpwiki: ${message}` } });
    } catch (e) {
      process.stderr.write(`mcpwiki mcp: ${(e as Error).message}\n`);
      if (msg.id !== undefined) write({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `mcpwiki: ${(e as Error).message}` } });
    }
  };
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    const p = forward(line).finally(() => pending.delete(p));
    pending.add(p);
  });
  await new Promise<void>((resolve) => rl.on('close', resolve));
  await Promise.all(pending);
}

const HELP = `mcpwiki ${VERSION} — MCPWiki command-line client

Usage: mcpwiki <command> [options]   (global: --env <name>, --json)

Setup
  configure --env <name> --url <https://wiki> [--default]   add/update an environment
  login [--no-browser]                                       sign in (browser, MFA)
  logout                                                     forget stored tokens
  whoami

Articles
  list [--tag t] [--mine] [--limit n]
  get <id> [--version n]                  print the OKF document (frontmatter + Markdown)
  search <query...> [--tag t] [--limit n]
  create --title T [--file path|-] [--tags a,b] [--description d] [--status draft|stable|deprecated]
         [--read-scope admin|owner|all] [--write-scope none|admin|owner|all] [--id slug]
  edit <id> [--file path|-] [--title ..] [--tags ..]   (no --file: opens $EDITOR on the OKF document)
  history <id>
  backlinks <id>
  tags
  graph [id] [--depth 1-3] [--tags]
  export [--out file.zip]                 OKF bundle of all articles you can read

Attachments (PNG / JPEG / GIF / WebP / PDF, up to 10 MB; access follows the article)
  attach <id> <file> [--name n]           upload; prints the Markdown snippet to paste into the article
  attachments <id>                        list
  download <id> <file-id> [--out path] [--force]

MCP
  mcp                                     stdio MCP server (bridges to the remote /mcp endpoint)
                                          e.g. claude mcp add mcpwiki -- mcpwiki mcp --env dev

Deleting articles is only possible from the web UI.`;

async function main() {
  const { cmd, args, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || cmd === 'help') return out(HELP);
  if (cmd === 'version' || cmd === '--version') return out(VERSION);
  if (cmd === 'configure') {
    const name = flags.env as string;
    const url = (flags.url as string | undefined)?.replace(/\/+$/, '');
    if (!name || !url) throw new CliError('usage: mcpwiki configure --env <name> --url <https://...>');
    if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url)) throw new CliError('url must use https');
    const cfg = loadConfig();
    cfg.envs[name] = { url };
    if (flags.default || !cfg.defaultEnv) cfg.defaultEnv = name;
    writeSecret(configPath, cfg);
    return out(`configured ${name} -> ${url}${cfg.defaultEnv === name ? ' (default)' : ''}`);
  }
  if (cmd === 'login') return login(flags);
  const env = envName(flags);
  switch (cmd) {
    case 'logout': {
      const all = loadCreds();
      delete all[env];
      writeSecret(credPath, all);
      return out(`signed out of ${env}`);
    }
    case 'whoami': {
      const r = await apiJson(env, 'GET', '/api/me');
      return flags.json ? printJson(r) : out(`${r.username} (${r.role}) @ ${env}`);
    }
    case 'list':
    case 'ls':
      return cmdList(env, flags);
    case 'get':
    case 'show':
      return cmdGet(env, args[0]!, flags);
    case 'search':
      return cmdSearch(env, args, flags);
    case 'create':
    case 'new':
      return cmdCreate(env, flags);
    case 'edit':
      return cmdEdit(env, args[0]!, flags);
    case 'tags':
      return cmdTags(env, flags);
    case 'graph':
      return cmdGraph(env, args[0], flags);
    case 'backlinks':
      return cmdBacklinks(env, args[0]!, flags);
    case 'history':
      return cmdHistory(env, args[0]!, flags);
    case 'attach':
      return cmdAttach(env, args[0]!, args[1]!, flags);
    case 'attachments':
      return cmdAttachments(env, args[0]!, flags);
    case 'download':
      return cmdDownload(env, args[0]!, args[1]!, flags);
    case 'export':
      return cmdExport(env, flags);
    case 'mcp':
      return cmdMcp(env);
    case 'delete':
    case 'rm':
      throw new CliError('deleting articles is only possible from the web UI');
    default:
      throw new CliError(`unknown command "${cmd}"; see mcpwiki help`);
  }
}

main().catch((e) => {
  process.stderr.write(`error: ${e instanceof CliError ? e.message : (e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
