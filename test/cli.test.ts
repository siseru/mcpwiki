// End-to-end: the built CLI (dist/cli/mcpwiki.mjs) against a local HTTP server running the real app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { CLI, makeToken, setup, users } from './helpers.js';

const cliPath = join(process.cwd(), 'dist/cli/mcpwiki.mjs');
const isWindows = process.platform === 'win32';

test('CLI commands and MCP stdio bridge', { skip: !existsSync(cliPath) && 'run npm run build first' }, async () => {
  const { app, blobs } = setup();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const u = new URL(req.url ?? '/', 'http://localhost');
    // Fake S3: presigned POST (multipart form) and presigned GET.
    if (u.pathname.startsWith('/s3/')) {
      if (req.method === 'POST') {
        const form = await new Request('http://s3', { method: 'POST', headers: req.headers as Record<string, string>, body: Buffer.concat(chunks) }).formData();
        const file = form.get('file') as Blob;
        if (Number(form.get('maxBytes')) < file.size) {
          res.writeHead(400);
          return res.end('EntityTooLarge');
        }
        blobs.put(String(form.get('key')), Buffer.from(await file.arrayBuffer()));
        res.writeHead(204);
        return res.end();
      }
      const data = blobs.objects.get(decodeURIComponent(u.pathname.slice(4)));
      res.writeHead(data ? 200 : 404, { 'content-type': u.searchParams.get('type') ?? 'application/octet-stream' });
      return res.end(data ?? '');
    }
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
  blobs.baseUrl = `${url}/s3`;
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
    // Without XDG_CONFIG_HOME the config goes to the platform's own directory: %APPDATA% on Windows
    // (which has no XDG convention), ~/.config elsewhere.
    const altHome = mkdtempSync(join(tmpdir(), 'mcpwiki-home-'));
    const alt = await runWith({ XDG_CONFIG_HOME: '', ...(isWindows ? { APPDATA: altHome } : { HOME: altHome }) }, 'configure', '--env', 'alt', '--url', url);
    assert.equal(alt.code, 0, alt.stderr);
    assert.ok(existsSync(join(altHome, isWindows ? 'mcpwiki' : '.config/mcpwiki', 'config.json')), alt.stdout);
    assert.match((await run('list')).stderr, /not signed in/);
    const token = makeToken({ sub: users.alice.sub, username: 'alice', 'cognito:groups': ['editor'], client_id: CLI });
    writeFileSync(join(home, 'mcpwiki/credentials.json'), JSON.stringify({ local: { accessToken: token, expiresAt: Date.now() + 3600_000 } }));

    assert.match((await run('whoami')).stdout, /alice \(editor\)/);
    const doc = join(home, 'doc.md');
    writeFileSync(doc, '---\ntitle: CLI記事\ntags: [cli, test]\ndescription: from a file\n---\n\n本文です。[link](/wiki/other)\n');
    const c = await run('create', '--file', doc, '--id', 'cli-doc');
    assert.equal(c.code, 0, c.stderr);
    assert.match(c.stdout, /created cli-doc \(version 1\)/);
    // A document written by a Windows editor (BOM + CRLF) must parse like any other.
    const crlf = join(home, 'crlf.md');
    writeFileSync(crlf, '\uFEFF---\r\ntitle: CRLF記事\r\ntags: [crlf]\r\n---\r\n\r\n本文です。\r\n');
    const c2 = await run('create', '--file', crlf, '--id', 'cli-crlf');
    assert.equal(c2.code, 0, c2.stderr);
    assert.match((await run('get', 'cli-crlf')).stdout, /^---\ntype: Wiki Article\ntitle: CRLF記事\n/);
    const list = await run('list');
    assert.match(list.stdout, /cli-doc\s+1 .*CLI記事 {2}\[cli, test\]/);
    const get = await run('get', 'cli-doc');
    assert.match(get.stdout, /^---\ntype: Wiki Article\ntitle: CLI記事\n/);
    const edit = await run('edit', 'cli-doc', '--title', 'Renamed');
    assert.equal(edit.code, 0, edit.stderr);
    assert.match(edit.stdout, /version 2/);
    // edit via EDITOR: a script that appends a line. On Windows that is a .cmd shim, which the CLI has to
    // start through cmd.exe (Node refuses to spawn .cmd directly since 20.12). It appends by copying a
    // UTF-8 file rather than with `echo`, whose output depends on the console code page.
    const editor = join(home, isWindows ? 'ed.cmd' : 'ed.sh');
    writeFileSync(join(home, 'append.md'), '\n追記\n');
    writeFileSync(editor, isWindows ? `@echo off\r\ntype "${join(home, 'append.md')}" >>%1\r\n` : '#!/bin/sh\necho "追記" >> "$1"\n', { mode: 0o755 });
    // (must be async: the server runs in this process)
    const ed = await runWith({ EDITOR: editor }, 'edit', 'cli-doc');
    assert.equal(ed.code, 0, ed.stderr);
    assert.match((await run('get', 'cli-doc', '--json')).stdout, /追記/);
    // $EDITOR may be a quoted path containing spaces ("C:\Program Files\...\notepad++.exe" is the norm
    // on Windows), and a missing editor must say so rather than "exited with status null".
    const spaced = join(home, 'my editor', isWindows ? 'ed.cmd' : 'ed.sh');
    mkdirSync(join(home, 'my editor'));
    copyFileSync(editor, spaced);
    const ed2 = await runWith({ EDITOR: `"${spaced}"` }, 'edit', 'cli-doc');
    assert.equal(ed2.code, 0, ed2.stderr);
    const noEditor = await runWith({ EDITOR: 'mcpwiki-no-such-editor' }, 'edit', 'cli-doc');
    assert.match(noEditor.stderr, /cannot start editor "mcpwiki-no-such-editor" \(ENOENT\)/);
    // Plain status 1, not 0xC0000409: on Windows, process.exit() after stdin has been read or inherited
    // aborts with a libuv assertion.
    assert.equal(noEditor.code, 1, noEditor.stderr);
    if (isWindows) {
      // A .cmd editor is started through cmd.exe, so nothing on that command line may carry a character
      // that could end the command. An `&` in a flag must be refused, not passed to the shell.
      const meta = await runWith({ EDITOR: `"${editor}" a&b` }, 'edit', 'cli-doc');
      assert.match(meta.stderr, /contains a shell metacharacter/);
      assert.equal(meta.code, 1, meta.stderr);
    }
    assert.match((await run('search', '本文')).stdout, /cli-doc {2}Renamed/);
    assert.match((await run('tags')).stdout, /1\s+cli/);
    assert.match((await run('history', 'cli-doc')).stdout, /3 .*alice\s+cli\s+update/);
    assert.match((await run('delete', 'cli-doc')).stderr, /only possible from the web UI/);
    // attachments
    const png = join(home, 'shot.png');
    writeFileSync(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]));
    const att = await run('attach', 'cli-doc', png);
    assert.equal(att.code, 0, att.stderr);
    const md = /!\[shot\.png\]\(\/wiki\/cli-doc\/files\/([a-z0-9]{12})\)/.exec(att.stdout);
    assert.ok(md, att.stdout);
    const fake = join(home, 'fake.png');
    writeFileSync(fake, '<html>not a png</html>');
    assert.match((await run('attach', 'cli-doc', fake)).stderr, /does not look like image\/png/);
    assert.match((await run('attach', 'cli-doc', editor)).stderr, /unsupported file type/);
    assert.match((await run('attachments', 'cli-doc')).stdout, new RegExp(`${md![1]}\\s+72\\s+image/png\\s+shot\\.png`));
    const outFile = join(home, 'dl.png');
    assert.equal((await run('download', 'cli-doc', md![1]!, '--out', outFile)).code, 0);
    assert.deepEqual(readFileSync(outFile), readFileSync(png));
    assert.match((await run('download', 'cli-doc', md![1]!, '--out', outFile)).stderr, /exists/);
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
