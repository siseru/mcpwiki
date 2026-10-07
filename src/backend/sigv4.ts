// Minimal AWS Signature Version 4 for S3 presigned POST (browser/CLI uploads) and presigned GET.
// node:crypto only. Reference: https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
import { createHash, createHmac } from 'node:crypto';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data, 'utf8').digest();
const sha256hex = (data: string) => createHash('sha256').update(data, 'utf8').digest('hex');

export function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request');
}

/** RFC 3986 encoding as required by SigV4 (slashes kept in paths). */
function uriEncode(s: string, keepSlash: boolean): string {
  return Array.from(Buffer.from(s, 'utf8'))
    .map((b) => {
      const c = String.fromCharCode(b);
      if (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === '/')) return c;
      return `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
    })
    .join('');
}

const amzDate = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export interface PresignedPost {
  url: string;
  fields: Record<string, string>;
}

/**
 * Presigned POST: the browser/CLI uploads straight to S3; S3 enforces the exact key, Content-Type and size range.
 */
export function presignPost(o: {
  bucket: string;
  region: string;
  key: string;
  contentType: string;
  maxBytes: number;
  expiresSec: number;
  credentials: AwsCredentials;
  now?: Date;
}): PresignedPost {
  const now = o.now ?? new Date();
  const date = amzDate(now);
  const day = date.slice(0, 8);
  const credential = `${o.credentials.accessKeyId}/${day}/${o.region}/s3/aws4_request`;
  const fields: Record<string, string> = {
    key: o.key,
    'Content-Type': o.contentType,
    'x-amz-algorithm': 'AWS4-HMAC-SHA256',
    'x-amz-credential': credential,
    'x-amz-date': date,
  };
  if (o.credentials.sessionToken) fields['x-amz-security-token'] = o.credentials.sessionToken;
  const policy = {
    expiration: new Date(now.getTime() + o.expiresSec * 1000).toISOString(),
    conditions: [
      { bucket: o.bucket },
      ['content-length-range', 1, o.maxBytes],
      ...Object.entries(fields).map(([k, v]) => ({ [k]: v })),
    ],
  };
  fields.policy = Buffer.from(JSON.stringify(policy), 'utf8').toString('base64');
  fields['x-amz-signature'] = hmac(signingKey(o.credentials.secretAccessKey, day, o.region, 's3'), fields.policy).toString('hex');
  return { url: `https://${o.bucket}.s3.${o.region}.amazonaws.com/`, fields };
}

/** Presigned GET (query-string auth) with optional response header overrides. */
export function presignGet(o: {
  bucket: string;
  region: string;
  key: string;
  expiresSec: number;
  credentials: AwsCredentials;
  responseHeaders?: Record<string, string>; // e.g. { 'response-content-disposition': 'attachment' }
  host?: string; // override for tests (virtual-hosted style host)
  now?: Date;
}): string {
  const now = o.now ?? new Date();
  const date = amzDate(now);
  const day = date.slice(0, 8);
  const host = o.host ?? `${o.bucket}.s3.${o.region}.amazonaws.com`;
  const path = '/' + uriEncode(o.key, true);
  const q: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${o.credentials.accessKeyId}/${day}/${o.region}/s3/aws4_request`,
    'X-Amz-Date': date,
    'X-Amz-Expires': String(o.expiresSec),
    'X-Amz-SignedHeaders': 'host',
    ...(o.credentials.sessionToken ? { 'X-Amz-Security-Token': o.credentials.sessionToken } : {}),
    ...(o.responseHeaders ?? {}),
  };
  const query = Object.keys(q)
    .sort()
    .map((k) => `${uriEncode(k, false)}=${uriEncode(q[k]!, false)}`)
    .join('&');
  const canonical = ['GET', path, query, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', date, `${day}/${o.region}/s3/aws4_request`, sha256hex(canonical)].join('\n');
  const sig = hmac(signingKey(o.credentials.secretAccessKey, day, o.region, 's3'), toSign).toString('hex');
  return `https://${host}${path}?${query}&X-Amz-Signature=${sig}`;
}

/** Lambda / local credentials from the standard environment variables. */
export function envCredentials(): AwsCredentials {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) throw new Error('AWS credentials are not available in the environment');
  return { accessKeyId, secretAccessKey, sessionToken: process.env.AWS_SESSION_TOKEN };
}
