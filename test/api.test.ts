import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { CLI, makeToken, setup, users } from './helpers.js';
import { readZip } from '../src/backend/zip.js';
import { parseOkfDocument } from '../src/shared/okf.js';

test('authentication failures', async () => {
  const { app, call } = setup();
  const r = await call(null, 'GET', '/api/articles');
  assert.equal(r.status, 401);
  assert.match(r.res.headers['www-authenticate']!, /resource_metadata="https:\/\/wiki\.example\.com\/\.well-known\/oauth-protected-resource"/);
  const bad = async (token: string) =>
    (await app({ method: 'GET', path: '/api/me', query: {}, headers: { authorization: `Bearer ${token}` }, body: null })).status;
  const now = Math.floor(Date.now() / 1000);
  assert.equal(await bad(makeToken({ sub: 'x', 'cognito:groups': ['admin'], exp: now - 3600 })), 401, 'expired');
  assert.equal(await bad(makeToken({ sub: 'x', 'cognito:groups': ['admin'], iss: 'https://evil' })), 401, 'issuer');
  assert.equal(await bad(makeToken({ sub: 'x', 'cognito:groups': ['admin'], token_use: 'id' })), 401, 'id token');
  assert.equal(await bad(makeToken({ sub: 'x', 'cognito:groups': ['admin'], client_id: 'other' })), 401, 'client');
  const { privateKey: other } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.equal(await bad(makeToken({ sub: 'x', 'cognito:groups': ['admin'] }, { key: other })), 401, 'signature');
  assert.equal(await bad(makeToken({ sub: 'x', 'cognito:groups': ['admin'] }, { kid: 'nope' })), 401, 'kid');
  const t = makeToken({ sub: 'x', 'cognito:groups': ['admin'] }).split('.');
  assert.equal(await bad(`${t[0]}.${Buffer.from(JSON.stringify({ sub: 'x', 'cognito:groups': ['admin'] })).toString('base64url')}.${t[2]}`), 401, 'tampered');
  assert.equal((await call(users.nobody, 'GET', '/api/me')).status, 403, 'no role');
  assert.equal((await call(null, 'GET', '/api/health')).status, 200);
});

test('origin secret is enforced', async () => {
  const { call } = setup({ originSecret: 's3cret' });
  assert.equal((await call(users.admin, 'GET', '/api/me')).status, 403);
  assert.equal((await call(users.admin, 'GET', '/api/me', undefined, { headers: { 'x-origin-verify': 's3cret' } })).status, 200);
});

test('create, read, update with optimistic locking, history', async () => {
  const { call } = setup();
  const c = await call(users.alice, 'POST', '/api/articles', { id: 'intro', title: 'Intro', body: '# Hello\nSee [x](/wiki/other)', tags: ['Guide'] });
  assert.equal(c.status, 201);
  assert.equal(c.json.version, 1);
  assert.equal((await call(users.vic, 'POST', '/api/articles', { title: 'x', body: '' })).status, 403, 'viewer cannot create');
  assert.equal((await call(users.alice, 'POST', '/api/articles', { id: 'intro', title: 'dup', body: '' })).status, 409);

  const g = await call(users.bob, 'GET', '/api/articles/intro');
  assert.equal(g.status, 200);
  assert.equal(g.json.body, '# Hello\nSee [x](/wiki/other)');
  assert.equal(g.json.canEdit, false, 'default writeScope=owner');
  assert.equal(g.json.owner, undefined, 'owner sub is not exposed');
  assert.deepEqual(g.json.links, ['other']);

  assert.equal((await call(users.bob, 'PUT', '/api/articles/intro', { version: 1, title: 'x' })).status, 403);
  assert.equal((await call(users.alice, 'PUT', '/api/articles/intro', { title: 'x' })).status, 400, 'version required');
  const u = await call(users.alice, 'PUT', '/api/articles/intro', { version: 1, body: 'v2', writeScope: 'all' });
  assert.equal(u.status, 200);
  assert.equal(u.json.version, 2);
  const stale = await call(users.bob, 'PUT', '/api/articles/intro', { version: 1, body: 'stale' });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error.currentVersion, 2);
  assert.equal((await call(users.bob, 'PUT', '/api/articles/intro', { version: 2, body: 'by bob' })).status, 200);

  const okf = await call(users.alice, 'GET', '/api/articles/intro?format=okf');
  const doc = parseOkfDocument(okf.res.body as string);
  assert.equal(doc.frontmatter.type, 'Wiki Article');
  assert.deepEqual(doc.frontmatter.generated, { by: 'human:bob', at: (doc.frontmatter.generated as any).at });
  assert.equal(doc.body, 'by bob');

  const h = await call(users.alice, 'GET', '/api/articles/intro/history');
  assert.deepEqual(h.json.items.map((e: any) => [e.version, e.updatedBy, e.action]), [[3, 'bob', 'update'], [2, 'alice', 'update'], [1, 'alice', 'create']]);
  const v1 = await call(users.alice, 'GET', '/api/articles/intro?version=1');
  assert.equal(v1.json.body, '# Hello\nSee [x](/wiki/other)');
  assert.equal(v1.json.canEdit, false);
});

