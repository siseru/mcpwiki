// Regression tests for findings of the 2026-10 security review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLI, setup, users } from './helpers.js';
import { extractLinks, snippet, stripMarkdown } from '../src/shared/text.js';
import { parseYaml, stringifyYaml } from '../src/shared/yaml.js';
import type { JsonValue } from '../src/shared/types.js';

test('markdown helpers are linear on adversarial input (ReDoS)', () => {
  for (const evil of ['<'.repeat(250_000), '[\n'.repeat(120_000), '[a]('.repeat(60_000), '```\n'.repeat(60_000), '![x]('.repeat(50_000)]) {
    const t0 = Date.now();
    stripMarkdown(evil);
    extractLinks(evil);
    snippet(evil, 'a');
    assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0}ms on ${JSON.stringify(evil.slice(0, 6))}`);
  }
});

test('extra values that cannot round-trip are rejected and never break an article', async () => {
  const { call } = setup();
  for (const extra of [{ foo: { __proto__x: 1, ['__proto__']: 1 } }, { constructor: 1 }, { a: [{ prototype: 1 }] }]) {
    const raw = JSON.stringify({ title: 'P', body: 'x', extra }).replace('__proto__x', 'ok');
    const r = await call(users.alice, 'POST', '/api/articles', undefined, { raw: Buffer.from(raw), contentType: 'application/json' });
    assert.equal(r.status, 400, raw);
  }
  // quoted / numeric keys inside sequences now round-trip
  const ok = await call(users.alice, 'POST', '/api/articles', { id: 'steps', title: 'S', body: 'x', extra: { steps: [{ '1': 'a' }, { '': 'b' }, { 'a b': 'c' }] } });
  assert.equal(ok.status, 201);
  assert.deepEqual((await call(users.alice, 'GET', '/api/articles/steps')).json.extra, { steps: [{ '1': 'a' }, { '': 'b' }, { 'a b': 'c' }] });
});

test('yaml fuzz: serializer output always parses back', () => {
  const keys = ['a', '1', '', 'a b', '-x', 'true', 'k:v', '#', "'q'", 'ü', 'null'];
  const scalars: JsonValue[] = ['', 'x', '1', 'true', 'null', '- a', ': b', 'a #c', '"q"', "'s'", 'l\nm', 0, -1.5, true, null, '[x]', '{y}'];
  let seed = 7;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  const gen = (d: number): JsonValue => {
    const k = rnd(d > 2 ? 1 : 3);
    if (k === 0) return scalars[rnd(scalars.length)]!;
    if (k === 1) return Array.from({ length: rnd(4) }, () => gen(d + 1));
    return Object.fromEntries(Array.from({ length: rnd(4) }, () => [keys[rnd(keys.length)]!, gen(d + 1)]));
  };
  for (let i = 0; i < 2000; i++) {
    const v = { root: gen(0) } as Record<string, JsonValue>;
    assert.deepEqual(parseYaml(stringifyYaml(v)), v, JSON.stringify(v));
  }
});

test('CLI/API tokens cannot widen permissions either', async () => {
  const { call } = setup();
  await call(users.alice, 'POST', '/api/articles', { id: 'priv', title: 'P', body: 'x', readScope: 'owner', writeScope: 'owner' });
  const r = await call(users.alice, 'PUT', '/api/articles/priv', { version: 1, readScope: 'all' }, { client: CLI });
  assert.equal(r.status, 403);
  assert.equal((await call(users.alice, 'PUT', '/api/articles/priv', { version: 1, readScope: 'all' })).status, 200, 'web may widen');
});

test('search is not an oracle for unreadable content', async () => {
  const { call } = setup();
  await call(users.bob, 'POST', '/api/articles', { id: 'bob-notes', title: 'falcon notes', body: 'falcon initech' });
  await call(users.alice, 'POST', '/api/articles', { id: 'secret', title: 'x', body: 'falcon globex', readScope: 'owner' });
  const s = async (q: string) => (await call(users.bob, 'GET', `/api/search?q=${q}`)).json.items.map((i: any) => i.id);
  // Bob sees the same answer whether or not a hidden article fully matches.
  assert.deepEqual(await s('falcon%20globex'), await s('falcon%20zzzzunknown'));
});

test('old revisions written under a narrower scope stay hidden', async () => {
  const { call } = setup();
  await call(users.alice, 'POST', '/api/articles', { id: 'doc', title: 'Salary', body: 'SECRET', readScope: 'owner' });
  await call(users.alice, 'PUT', '/api/articles/doc', { version: 1, title: 'Clean', body: 'public', readScope: 'all' });
  assert.equal((await call(users.bob, 'GET', '/api/articles/doc?version=1')).status, 404);
  assert.deepEqual((await call(users.bob, 'GET', '/api/articles/doc/history')).json.items.map((h: any) => h.version), [2]);
  assert.equal((await call(users.alice, 'GET', '/api/articles/doc?version=1')).json.body, 'SECRET');
});

test('chosen id collision does not touch the existing object', async () => {
  const { call, store } = setup();
  await call(users.alice, 'POST', '/api/articles', { id: 'plan', title: 'P', body: 'x', readScope: 'owner' });
  const before = store.bodies.get('plan')!.length;
  const r = await call(users.bob, 'POST', '/api/articles', { id: 'plan', title: 'mine', body: 'overwrite' });
  assert.equal(r.status, 409);
  assert.doesNotMatch(r.json.error.message, /exists/);
  assert.equal(store.bodies.get('plan')!.length, before);
});

test('verify needs edit permission; reindex is web-only', async () => {
  const { call } = setup();
  await call(users.alice, 'POST', '/api/articles', { id: 'ro', title: 'R', body: 'x', writeScope: 'none' });
  assert.equal((await call(users.bob, 'POST', '/api/articles/ro/verify')).status, 403);
  assert.equal((await call(users.admin, 'POST', '/api/admin/reindex', {}, { client: CLI })).status, 403);
  assert.equal((await call(users.admin, 'POST', '/api/admin/reindex', {})).status, 200);
});

test('MCP writes count against the write rate limit', async () => {
  const { call } = setup({ rateLimit: { perMinute: 100, writesPerMinute: 1 } });
  const mk = (n: number) => ({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name: 'create_article', arguments: { title: `t${n}`, body: 'b' } } });
  assert.equal((await call(users.alice, 'POST', '/mcp', mk(1), { client: CLI })).status, 200);
  assert.equal((await call(users.alice, 'POST', '/mcp', mk(2), { client: CLI })).status, 429);
  assert.equal((await call(users.alice, 'POST', '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/list' }, { client: CLI })).status, 200);
});

test('list cursor is opaque and tamper-proof', async () => {
  const { call } = setup();
  for (let i = 0; i < 3; i++) await call(users.alice, 'POST', '/api/articles', { id: `c${i}`, title: `C${i}`, body: '' });
  const r = (await call(users.bob, 'GET', '/api/articles?limit=1')).json;
  assert.ok(r.cursor);
  assert.doesNotMatch(Buffer.from(r.cursor, 'base64url').toString('latin1'), /c\d|20\d\d-/);
  const forged = Buffer.from('2999-01-01T00:00:00.000Z#c0').toString('base64url');
  assert.equal((await call(users.bob, 'GET', `/api/articles?cursor=${forged}`)).status, 400);
});

test('titles reject bidi overrides and C1 controls; bad %-encoding is a 400', async () => {
  const { call } = setup();
  assert.equal((await call(users.alice, 'POST', '/api/articles', { title: 'abc‮txt.exe', body: '' })).status, 400);
  assert.equal((await call(users.alice, 'POST', '/api/articles', { title: 'a\u009bb', body: '' })).status, 400);
  assert.equal((await call(users.admin, 'PUT', '/api/admin/users/%E0%A4%A', { role: 'viewer' })).status, 400);
});
