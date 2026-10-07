import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLI, setup, users } from './helpers.js';

test('initialize, ping, tools/list (no delete tool)', async () => {
  const { mcp, call } = setup();
  const init = await mcp(users.alice, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'mcpwiki');
  const unknownVer = await mcp(users.alice, 'initialize', { protocolVersion: '1999-01-01' });
  assert.equal(unknownVer.result.protocolVersion, '2025-11-25');
  assert.deepEqual((await mcp(users.alice, 'ping')).result, {});
  const names = (await mcp(users.alice, 'tools/list')).result.tools.map((t: any) => t.name);
  assert.deepEqual(names, ['list_articles', 'get_article', 'search_articles', 'create_article', 'update_article', 'list_tags', 'get_graph', 'list_attachments', 'get_attachment', 'get_backlinks']);
  assert.ok(!names.some((n: string) => /delete|remove/.test(n)));
  assert.equal((await mcp(users.alice, 'nope')).error.code, -32601);
  // notification -> 202, GET -> 405, batch -> 400, bad origin -> 403, no auth -> 401
  assert.equal((await call(users.alice, 'POST', '/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }, { client: CLI })).status, 202);
  assert.equal((await call(users.alice, 'GET', '/mcp')).status, 405);
  assert.equal((await call(users.alice, 'POST', '/mcp', [{ jsonrpc: '2.0', id: 1, method: 'ping' }])).status, 400);
  assert.equal((await call(users.alice, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call(null, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
  assert.equal((await call(users.alice, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, { headers: { 'mcp-protocol-version': '2000-01-01' } })).status, 400);
});

test('tool flow: create, get, update with version, search, graph', async () => {
  const { tool, call } = setup();
  const c = await tool(users.alice, 'create_article', { id: 'mcp-note', title: 'MCP note', body: 'Links to [x](/wiki/other)', tags: ['llm'] });
  assert.equal(c.isError, false);
  assert.equal(c.data.version, 1);
  const web = (await call(users.alice, 'GET', '/api/articles/mcp-note')).json;
  assert.equal(web.status, 'draft', 'MCP-created articles default to draft');
  assert.equal(web.generatedBy, 'mcpwiki-mcp/0.1');

  const g = await tool(users.bob, 'get_article', { id: 'mcp-note' });
  const tag = /<(untrusted-article-[0-9a-f]{16})>/.exec(g.text)![1];
  assert.match(g.text, new RegExp(`</${tag}>$`));
  assert.match(g.text, /^---\ntype: Wiki Article/m);
  assert.equal(g.data.version, 1);

  const stale = await tool(users.alice, 'update_article', { id: 'mcp-note', version: 7, body: 'x' });
  assert.equal(stale.isError, true);
  assert.match(stale.text, /version_conflict/);
  const up = await tool(users.alice, 'update_article', { id: 'mcp-note', version: 1, body: 'updated body', status: 'stable' });
  assert.equal(up.isError, false);
  assert.equal(up.data.version, 2);

  const bad = await tool(users.alice, 'update_article', { id: 'mcp-note', version: 2, bogus: 1 });
  assert.match(bad.error.message, /unknown argument "bogus"/);
  const badType = await tool(users.alice, 'create_article', { title: 1, body: 'x' });
  assert.match(badType.error.message, /"title" must be a string/);

  const s = await tool(users.bob, 'search_articles', { query: 'updated' });
  assert.equal(s.data.results[0].id, 'mcp-note');
  assert.ok(s.data._notice);
  const tags = await tool(users.bob, 'list_tags', {});
  assert.deepEqual(tags.data.tags, [{ tag: 'llm', count: 1 }]);
  const list = await tool(users.bob, 'list_articles', { limit: 5 });
  assert.equal(list.data.items.length, 1);
  await tool(users.alice, 'create_article', { id: 'other', title: 'Other', body: 'back to [n](/wiki/mcp-note)' });
  const graph = await tool(users.bob, 'get_graph', { id: 'mcp-note' });
  assert.deepEqual(graph.data.edges.map((e: any) => `${e.from}>${e.to}`), ['other>mcp-note']);
  const bl = await tool(users.bob, 'get_backlinks', { id: 'mcp-note' });
  assert.deepEqual(bl.data.backlinks.map((b: any) => b.id), ['other']);
});

test('MCP cannot widen permissions but can narrow them; viewers cannot write', async () => {
  const { tool } = setup();
  await tool(users.alice, 'create_article', { id: 'p', title: 'P', body: 'x', read_scope: 'owner', write_scope: 'owner' });
  const widen = await tool(users.alice, 'update_article', { id: 'p', version: 1, read_scope: 'all' });
  assert.equal(widen.isError, true);
  assert.match(widen.text, /only be widened from the web UI/);
  const narrow = await tool(users.alice, 'update_article', { id: 'p', version: 1, write_scope: 'none' });
  assert.equal(narrow.isError, false);
  const v = await tool(users.vic, 'create_article', { title: 'x', body: 'y' });
  assert.equal(v.isError, true);
  assert.match(v.text, /forbidden/);
  const hidden = await tool(users.bob, 'get_article', { id: 'p' });
  assert.match(hidden.text, /not_found/);
});