test('permission scopes: invisible articles look missing', async () => {
  const { call } = setup();
  await call(users.alice, 'POST', '/api/articles', { id: 'secret', title: 'Secret', body: 'xyzzy', readScope: 'owner' });
  await call(users.admin, 'POST', '/api/articles', { id: 'adm', title: 'Admin only', body: 'plugh', readScope: 'admin' });
  assert.equal((await call(users.bob, 'GET', '/api/articles/secret')).status, 404);
  assert.equal((await call(users.vic, 'GET', '/api/articles/adm')).status, 404);
  assert.equal((await call(users.alice, 'GET', '/api/articles/adm')).status, 404);
  assert.equal((await call(users.admin, 'GET', '/api/articles/secret')).status, 200);
  assert.deepEqual((await call(users.bob, 'GET', '/api/articles')).json.items, []);
  assert.deepEqual((await call(users.bob, 'GET', '/api/search?q=xyzzy')).json.items, []);
  assert.deepEqual((await call(users.bob, 'GET', '/api/tags')).json.items, []);
  assert.equal((await call(users.alice, 'GET', '/api/search?q=xyzzy')).json.items.length, 1);
  // write wider than read is rejected
  assert.equal((await call(users.alice, 'POST', '/api/articles', { title: 'x', readScope: 'owner', writeScope: 'all' })).status, 400);
  // only owner/admin may change permissions
  await call(users.alice, 'POST', '/api/articles', { id: 'open', title: 'Open', body: '', writeScope: 'all' });
  assert.equal((await call(users.bob, 'PUT', '/api/articles/open', { version: 1, readScope: 'owner', writeScope: 'owner' })).status, 403);
  assert.equal((await call(users.bob, 'PUT', '/api/articles/open', { version: 1, body: 'edit ok' })).status, 200);
  // read-only
  await call(users.alice, 'POST', '/api/articles', { id: 'ro', title: 'RO', body: '', writeScope: 'none' });
  assert.equal((await call(users.alice, 'PUT', '/api/articles/ro', { version: 1, body: 'x' })).status, 403);
  assert.equal((await call(users.admin, 'PUT', '/api/articles/ro', { version: 1, body: 'x' })).status, 200);
});

test('delete / restore / verify / admin endpoints are web-only', async () => {
  const { call } = setup();
  await call(users.alice, 'POST', '/api/articles', { id: 'd', title: 'D', body: 'b' });
  assert.equal((await call(users.alice, 'DELETE', '/api/articles/d', undefined, { client: CLI })).status, 403);
  assert.equal((await call(users.bob, 'DELETE', '/api/articles/d')).status, 403);
  assert.equal((await call(users.alice, 'POST', '/api/articles/d/verify', undefined, { client: CLI })).status, 403);
  const v = await call(users.bob, 'POST', '/api/articles/d/verify');
  assert.equal(v.status, 200);
  const okf = parseOkfDocument((await call(users.bob, 'GET', '/api/articles/d?format=okf')).res.body as string);
  assert.deepEqual((okf.frontmatter.verified as any[]).map((x) => x.by), ['human:bob']);
  assert.equal((await call(users.alice, 'DELETE', '/api/articles/d')).status, 200);
  assert.equal((await call(users.alice, 'GET', '/api/articles/d')).status, 404);
  assert.equal((await call(users.admin, 'GET', '/api/admin/articles?deleted=1')).json.items.length, 1);
  assert.equal((await call(users.alice, 'POST', '/api/articles/d/restore')).status, 403);
  assert.equal((await call(users.admin, 'POST', '/api/articles/d/restore', undefined, { client: CLI })).status, 403);
  assert.equal((await call(users.admin, 'POST', '/api/articles/d/restore')).status, 200);
  assert.equal((await call(users.alice, 'GET', '/api/articles/d')).status, 200);
  assert.equal((await call(users.admin, 'GET', '/api/admin/users', undefined, { client: CLI })).status, 403);
  assert.equal((await call(users.alice, 'GET', '/api/admin/users')).status, 403);
  const audit = await call(users.admin, 'GET', '/api/admin/audit');
  assert.ok(audit.json.items.some((e: any) => e.action === 'delete' && e.articleId === 'd'));
});

