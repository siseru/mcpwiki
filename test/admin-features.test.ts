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
