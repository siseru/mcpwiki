// End-to-end: the built CLI (dist/cli/mcpwiki.mjs) against a local HTTP server running the real app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { CLI, makeToken, setup, users } from './helpers.js';

const cliPath = join(process.cwd(), 'dist/cli/mcpwiki.mjs');

test('CLI commands and MCP stdio bridge', { skip: !existsSync(cliPath) && 'run npm run build first' }, async () => {
  const { app } = setup();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const u = new URL(req.url ?? '/', 'http://localhost');
    if (u.pathname === '/config.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ env: 'test', cognitoDomain: 'http://127.0.0.1:9', cliClientId: CLI, cliRedirectUri: 'http://localhost:53682/callback' }));
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
    const r = await app({ method: req.method!, path: u.pathname, query: Object.fromEntries(u.searchParams), headers, body: chunks.length ? Buffer.concat(chunks) : null });
    res.writeHead(r.status, r.headers);
    res.end(r.body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const home = mkdtempSync(join(tmpdir(), 'mcpwiki-cli-'));
  const env = { ...process.env, XDG_CONFIG_HOME: home, MCPWIKI_ENV: '' };
  const runWith = (extraEnv: Record<string, string>, ...args: string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const p = spawn(process.execPath, [cliPath, ...args], { env: { ...env, ...extraEnv } });
      let stdout = '';
      let stderr = '';
      p.stdout.on('data', (d) => (stdout += d));
      p.stderr.on('data', (d) => (stderr += d));
      p.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  const run = (...args: string[]) => runWith({}, ...args);
  try {
    assert.equal((await run('configure', '--env', 'local', '--url', url)).code, 0);
    assert.match((await run('list')).stderr, /not signed in/);
    const token = makeToken({ sub: users.alice.sub, username: 'alice', 'cognito:groups': ['editor'], client_id: CLI });
    writeFileSync(join(home, 'mcpwiki/credentials.json'), JSON.stringify({ local: { accessToken: token, expiresAt: Date.now() + 3600_000 } }));

    assert.match((await run('whoami')).stdout, /alice \(editor\)/);
    const doc = join(home, 'doc.md');
    writeFileSync(doc, '---\ntitle: CLI記事\ntags: [cli, test]\ndescription: from a file\n---\n\n本文です。[link](/wiki/other)\n');
    const c = await run('create', '--file', doc, '--id', 'cli-doc');
    assert.equal(c.code, 0, c.stderr);
    assert.match(c.stdout, /created cli-doc \(version 1\)/);
    const list = await run('list');
    assert.match(list.stdout, /cli-doc\s+1 .*CLI記事 {2}\[cli, test\]/);
    const get = await run('get', 'cli-doc');
    assert.match(get.stdout, /^---\ntype: Wiki Article\ntitle: CLI記事\n/);
    const edit = await run('edit', 'cli-doc', '--title', 'Renamed');
    assert.equal(edit.code, 0, edit.stderr);
    assert.match(edit.stdout, /version 2/);
    // edit via EDITOR: a script that appends a line
    const editor = join(home, 'ed.sh');
    writeFileSync(editor, '#!/bin/sh\necho "追記" >> "$1"\n', { mode: 0o755 });
    // (must be async: the server runs in this process)
    const ed = await runWith({ EDITOR: editor }, 'edit', 'cli-doc');
    assert.equal(ed.code, 0, ed.stderr);
    assert.match((await run('get', 'cli-doc', '--json')).stdout, /追記/);
    assert.match((await run('search', '本文')).stdout, /cli-doc {2}Renamed/);
    assert.match((await run('tags')).stdout, /1\s+cli/);
    assert.match((await run('history', 'cli-doc')).stdout, /3 .*alice\s+cli\s+update/);
    assert.match((await run('delete', 'cli-doc')).stderr, /only possible from the web UI/);
    const exp = await run('export', '--out', join(home, 'b.zip'));
    assert.equal(exp.code, 0, exp.stderr);

    // MCP over stdio
    const p = spawn(process.execPath, [cliPath, 'mcp'], { env });
    const lines: any[] = [];
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        lines.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
    });
    const send = (m: unknown) => p.stdin.write(JSON.stringify(m) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_articles', arguments: { query: '本文' } } });
    p.stdin.write('not json\n');
    await new Promise((r) => setTimeout(r, 1500));
    p.stdin.end();
    await new Promise((r) => p.on('close', r));
    const byId = new Map(lines.map((l) => [l.id, l]));
    assert.equal(byId.get(1).result.serverInfo.name, 'mcpwiki');
    assert.equal(byId.get(2).result.structuredContent.results[0].id, 'cli-doc');
    assert.equal(byId.get(null).error.code, -32700);
    assert.equal(lines.length, 3, 'notification produced no output');
  } finally {
    server.close();
  }
});