test('user administration revokes old tokens', async () => {
  const { call, dir, store } = setup();
  const inv = await call(users.admin, 'POST', '/api/admin/users', { username: 'carol', email: 'carol@example.com', role: 'viewer' });
  assert.equal(inv.status, 201);
  assert.equal((await call(users.admin, 'POST', '/api/admin/users', { username: 'carol', email: 'c@example.com', role: 'viewer' })).status, 409);
  assert.equal((await call(users.admin, 'POST', '/api/admin/users', { username: 'x', email: 'bad', role: 'viewer' })).status, 400);
  const carol = { sub: 'sub-carol', username: 'carol', groups: ['viewer'] };
  assert.equal((await call(carol, 'GET', '/api/me')).status, 200);
  await new Promise((r) => setTimeout(r, 1100));
  const up = await call(users.admin, 'PUT', '/api/admin/users/carol', { role: 'editor' });
  assert.equal(up.status, 200);
  assert.equal(dir.users.get('carol')!.role, 'editor');
  assert.ok((await store.getUserState('sub-carol'))!.minIat > 0);
  // token issued before the change is now rejected (iat < minIat)
  const old = { ...carol };
  const st = await store.getUserState('sub-carol');
  await store.putUserState('sub-carol', { ...st!, minIat: Math.floor(Date.now() / 1000) + 5 });
  assert.equal((await call(old, 'GET', '/api/me')).status, 401);
  await call(users.admin, 'PUT', '/api/admin/users/carol', { enabled: false });
  assert.equal((await store.getUserState('sub-carol'))!.disabled, true);
  assert.equal((await call(users.admin, 'PUT', '/api/admin/users/admin', { role: 'viewer' })).status, 404); // admin not in directory
});

test('search: japanese bigrams, AND, tags, fallback', async () => {
  const { call } = setup();
  await call(users.alice, 'POST', '/api/articles', { id: 'tokyo', title: '東京タワーの歴史', body: '東京タワーは1958年に完成した電波塔です。', tags: ['観光'] });
  await call(users.alice, 'POST', '/api/articles', { id: 'kyoto', title: '京都の寺', body: '金閣寺と銀閣寺について。', tags: ['観光', '歴史'] });
  await call(users.alice, 'POST', '/api/articles', { id: 'aws', title: 'AWS Lambda tips', body: 'Use arm64 for cost. Lambda cold start.', tags: ['aws'] });
  const s = async (q: string, extra = '') => (await call(users.bob, 'GET', `/api/search?q=${encodeURIComponent(q)}${extra}`)).json.items.map((i: any) => i.id);
  assert.deepEqual(await s('東京タワー'), ['tokyo']);
  assert.deepEqual(await s('電波塔'), ['tokyo']);
  assert.deepEqual(await s('lambda cold'), ['aws']);
  assert.deepEqual(await s('寺', '&tag=歴史'), ['kyoto']);
  assert.deepEqual(await s('lamb'), ['aws'], 'substring fallback');
  const r = (await call(users.bob, 'GET', '/api/search?q=電波塔')).json.items[0];
  assert.match(r.snippet, /電波塔/);
  assert.equal((await call(users.bob, 'GET', '/api/search?q=')).status, 400);
  // index follows updates
  await call(users.alice, 'PUT', '/api/articles/aws', { version: 1, body: 'nothing here' });
  assert.deepEqual(await s('arm64'), []);
});

test('graph and backlinks', async () => {
  const { call } = setup();
  await call(users.alice, 'POST', '/api/articles', { id: 'a', title: 'A', body: '[b](/wiki/b) [c](/wiki/c)', tags: ['t'] });
  await call(users.alice, 'POST', '/api/articles', { id: 'b', title: 'B', body: '[c](/wiki/c.md)', tags: ['t'] });
  await call(users.alice, 'POST', '/api/articles', { id: 'c', title: 'C', body: 'leaf', readScope: 'owner' });
  await call(users.alice, 'POST', '/api/articles', { id: 'd', title: 'D', body: '[a](/wiki/a)' });
  const g = (await call(users.alice, 'GET', '/api/graph?id=a&depth=1')).json;
  assert.deepEqual(g.nodes.map((n: any) => n.id).sort(), ['a', 'b', 'c', 'd']);
  assert.deepEqual(g.edges.map((e: any) => `${e.from}>${e.to}`).sort(), ['a>b', 'a>c', 'b>c', 'd>a']);
  const gb = (await call(users.bob, 'GET', '/api/graph?id=a&depth=2&tags=1')).json;
  assert.ok(!gb.nodes.some((n: any) => n.id === 'c'), 'unreadable node hidden');
  assert.ok(gb.edges.some((e: any) => e.kind === 'tag' && e.tags.includes('t')));
  const all = (await call(users.bob, 'GET', '/api/graph')).json;
  assert.equal(all.nodes.length, 3);
  const bl = (await call(users.alice, 'GET', '/api/articles/c/backlinks')).json.items.map((i: any) => i.id).sort();
  assert.deepEqual(bl, ['a', 'b']);
  await call(users.alice, 'PUT', '/api/articles/b', { version: 1, body: 'no links' });
  assert.deepEqual((await call(users.alice, 'GET', '/api/articles/c/backlinks')).json.items.map((i: any) => i.id), ['a']);
});

