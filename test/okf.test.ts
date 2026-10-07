import { test } from 'node:test';
import assert from 'node:assert/strict';
import { articleToOkf, bundleIndex, okfToArticleFields, parseOkfDocument, serializeOkfDocument, toBundleLinks } from '../src/shared/okf.js';
import type { ArticleMeta } from '../src/shared/types.js';

export function sampleMeta(over: Partial<ArticleMeta> = {}): ArticleMeta {
  return {
    id: 'hello', type: 'Wiki Article', title: 'Hello', description: 'Greeting page', tags: ['a', 'b'], status: 'stable',
    readScope: 'all', writeScope: 'owner', owner: 'sub-1', ownerName: 'taro', version: 3,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', updatedBy: 'taro', generatedBy: 'human:taro',
    verified: [], extra: { stale_after: '2027-01-01T00:00:00Z', custom: { x: 1 } }, links: [], s3VersionId: 'v1', deleted: false,
    ...over,
  };
}

test('document round trip keeps body exactly', () => {
  for (const body of ['', '# Title\n\ntext\n', '\n\nleading blank', '---\nnot frontmatter\n---\n']) {
    const doc = { frontmatter: { type: 'X' }, body };
    assert.deepEqual(parseOkfDocument(serializeOkfDocument(doc)), doc);
  }
});

test('document without frontmatter', () => {
  assert.deepEqual(parseOkfDocument('# hi'), { frontmatter: {}, body: '# hi' });
});

test('article <-> okf mapping preserves extension keys', () => {
  const meta = sampleMeta({ verified: [{ by: 'human:hanako', at: '2026-01-03T00:00:00Z' }] });
  const text = articleToOkf(meta, 'Body [x](/wiki/other)\n');
  assert.match(text, /^---\ntype: Wiki Article\ntitle: Hello\n/);
  const f = okfToArticleFields(parseOkfDocument(text));
  assert.equal(f.title, 'Hello');
  assert.deepEqual(f.tags, ['a', 'b']);
  assert.equal(f.id, 'hello');
  assert.equal(f.version, 3);
  assert.equal(f.readScope, 'all');
  assert.equal(f.writeScope, 'owner');
  assert.deepEqual(f.verified, [{ by: 'human:hanako', at: '2026-01-03T00:00:00Z' }]);
  assert.deepEqual(f.extra, { stale_after: '2027-01-01T00:00:00Z', custom: { x: 1 } });
  assert.equal(f.body, 'Body [x](/wiki/other)\n');
});

test('bundle link rewrite and index', () => {
  assert.equal(toBundleLinks('[a](/wiki/foo) [b](/wiki/bar.md) [c](/wiki/baz#h)'), '[a](/wiki/foo.md) [b](/wiki/bar.md) [c](/wiki/baz.md#h)');
  const idx = bundleIndex([sampleMeta(), sampleMeta({ id: 'z', title: 'A [x]', description: '' })], 'Wiki');
  assert.match(idx, /^---\nokf_version: "0.2"\n---\n/);
  assert.match(idx, /\* \[A \\\[x\\\]\]\(\/wiki\/z\.md\)\n\* \[Hello\]\(\/wiki\/hello\.md\) - Greeting page/);
});
