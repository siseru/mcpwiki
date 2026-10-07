import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, stringifyYaml, YamlError } from '../src/shared/yaml.js';
import type { JsonValue } from '../src/shared/types.js';

test('parses OKF spec style frontmatter', () => {
  const src = [
    'type: BigQuery Table',
    'title: "Orders: daily"',
    'tags: [sales, orders, revenue]',
    'generated: { by: reference_agent/gemini-2.5-pro, at: 2026-05-28T14:30:00Z }',
    'verified:',
    '  - by: human:ahormati',
    '    at: 2026-06-25T09:00:00Z',
    'status: stable        # draft | stable | deprecated',
    'parameters:',
    '  - { name: year, type: integer, required: true }',
    'receipt: [job_id, executed_sql, result]',
    'count: 42',
    'ratio: 0.5',
    'empty:',
    "quoted: 'it''s'",
    'url: https://example.com/a#b',
    'list:',
    '- a',
    '- b',
    'next: 1',
  ].join('\n');
  assert.deepEqual(parseYaml(src), {
    type: 'BigQuery Table',
    title: 'Orders: daily',
    tags: ['sales', 'orders', 'revenue'],
    generated: { by: 'reference_agent/gemini-2.5-pro', at: '2026-05-28T14:30:00Z' },
    verified: [{ by: 'human:ahormati', at: '2026-06-25T09:00:00Z' }],
    status: 'stable',
    parameters: [{ name: 'year', type: 'integer', required: true }],
    receipt: ['job_id', 'executed_sql', 'result'],
    count: 42,
    ratio: 0.5,
    empty: null,
    quoted: "it's",
    url: 'https://example.com/a#b',
    list: ['a', 'b'],
    next: 1,
  });
});

test('block scalars', () => {
  assert.deepEqual(parseYaml('a: |\n  line1\n  line2\nb: >-\n  x\n  y\n\n  z\nc: 1'), { a: 'line1\nline2\n', b: 'x y\nz', c: 1 });
});

test('nested maps and Japanese', () => {
  assert.deepEqual(parseYaml('mcpwiki:\n  id: abc\n  owner: 太郎\n  nested:\n    k: v\ntitle: 日本語のタイトル'), {
    mcpwiki: { id: 'abc', owner: '太郎', nested: { k: 'v' } },
    title: '日本語のタイトル',
  });
});

test('rejects unsafe or unsupported input', () => {
  assert.throws(() => parseYaml('__proto__: 1'), YamlError);
  assert.throws(() => parseYaml('a: 1\na: 2'), YamlError);
  assert.throws(() => parseYaml('a: *ref'), YamlError);
  assert.throws(() => parseYaml('a: [1, 2'), YamlError);
  assert.throws(() => parseYaml('a: { constructor: 1 }'), YamlError);
  assert.throws(() => parseYaml('a:\n\t- 1'), YamlError);
});

test('round trip', () => {
  const values: Record<string, JsonValue>[] = [
    { type: 'Wiki Article', title: 'a: b', tags: ['x', 'y z', 'true', '1', 'a,b', ''], status: 'draft' },
    { s: 'line\nbreak', n: null, b: false, num: -3.5, q: '"quoted"', h: '# not comment', dash: '- item' },
    { generated: { by: 'human:taro', at: '2026-01-01T00:00:00Z' }, verified: [{ by: 'human:a', at: 'x' }, { by: 'b', at: 'y' }] },
    { deep: { a: { b: { c: [1, [2, 3], { d: 'e' }] } } }, empty: {}, emptyList: [], mixed: [{ a: 1 }, 'x', null] },
    { 'key with: colon': 'v', 'ユニコード': '値', long: Array.from({ length: 30 }, (_, i) => `tag${i}`) },
  ];
  for (const v of values) assert.deepEqual(parseYaml(stringifyYaml(v)), v);
});
