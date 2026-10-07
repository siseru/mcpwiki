import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, users } from './helpers.js';
import { SEED_PAGES } from '../src/backend/seed/pages.generated.js';

test('default help pages are created once, readable by everyone, editable by admins only', async () => {
  const ctx = setup();
  assert.deepEqual((await ctx.service.ensureSeedPages(SEED_PAGES)).sort(), ['help-markdown', 'help-wiki']);
  assert.deepEqual(await ctx.service.ensureSeedPages(SEED_PAGES), [], 'idempotent');

  const md = await ctx.call(users.vic, 'GET', '/api/articles/help-markdown');
  assert.equal(md.status, 200);
  assert.equal(md.json.title, 'Markdown の書き方');
  assert.deepEqual(md.json.tags, ['help', 'markdown']);
  assert.equal(md.json.readScope, 'all');
  assert.equal(md.json.writeScope, 'admin');
  assert.equal(md.json.ownerName, 'MCPWiki');
  assert.equal(md.json.generatedBy, 'process:mcpwiki-seed');
  assert.deepEqual(md.json.links, ['help-wiki'], 'link inside code blocks is ignored, real link is kept');

  assert.equal((await ctx.call(users.alice, 'PUT', '/api/articles/help-wiki', { version: 1, body: 'x' })).status, 403);
  assert.equal((await ctx.call(users.admin, 'PUT', '/api/articles/help-wiki', { version: 1, body: 'customized' })).status, 200);
  await ctx.call(users.admin, 'DELETE', '/api/articles/help-markdown');
  assert.deepEqual(await ctx.service.ensureSeedPages(SEED_PAGES), [], 'edited / deleted pages are not recreated');
  assert.equal((await ctx.call(users.admin, 'GET', '/api/articles/help-wiki')).json.body, 'customized');

  const s = await ctx.call(users.vic, 'GET', `/api/search?q=${encodeURIComponent('タスクリスト')}`);
  assert.deepEqual(s.json.items.map((i: any) => i.id), [], 'deleted page is not searchable');
  const back = await ctx.call(users.vic, 'GET', '/api/articles/help-wiki/backlinks');
  assert.deepEqual(back.json.items, [], 'deleted page does not appear as a backlink');
});

test('seed documents are valid OKF and render-safe', () => {
  for (const p of SEED_PAGES) {
    assert.match(p.id, /^help-[a-z]+$/);
    assert.match(p.text, /^---\ntype: Wiki Article\ntitle: /);
    assert.ok(!/<script|javascript:/i.test(p.text), `${p.id} must not contain script`);
  }
});
