import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLI, setup, users } from './helpers.js';
import { MAX_ATTACHMENT_BYTES, sanitizeName } from '../src/backend/attachments.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(50, 2)]);

async function upload(ctx: ReturnType<typeof setup>, user: any, articleId: string, data: Buffer, contentType: string, name = 'a.png', client?: string) {
  const r = await ctx.call(user, 'POST', `/api/articles/${articleId}/attachments`, { name, contentType, size: data.length }, client ? { client } : {});
  if (r.status !== 201) return { req: r };
  ctx.blobs.put(r.json.upload.fields.key, data);
  const c = await ctx.call(user, 'POST', `/api/articles/${articleId}/attachments/${r.json.fileId}/complete`, undefined, client ? { client } : {});
  return { req: r, done: c };
}

test('upload, list, download URL, markdown snippet', async () => {
  const ctx = setup();
  await ctx.call(users.alice, 'POST', '/api/articles', { id: 'doc', title: 'D', body: 'x', writeScope: 'all' });
  const { req, done } = await upload(ctx, users.alice, 'doc', PNG, 'image/png', '../../etc/screen<shot>.png');
  assert.equal(req.status, 201);
  assert.equal(req.json.upload.fields['Content-Type'], 'image/png');
  assert.equal(req.json.upload.fields.maxBytes, String(PNG.length), 'POST policy pins the declared size');
  assert.equal(done!.status, 200);
  assert.equal(done!.json.name, 'screenshot.png');
  assert.equal(done!.json.markdown, `![screenshot.png](/wiki/doc/files/${done!.json.fileId})`);
  const list = await ctx.call(users.bob, 'GET', '/api/articles/doc/attachments');
  assert.equal(list.json.items.length, 1);
  const url = await ctx.call(users.vic, 'GET', `/api/articles/doc/attachments/${done!.json.fileId}/url`);
  assert.equal(url.status, 200);
  assert.match(url.json.url, /disposition=inline/);
  // PDFs are always downloads
  const pdf = await upload(ctx, users.alice, 'doc', PDF, 'application/pdf', 'spec.pdf');
  assert.match(pdf.done!.json.markdown, /^\[spec\.pdf\]\(/);
  const pu = await ctx.call(users.bob, 'GET', `/api/articles/doc/attachments/${pdf.done!.json.fileId}/url`);
  assert.match(pu.json.url, /disposition=attachment/);
});

test('type, size and magic-byte checks; SVG/HTML rejected', async () => {
  const ctx = setup();
  await ctx.call(users.alice, 'POST', '/api/articles', { id: 'doc', title: 'D', body: 'x' });
  for (const t of ['image/svg+xml', 'text/html', 'application/octet-stream']) {
    assert.equal((await ctx.call(users.alice, 'POST', '/api/articles/doc/attachments', { name: 'x', contentType: t, size: 10 })).status, 400, t);
  }
  assert.equal((await ctx.call(users.alice, 'POST', '/api/articles/doc/attachments', { name: 'x', contentType: 'image/png', size: MAX_ATTACHMENT_BYTES + 1 })).status, 400);
  // declared PNG, uploaded HTML -> rejected and removed
  const fake = await upload(ctx, users.alice, 'doc', Buffer.from('<html><script>alert(1)</script>'), 'image/png');
  assert.equal(fake.done!.status, 400);
  assert.equal(ctx.blobs.objects.size, 0, 'rejected object removed');
  assert.equal((await ctx.call(users.alice, 'GET', '/api/articles/doc/attachments')).json.items.length, 0);
  // not uploaded yet
  const r = await ctx.call(users.alice, 'POST', '/api/articles/doc/attachments', { name: 'x', contentType: 'image/png', size: PNG.length });
  assert.equal((await ctx.call(users.alice, 'POST', `/api/articles/doc/attachments/${r.json.fileId}/complete`)).status, 409);
  // another user cannot complete someone else's upload
  ctx.blobs.put(r.json.upload.fields.key, PNG);
  assert.equal((await ctx.call(users.admin, 'POST', `/api/articles/doc/attachments/${r.json.fileId}/complete`)).status, 404);
});

test('permissions follow the article', async () => {
  const ctx = setup();
  await ctx.call(users.alice, 'POST', '/api/articles', { id: 'priv', title: 'P', body: 'x', readScope: 'owner' });
  await ctx.call(users.alice, 'POST', '/api/articles', { id: 'ro', title: 'R', body: 'x', writeScope: 'owner' });
  const { done } = await upload(ctx, users.alice, 'priv', PNG, 'image/png');
  // unreadable article: attachment looks missing
  assert.equal((await ctx.call(users.bob, 'GET', `/api/articles/priv/attachments/${done!.json.fileId}/url`)).status, 404);
  assert.equal((await ctx.call(users.bob, 'GET', '/api/articles/priv/attachments')).status, 404);
  // cannot upload without write access; viewers never
  assert.equal((await ctx.call(users.bob, 'POST', '/api/articles/ro/attachments', { name: 'x', contentType: 'image/png', size: 10 })).status, 403);
  assert.equal((await ctx.call(users.vic, 'POST', '/api/articles/ro/attachments', { name: 'x', contentType: 'image/png', size: 10 })).status, 403);
  // CLI may upload, MCP may not
  assert.equal((await upload(ctx, users.alice, 'ro', PNG, 'image/png', 'c.png', CLI)).done!.status, 200);
  const viaMcp = await ctx.tool(users.alice, 'list_attachments', { id: 'ro' });
  assert.equal(viaMcp.data.attachments.length, 1);
  // delete: web only, then gone
  const fid = viaMcp.data.attachments[0].fileId;
  assert.equal((await ctx.call(users.alice, 'DELETE', `/api/articles/ro/attachments/${fid}`, undefined, { client: CLI })).status, 403);
  assert.equal((await ctx.call(users.alice, 'DELETE', `/api/articles/ro/attachments/${fid}`)).status, 200);
  assert.equal((await ctx.call(users.alice, 'GET', `/api/articles/ro/attachments/${fid}/url`)).status, 404);
  // deleting the article hides its attachments
  await ctx.call(users.alice, 'DELETE', '/api/articles/priv');
  assert.equal((await ctx.call(users.alice, 'GET', `/api/articles/priv/attachments/${done!.json.fileId}/url`)).status, 404);
});

test('MCP get_attachment returns image content', async () => {
  const ctx = setup();
  await ctx.call(users.alice, 'POST', '/api/articles', { id: 'doc', title: 'D', body: 'x' });
  const img = await upload(ctx, users.alice, 'doc', PNG, 'image/png');
  const pdf = await upload(ctx, users.alice, 'doc', PDF, 'application/pdf', 'x.pdf');
  const r = await ctx.mcp(users.bob, 'tools/call', { name: 'get_attachment', arguments: { id: 'doc', file_id: img.done!.json.fileId } });
  assert.equal(r.result.content[1].type, 'image');
  assert.equal(Buffer.from(r.result.content[1].data, 'base64').equals(PNG), true);
  const rp = await ctx.mcp(users.bob, 'tools/call', { name: 'get_attachment', arguments: { id: 'doc', file_id: pdf.done!.json.fileId } });
  assert.equal(rp.result.content.length, 1);
  assert.match(rp.result.content[0].text, /not an image/);
});

test('sanitizeName', () => {
  assert.equal(sanitizeName('C:\\Users\\x\\report\u202efdp.exe'), 'reportfdp.exe');
  assert.equal(sanitizeName(''), 'file');
  assert.equal(sanitizeName('a'.repeat(300)).length, 120);
});