test('list pagination, tag filter, mine', async () => {
  const { call } = setup();
  for (let i = 0; i < 7; i++) {
    await call(i % 2 ? users.alice : users.bob, 'POST', '/api/articles', { id: `p${i}`, title: `P${i}`, body: '', tags: i < 3 ? ['x'] : [] });
    await new Promise((r) => setTimeout(r, 2));
  }
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const r = (await call(users.vic, 'GET', `/api/articles?limit=3${cursor ? `&cursor=${cursor}` : ''}`)).json;
    seen.push(...r.items.map((i: any) => i.id));
    cursor = r.cursor;
  } while (cursor);
  assert.deepEqual(seen, ['p6', 'p5', 'p4', 'p3', 'p2', 'p1', 'p0']);
  assert.deepEqual((await call(users.vic, 'GET', '/api/articles?tag=X')).json.items.map((i: any) => i.id), ['p2', 'p1', 'p0']);
  assert.deepEqual((await call(users.alice, 'GET', '/api/articles?mine=1')).json.items.map((i: any) => i.id), ['p5', 'p3', 'p1']);
  assert.equal((await call(users.vic, 'GET', '/api/articles?cursor=garbage')).status, 400);
});

test('OKF export / import round trip', async () => {
  const a = setup();
  await a.call(users.alice, 'POST', '/api/articles', { id: 'one', title: 'One', body: 'to [two](/wiki/two)', tags: ['k'], description: 'first', extra: { stale_after: '2030-01-01T00:00:00Z' } });
  await a.call(users.alice, 'POST', '/api/articles', { id: 'two', title: 'Two', body: 'hi' });
  await a.call(users.alice, 'POST', '/api/articles', { id: 'hidden', title: 'Hidden', body: 'x', readScope: 'owner' });
  const ex = await a.call(users.bob, 'GET', '/api/export');
  assert.equal(ex.status, 200);
  const entries = readZip(ex.res.body as Buffer, { maxEntries: 100, maxEntryBytes: 1e6, maxTotalBytes: 1e7 });
  assert.deepEqual(entries.map((e) => e.name).sort(), ['index.md', 'wiki/one.md', 'wiki/two.md']);
  const one = parseOkfDocument(entries.find((e) => e.name === 'wiki/one.md')!.data.toString());
  assert.equal(one.body, 'to [two](/wiki/two.md)');
  assert.equal(one.frontmatter.stale_after, '2030-01-01T00:00:00Z');

  const b = setup();
  assert.equal((await b.call(users.alice, 'POST', '/api/admin/import', undefined, { raw: ex.res.body as Buffer, contentType: 'application/zip' })).status, 403);
  const imp = await b.call(users.admin, 'POST', '/api/admin/import', undefined, { raw: ex.res.body as Buffer, contentType: 'application/zip' });
  assert.equal(imp.status, 200);
  assert.deepEqual(imp.json.created.sort(), ['one', 'two']);
  assert.equal(imp.json.skipped.length, 1); // index.md
  const got = (await b.call(users.bob, 'GET', '/api/articles/one')).json;
  assert.equal(got.description, 'first');
  assert.equal(got.generatedBy, 'human:alice', 'provenance preserved');
  assert.deepEqual(got.links, ['two']);
  assert.equal((await b.call(users.admin, 'POST', '/api/admin/import', undefined, { raw: Buffer.from('nope'), contentType: 'application/zip' })).status, 400);
});

test('rate limiting', async () => {
  const { call } = setup({ rateLimit: { perMinute: 3, writesPerMinute: 1 } });
  assert.equal((await call(users.alice, 'POST', '/api/articles', { title: 'a', body: '' })).status, 201);
  assert.equal((await call(users.alice, 'POST', '/api/articles', { title: 'b', body: '' })).status, 429);
  assert.equal((await call(users.alice, 'GET', '/api/me')).status, 200);
  assert.equal((await call(users.alice, 'GET', '/api/me')).status, 429);
});

test('rejects non-JSON bodies and unknown routes', async () => {
  const { call } = setup();
  assert.equal((await call(users.alice, 'POST', '/api/articles', undefined, { raw: Buffer.from('{}'), contentType: 'text/plain' })).status, 415);
  assert.equal((await call(users.alice, 'GET', '/api/nope')).status, 404);
  assert.equal((await call(users.alice, 'PATCH', '/api/articles')).status, 405);
  assert.equal((await call(users.alice, 'GET', '/api/articles/..%2Fetc')).status, 404);
});
