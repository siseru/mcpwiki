import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractLinks, indexTerms, linkTargetToId, snippet, tokenize } from '../src/shared/text.js';
import { validateArticleInput, ValidationError } from '../src/shared/validate.js';

test('tokenize japanese and latin', () => {
  assert.deepEqual(tokenize('東京タワー'), ['東京', '京タ', 'タワ', 'ワー']);
  assert.deepEqual(tokenize('Hello, AWS Lambda 2!'), ['hello', 'aws', 'lambda', '2']);
  assert.deepEqual(tokenize('ＡＢＣ'), ['abc']);
  assert.deepEqual(tokenize('猫'), ['猫']);
});

test('indexTerms boosts title and tags', () => {
  const t = indexTerms('Lambda', ['aws'], '', 'lambda lambda other');
  assert.equal(t.lambda, 2 + 10);
  assert.equal(t.aws, 5);
  assert.equal(t.other, 1);
});

test('extractLinks', () => {
  const body = [
    '[a](/wiki/alpha) [b](/wiki/beta.md#x) [c](../wiki/gamma.md) [d](delta.md)',
    '[ext](https://example.com/wiki/nope) [self](/wiki/me) [bad](/wiki/Bad_ID)',
    '`[code](/wiki/incode)`',
    '```',
    '[fenced](/wiki/infence)',
    '```',
    '[ref]: /wiki/refd',
  ].join('\n');
  assert.deepEqual(extractLinks(body, 'me').sort(), ['alpha', 'beta', 'delta', 'gamma', 'refd']);
  assert.equal(linkTargetToId('/wiki/a%2Fb'), null);
  assert.equal(linkTargetToId('javascript:alert(1)'), null);
});

test('snippet', () => {
  assert.match(snippet('aaa '.repeat(100) + 'needle here', 'needle'), /needle here/);
});

test('validateArticleInput', () => {
  const v = validateArticleInput({ title: ' T ', tags: ['a', 'a', ' b '], body: 'x\r\ny' }, false);
  assert.deepEqual(v, { title: 'T', tags: ['a', 'b'], body: 'x\ny' });
  assert.throws(() => validateArticleInput({ title: '' }, false), ValidationError);
  assert.throws(() => validateArticleInput({ title: 'a', readScope: 'owner', writeScope: 'all' }, false), /wider/);
  assert.throws(() => validateArticleInput({ title: 'a', extra: { title: 'x' } }, false), /reserved/);
  assert.throws(() => validateArticleInput({ title: 'a', tags: ['<script>'] }, false), /invalid tag/);
  assert.throws(() => validateArticleInput({ id: 'Bad ID', title: 'a' }, false), /id must/);
  assert.throws(() => validateArticleInput({ title: 'a\nb' }, false), /newlines/);
  assert.throws(() => validateArticleInput({ title: 'a', body: 'x'.repeat(300 * 1024) }, false), /bytes/);
});
