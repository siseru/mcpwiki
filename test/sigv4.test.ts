import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { presignGet, presignPost, signingKey } from '../src/backend/sigv4.js';

// Test vectors from the AWS documentation.
test('signing key derivation (AWS SigV4 docs example)', () => {
  assert.equal(
    signingKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20120215', 'us-east-1', 'iam').toString('hex'),
    'f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d',
  );
});

test('presigned GET (S3 query-string auth docs example)', () => {
  const url = presignGet({
    bucket: 'examplebucket',
    region: 'us-east-1',
    key: 'test.txt',
    expiresSec: 86400,
    host: 'examplebucket.s3.amazonaws.com',
    credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
    now: new Date('2013-05-24T00:00:00Z'),
  });
  assert.match(url, /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/);
});

test('presigned POST policy pins key, type, size and credentials', () => {
  const creds = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', sessionToken: 'tok' };
  const p = presignPost({ bucket: 'b', region: 'us-west-2', key: 'attachments/a/f', contentType: 'image/png', maxBytes: 100, expiresSec: 300, credentials: creds, now: new Date('2026-01-01T00:00:00Z') });
  const policy = JSON.parse(Buffer.from(p.fields.policy!, 'base64').toString());
  assert.equal(policy.expiration, '2026-01-01T00:05:00.000Z');
  assert.deepEqual(policy.conditions.slice(0, 2), [{ bucket: 'b' }, ['content-length-range', 1, 100]]);
  assert.ok(policy.conditions.some((c: any) => c.key === 'attachments/a/f'));
  assert.ok(policy.conditions.some((c: any) => c['Content-Type'] === 'image/png'));
  assert.ok(policy.conditions.some((c: any) => c['x-amz-security-token'] === 'tok'));
  const expected = createHmac('sha256', signingKey('secret', '20260101', 'us-west-2', 's3')).update(p.fields.policy!).digest('hex');
  assert.equal(p.fields['x-amz-signature'], expected);
  assert.equal(p.url, 'https://b.s3.us-west-2.amazonaws.com/');
});
