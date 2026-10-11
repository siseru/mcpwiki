import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLI, setup, users } from './helpers.js';
import { readZip } from '../src/backend/zip.js';
import { parseOkfDocument } from '../src/shared/okf.js';

test('site title: admins change it from the web UI only, everyone sees it in /api/me', async () => {
  const { call, store } = setup();
  assert.equal((await call(users.vic, 'GET', '/api/me')).json.site.title, 'MCPWiki', 'default');
  assert.equal((await call(users.alice, 'PUT', '/api/admin/settings', { title: 'Team Wiki' })).status, 403);
  assert.equal((await call(users.admin, 'PUT', '/api/admin/settings', { title: 'Team Wiki' }, { client: CLI })).status, 403);
  for (const bad of [{}, { title: '' }, { title: '   ' }, { title: 'x'.repeat(61) }, { title: 'a\nb' }, { title: 'a‮b' }, { title: 3 }, { title: 'ok', extra: 1 }]) {
    assert.equal((await call(users.admin, 'PUT', '/api/admin/settings', bad)).status, 400, JSON.stringify(bad));
  }
  const r = await call(users.admin, 'PUT', '/api/admin/settings', { title: '  チーム Wiki  ' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { title: 'チーム Wiki' });
  assert.equal((await call(users.vic, 'GET', '/api/me')).json.site.title, 'チーム Wiki');
  assert.deepEqual(await store.getSettings(), { title: 'チーム Wiki' });
  const audit = (await call(users.admin, 'GET', `/api/admin/audit?date=${new Date().toISOString().slice(0, 10)}`)).json.items;
  assert.ok(audit.some((e: any) => e.action === 'settings'));
});

test('admin export: every live article (any scope) as an OKF zip in exports/, via a presigned URL', async () => {
  const { call, blobs } = setup();
  await call(users.alice, 'POST', '/api/articles', { id: 'pub', title: 'Pub', body: 'see [x](/wiki/secret)' });
  await call(users.alice, 'POST', '/api/articles', { id: 'secret', title: 'Secret', body: 'owner only', readScope: 'owner', writeScope: 'owner' });
  await call(users.admin, 'POST', '/api/articles', { id: 'adm', title: 'Adm', body: 'admins', readScope: 'admin', writeScope: 'admin' });
  await call(users.alice, 'POST', '/api/articles', { id: 'gone', title: 'Gone', body: 'x' });
  await call(users.admin, 'DELETE', '/api/articles/gone');
  await call(users.admin, 'PUT', '/api/admin/settings', { title: 'Team' });

  assert.equal((await call(users.alice, 'POST', '/api/admin/export')).status, 403);
  assert.equal((await call(users.admin, 'POST', '/api/admin/export', undefined, { client: CLI })).status, 403);

  const r = await call(users.admin, 'POST', '/api/admin/export');
  assert.equal(r.status, 200);
  assert.equal(r.json.count, 3);
  assert.match(r.json.filename, /^mcpwiki-all-\d{8}\.zip$/);
  const key = [...blobs.objects.keys()].find((k) => k.startsWith('exports/'));
  assert.ok(key && /^exports\/\d{8}T\d{6}Z-[a-z0-9]{12}\.zip$/.test(key), key);
  assert.ok(r.json.url.includes(key) && r.json.url.includes(encodeURIComponent('attachment; filename=')));
  const entries = readZip(blobs.objects.get(key)!, { maxEntries: 100, maxEntryBytes: 1e6, maxTotalBytes: 1e7 });
  assert.deepEqual(entries.map((e) => e.name).sort(), ['index.md', 'wiki/adm.md', 'wiki/pub.md', 'wiki/secret.md']);
  assert.equal(r.json.size, blobs.objects.get(key)!.length);
  assert.match(entries.find((e) => e.name === 'index.md')!.data.toString(), /^# Team$/m);
  const secret = parseOkfDocument(entries.find((e) => e.name === 'wiki/secret.md')!.data.toString());
  assert.equal(secret.body, 'owner only');
  assert.equal(parseOkfDocument(entries.find((e) => e.name === 'wiki/pub.md')!.data.toString()).body, 'see [x](/wiki/secret.md)');
  const audit = (await call(users.admin, 'GET', `/api/admin/audit?date=${new Date().toISOString().slice(0, 10)}`)).json.items;
  assert.ok(audit.some((e: any) => e.action === 'export-all' && e.detail === '3 articles'));
});

test('admin bulk: verify and set scopes (widening included) for many articles, web UI only', async () => {
  const { call } = setup();
  await call(users.alice, 'POST', '/api/articles', { id: 'b1', title: 'B1', body: 'x', readScope: 'owner', writeScope: 'owner' });
  await call(users.alice, 'POST', '/api/articles', { id: 'b2', title: 'B2', body: 'x', readScope: 'admin', writeScope: 'none' });
  await call(users.bob, 'POST', '/api/articles', { id: 'b3', title: 'B3', body: 'x' });
  await call(users.bob, 'POST', '/api/articles', { id: 'gone', title: 'Gone', body: 'x' });
  await call(users.admin, 'DELETE', '/api/articles/gone');
  const bulk = (body: unknown, o = {}) => call(users.admin, 'POST', '/api/admin/articles/bulk', body, o);

  // who / where
  assert.equal((await call(users.alice, 'POST', '/api/admin/articles/bulk', { action: 'verify', ids: ['b1'] })).status, 403);
  assert.equal((await bulk({ action: 'verify', ids: ['b1'] }, { client: CLI })).status, 403);
  // input validation
  for (const bad of [{}, { action: 'delete', ids: ['b1'] }, { action: 'verify', ids: [] }, { action: 'verify', ids: ['B 1'] }, { action: 'verify', ids: ['b1', 'b1'] },
    { action: 'verify', ids: Array.from({ length: 101 }, (_, i) => `x${i}`) }, { action: 'permissions', ids: ['b1'] }, { action: 'permissions', ids: ['b1'], readScope: 'world' },
    { action: 'verify', ids: ['b1'], readScope: 'all' }]) {
    assert.equal((await bulk(bad)).status, 400, JSON.stringify(bad).slice(0, 80));
  }

  // verify: changed, then unchanged on a second run; missing / deleted articles fail individually
  let r = await bulk({ action: 'verify', ids: ['b1', 'b2', 'b3', 'gone', 'nope'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.results.map((x: any) => [x.id, x.outcome]), [['b1', 'changed'], ['b2', 'changed'], ['b3', 'changed'], ['gone', 'failed'], ['nope', 'failed']]);
  assert.equal((await call(users.admin, 'GET', '/api/articles/b1')).json.verified.length, 1);
  assert.equal((await call(users.admin, 'GET', '/api/admin/articles?limit=10')).json.items.find((a: any) => a.id === 'b2').verified, true);
  r = await bulk({ action: 'verify', ids: ['b1', 'b3'] });
  assert.deepEqual(r.json.results.map((x: any) => x.outcome), ['unchanged', 'unchanged']);

  // permissions: widen to everyone/everyone (b3 had the default owner-only edit scope); a second run is a no-op
  r = await bulk({ action: 'permissions', ids: ['b1', 'b2', 'b3'], readScope: 'all', writeScope: 'all' });
  assert.deepEqual(r.json.results.map((x: any) => [x.id, x.outcome]), [['b1', 'changed'], ['b2', 'changed'], ['b3', 'changed']]);
  r = await bulk({ action: 'permissions', ids: ['b1', 'b2', 'b3'], readScope: 'all', writeScope: 'all' });
  assert.deepEqual(r.json.results.map((x: any) => x.outcome), ['unchanged', 'unchanged', 'unchanged']);
  assert.equal((await call(users.bob, 'GET', '/api/articles/b1')).status, 200, 'bob can now read alice\'s owner-only article');
  assert.equal((await call(users.bob, 'PUT', '/api/articles/b2', { version: (await call(users.bob, 'GET', '/api/articles/b2')).json.version, body: 'edited' })).status, 200);
  // scope changes keep the review (content unchanged)
  assert.equal((await call(users.admin, 'GET', '/api/articles/b1')).json.verified.length, 1);

  // only one side: narrowing read below the current write fails per article, the rest still apply
  r = await bulk({ action: 'permissions', ids: ['b1', 'b3'], readScope: 'admin' });
  assert.deepEqual(r.json.results.map((x: any) => x.outcome), ['failed', 'failed']);
  assert.match(r.json.results[0].error.message, /wider than read scope/);
  r = await bulk({ action: 'permissions', ids: ['b1', 'b3'], writeScope: 'none' });
  assert.deepEqual(r.json.results.map((x: any) => x.outcome), ['changed', 'changed']);
  r = await bulk({ action: 'permissions', ids: ['b1', 'b3'], readScope: 'admin' });
  assert.deepEqual(r.json.results.map((x: any) => x.outcome), ['changed', 'changed']);
  assert.equal((await call(users.bob, 'GET', '/api/articles/b3')).status, 404, 'bob lost access to his own article (admin-only now)');

  const audit = (await call(users.admin, 'GET', `/api/admin/audit?date=${new Date().toISOString().slice(0, 10)}`)).json.items;
  assert.ok(audit.some((e: any) => e.action === 'bulk' && /^verify: 3 changed, 0 unchanged, 2 failed$/.test(e.detail)));
  assert.ok(audit.filter((e: any) => e.action === 'verify').length >= 3, 'each article is audited individually too');
});

test('mine filter: list and search return only articles the caller owns', async () => {
  const { call } = setup();
  await call(users.alice, 'POST', '/api/articles', { id: 'm-a', title: 'Mine apple', body: 'fruit', tags: ['f'] });
  await call(users.bob, 'POST', '/api/articles', { id: 'm-b', title: 'Bob apple', body: 'fruit', tags: ['f'] });
  const ids = (r: any) => r.json.items.map((i: any) => i.id).sort();
  assert.deepEqual(ids(await call(users.alice, 'GET', '/api/articles?mine=1')), ['m-a']);
  assert.deepEqual(ids(await call(users.alice, 'GET', '/api/articles?mine=1&tag=f')), ['m-a']);
  assert.deepEqual(ids(await call(users.alice, 'GET', '/api/search?q=apple')), ['m-a', 'm-b']);
  assert.deepEqual(ids(await call(users.alice, 'GET', '/api/search?q=apple&mine=1')), ['m-a']);
  assert.deepEqual(ids(await call(users.bob, 'GET', '/api/search?q=fruit&mine=1&tag=f')), ['m-b']);
  assert.deepEqual(ids(await call(users.alice, 'GET', `/api/search?q=${encodeURIComponent('Bob')}&mine=1`)), [], 'substring fallback respects mine too');
});
