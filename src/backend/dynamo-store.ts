// DynamoDB (single table) + S3 implementation of Store.
//
// Item layout (PK / SK):
//   A#<id>        META           article metadata   (GSI1: ARTICLES|DELETED / <updatedAt>#<id>)
//   A#<id>        V#<000000ver>  history entry
//   A#<id>        TERMS          indexed terms of the current revision
//   A#<id>        B#<fromId>     backlink: <fromId> links to <id>
//   T#<token>     A#<id>         search posting (w = weight)
//   AUDIT#<date>  <ts>#<rand>    audit log entry (TTL)
//   U#<sub>       STATE          user state (disable / token revocation)
//   RL#<key>#<w>  RL             rate-limit counter (TTL)
//   A#<id>        F#<fileId>     attachment metadata (bytes in S3 under attachments/<id>/<fileId>)
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException, DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { DeleteObjectCommand, GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import type { ArticleMeta, Attachment, AuditEntry, HistoryEntry, SiteSettings } from '../shared/types.js';
import { ConflictError } from './errors.js';
import type { AttachmentBlobs, MetaPage, Store, UserState } from './store.js';
import { envCredentials, presignGet, presignPost } from './sigv4.js';
import { listKey } from './store.js';

const AUDIT_TTL_DAYS = 400;
const META_ATTRS = [
  'id', 'type', 'title', 'description', 'tags', 'status', 'readScope', 'writeScope', 'owner', 'ownerName', 'version',
  'createdAt', 'updatedAt', 'updatedBy', 'generatedBy', 'verified', 'extra', 'links', 's3VersionId', 'deleted', 'deletedAt', 'deletedBy',
] as const;

function toMeta(item: Record<string, unknown>): ArticleMeta {
  const m: Record<string, unknown> = {};
  for (const k of META_ATTRS) if (item[k] !== undefined) m[k] = item[k];
  const meta = m as unknown as ArticleMeta;
  meta.tags ??= [];
  meta.links ??= [];
  meta.verified ??= [];
  meta.extra ??= {};
  meta.description ??= '';
  meta.deleted = !!meta.deleted;
  return meta;
}

function metaItem(meta: ArticleMeta): Record<string, unknown> {
  return {
    PK: `A#${meta.id}`,
    SK: 'META',
    GSI1PK: meta.deleted ? 'DELETED' : 'ARTICLES',
    GSI1SK: listKey(meta),
    ...meta,
  };
}

function historyItem(h: HistoryEntry): Record<string, unknown> {
  return { PK: `A#${h.id}`, SK: `V#${String(h.version).padStart(9, '0')}`, ...h };
}

const chunk = <T>(arr: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class DynamoStore implements Store {
  private readonly ddb: DynamoDBDocumentClient;
  private readonly s3: S3Client;

  constructor(private readonly table: string, private readonly bucket: string, region?: string) {
    this.ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
      marshallOptions: { removeUndefinedValues: true, convertEmptyValues: false },
    });
    this.s3 = new S3Client({ region });
  }

  async putBody(id: string, text: string): Promise<string> {
    const res = await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: `articles/${id}.md`, Body: text, ContentType: 'text/markdown; charset=utf-8' }),
    );
    if (!res.VersionId) throw new Error('bucket versioning must be enabled');
    return res.VersionId;
  }

  async getBody(id: string, versionId: string): Promise<string> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: `articles/${id}.md`, VersionId: versionId }));
    return (await res.Body?.transformToString('utf-8')) ?? '';
  }

  async getMeta(id: string) {
    const res = await this.ddb.send(new GetCommand({ TableName: this.table, Key: { PK: `A#${id}`, SK: 'META' } }));
    return res.Item ? toMeta(res.Item) : null;
  }

  async batchGetMeta(ids: string[]) {
    const out: ArticleMeta[] = [];
    for (const part of chunk([...new Set(ids)], 100)) {
      let keys: Record<string, unknown>[] | undefined = part.map((id) => ({ PK: `A#${id}`, SK: 'META' }));
      for (let attempt = 0; keys && keys.length && attempt < 5; attempt++) {
        if (attempt) await sleep(50 * 2 ** attempt);
        const res = await this.ddb.send(new BatchGetCommand({ RequestItems: { [this.table]: { Keys: keys } } }));
        for (const item of res.Responses?.[this.table] ?? []) out.push(toMeta(item));
        keys = res.UnprocessedKeys?.[this.table]?.Keys as Record<string, unknown>[] | undefined;
      }
      if (keys && keys.length) throw new Error('BatchGet: unprocessed keys remain');
    }
    return out;
  }

  async listMetas(opts: { deleted: boolean; after?: string; limit: number }): Promise<MetaPage> {
    const gsiPk = opts.deleted ? 'DELETED' : 'ARTICLES';
    const input: QueryCommandInput = {
      TableName: this.table,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': gsiPk },
      ScanIndexForward: false,
      Limit: opts.limit,
    };
    if (opts.after) {
      const id = opts.after.slice(opts.after.lastIndexOf('#') + 1);
      input.ExclusiveStartKey = { PK: `A#${id}`, SK: 'META', GSI1PK: gsiPk, GSI1SK: opts.after };
    }
    const res = await this.ddb.send(new QueryCommand(input));
    const items = (res.Items ?? []).map(toMeta);
    const next = res.LastEvaluatedKey ? String(res.LastEvaluatedKey.GSI1SK) : undefined;
    return { items, next };
  }

  async createMeta(meta: ArticleMeta, h: HistoryEntry) {
    try {
      await this.ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            { Put: { TableName: this.table, Item: metaItem(meta), ConditionExpression: 'attribute_not_exists(PK)' } },
            { Put: { TableName: this.table, Item: historyItem(h) } },
          ],
        }),
      );
    } catch (e) {
      if (e instanceof TransactionCanceledException) throw new ConflictError('exists');
      throw e;
    }
  }

  async updateMeta(meta: ArticleMeta, expectedVersion: number, h: HistoryEntry) {
    try {
      await this.ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.table,
                Item: metaItem(meta),
                ConditionExpression: 'attribute_exists(PK) AND #v = :v',
                ExpressionAttributeNames: { '#v': 'version' },
                ExpressionAttributeValues: { ':v': expectedVersion },
              },
            },
            { Put: { TableName: this.table, Item: historyItem(h), ConditionExpression: 'attribute_not_exists(PK)' } },
          ],
        }),
      );
    } catch (e) {
      if (e instanceof TransactionCanceledException) throw new ConflictError('version mismatch');
      throw e;
    }
  }

  async listHistory(id: string, limit: number) {
    const res = await this.ddb.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :v)',
        ExpressionAttributeValues: { ':pk': `A#${id}`, ':v': 'V#' },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (res.Items ?? []).map(({ PK: _pk, SK: _sk, ...rest }) => rest as unknown as HistoryEntry);
  }

  async getHistory(id: string, version: number) {
    const res = await this.ddb.send(
      new GetCommand({ TableName: this.table, Key: { PK: `A#${id}`, SK: `V#${String(version).padStart(9, '0')}` } }),
    );
    if (!res.Item) return null;
    const { PK: _pk, SK: _sk, ...rest } = res.Item;
    return rest as unknown as HistoryEntry;
  }

  async getIndexTerms(id: string) {
    const res = await this.ddb.send(new GetCommand({ TableName: this.table, Key: { PK: `A#${id}`, SK: 'TERMS' } }));
    return (res.Item?.terms as Record<string, number> | undefined) ?? {};
  }

  private async batchWrite(requests: Record<string, unknown>[]) {
    for (const part of chunk(requests, 25)) {
      let pending: Record<string, unknown>[] | undefined = part;
      for (let attempt = 0; pending && pending.length && attempt < 8; attempt++) {
        if (attempt) await sleep(Math.min(2000, 50 * 2 ** attempt));
        const res = await this.ddb.send(new BatchWriteCommand({ RequestItems: { [this.table]: pending as never } }));
        pending = res.UnprocessedItems?.[this.table] as Record<string, unknown>[] | undefined;
      }
      if (pending && pending.length) throw new Error('BatchWrite: unprocessed items remain');
    }
  }

  async replaceIndex(id: string, terms: Record<string, number>, prev: Record<string, number>) {
    const reqs: Record<string, unknown>[] = [];
    for (const t of Object.keys(prev)) {
      if (!(t in terms)) reqs.push({ DeleteRequest: { Key: { PK: `T#${t}`, SK: `A#${id}` } } });
    }
    for (const [t, w] of Object.entries(terms)) {
      if (prev[t] !== w) reqs.push({ PutRequest: { Item: { PK: `T#${t}`, SK: `A#${id}`, id, w } } });
    }
    await this.batchWrite(reqs);
    await this.ddb.send(new PutCommand({ TableName: this.table, Item: { PK: `A#${id}`, SK: 'TERMS', terms } }));
  }

  async queryTerm(token: string, limit: number) {
    const out: { id: string; w: number }[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const res = await this.ddb.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': `T#${token}` },
          ProjectionExpression: 'id, w',
          ExclusiveStartKey: start,
          Limit: Math.min(1000, limit - out.length),
        }),
      );
      for (const it of res.Items ?? []) out.push({ id: String(it.id), w: Number(it.w) });
      start = res.LastEvaluatedKey;
    } while (start && out.length < limit);
    return out;
  }

  async getBacklinks(id: string) {
    const out: string[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const res = await this.ddb.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :b)',
          ExpressionAttributeValues: { ':pk': `A#${id}`, ':b': 'B#' },
          ProjectionExpression: 'SK',
          ExclusiveStartKey: start,
        }),
      );
      for (const it of res.Items ?? []) out.push(String(it.SK).slice(2));
      start = res.LastEvaluatedKey;
    } while (start && out.length < 1000);
    return out;
  }

  async replaceBacklinks(id: string, links: string[], prev: string[]) {
    const reqs: Record<string, unknown>[] = [];
    for (const t of prev) if (!links.includes(t)) reqs.push({ DeleteRequest: { Key: { PK: `A#${t}`, SK: `B#${id}` } } });
    for (const t of links) if (!prev.includes(t)) reqs.push({ PutRequest: { Item: { PK: `A#${t}`, SK: `B#${id}` } } });
    await this.batchWrite(reqs);
  }

  async putAudit(e: AuditEntry) {
    const expireAt = Math.floor(Date.parse(e.ts) / 1000) + AUDIT_TTL_DAYS * 86400;
    await this.ddb.send(
      new PutCommand({
        TableName: this.table,
        Item: { PK: `AUDIT#${e.ts.slice(0, 10)}`, SK: `${e.ts}#${randomUUID()}`, expireAt, ...e },
      }),
    );
  }

  async listAudit(date: string, limit: number) {
    const res = await this.ddb.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': `AUDIT#${date}` },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (res.Items ?? []).map(({ PK: _p, SK: _s, expireAt: _e, ...rest }) => rest as unknown as AuditEntry);
  }

  async getUserState(sub: string) {
    const res = await this.ddb.send(new GetCommand({ TableName: this.table, Key: { PK: `U#${sub}`, SK: 'STATE' } }));
    if (!res.Item) return null;
    return { disabled: !!res.Item.disabled, minIat: Number(res.Item.minIat ?? 0) };
  }

  async putUserState(sub: string, state: UserState) {
    await this.ddb.send(new PutCommand({ TableName: this.table, Item: { PK: `U#${sub}`, SK: 'STATE', ...state } }));
  }

  async getSettings() {
    const res = await this.ddb.send(new GetCommand({ TableName: this.table, Key: { PK: 'SETTINGS', SK: 'SITE' } }));
    return res.Item ? { title: typeof res.Item.title === 'string' ? res.Item.title : undefined } : null;
  }

  async putSettings(s: SiteSettings) {
    await this.ddb.send(new PutCommand({ TableName: this.table, Item: { PK: 'SETTINGS', SK: 'SITE', title: s.title } }));
  }

  async hit(key: string, windowSec: number, limit: number) {
    const now = Math.floor(Date.now() / 1000);
    const w = Math.floor(now / windowSec);
    try {
      await this.ddb.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { PK: `RL#${key}#${w}`, SK: 'RL' },
          UpdateExpression: 'ADD n :one SET expireAt = :exp',
          ConditionExpression: 'attribute_not_exists(n) OR n < :limit',
          ExpressionAttributeValues: { ':one': 1, ':limit': limit, ':exp': (w + 2) * windowSec },
        }),
      );
      return true;
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) return false;
      throw e;
    }
  }

  async putAttachment(a: Attachment) {
    await this.ddb.send(new PutCommand({ TableName: this.table, Item: { PK: `A#${a.articleId}`, SK: `F#${a.fileId}`, ...a } }));
  }

  async getAttachment(articleId: string, fileId: string) {
    const res = await this.ddb.send(new GetCommand({ TableName: this.table, Key: { PK: `A#${articleId}`, SK: `F#${fileId}` } }));
    if (!res.Item) return null;
    const { PK: _p, SK: _s, ...rest } = res.Item;
    return rest as unknown as Attachment;
  }

  async listAttachments(articleId: string) {
    const res = await this.ddb.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :f)',
        ExpressionAttributeValues: { ':pk': `A#${articleId}`, ':f': 'F#' },
      }),
    );
    return (res.Items ?? []).map(({ PK: _p, SK: _s, ...rest }) => rest as unknown as Attachment);
  }
}

/** Attachment bytes in the content bucket; clients upload/download via short-lived presigned URLs. */
export class S3Blobs implements AttachmentBlobs {
  private readonly s3: S3Client;
  constructor(private readonly bucket: string, private readonly region: string) {
    this.s3 = new S3Client({ region });
  }

  presignUpload(key: string, contentType: string, maxBytes: number) {
    return presignPost({ bucket: this.bucket, region: this.region, key, contentType, maxBytes, expiresSec: 300, credentials: envCredentials() });
  }

  presignDownload(key: string, contentType: string, disposition: string) {
    return presignGet({
      bucket: this.bucket,
      region: this.region,
      key,
      expiresSec: 300,
      credentials: envCredentials(),
      responseHeaders: { 'response-content-type': contentType, 'response-content-disposition': disposition, 'response-cache-control': 'private, max-age=300' },
    });
  }

  async head(key: string, bytes: number) {
    try {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=0-${bytes - 1}` }));
      const head = Buffer.from((await res.Body?.transformToByteArray()) ?? []);
      const total = Number(/\/(\d+)$/.exec(res.ContentRange ?? '')?.[1] ?? res.ContentLength ?? head.length);
      return { size: total, head };
    } catch (e) {
      if (e instanceof NoSuchKey || (e instanceof S3ServiceException && e.$metadata.httpStatusCode === 404)) return null;
      throw e;
    }
  }

  async read(key: string, maxBytes: number) {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if ((res.ContentLength ?? 0) > maxBytes) throw new Error('object too large');
    return Buffer.from((await res.Body?.transformToByteArray()) ?? []);
  }

  async put(key: string, data: Buffer, contentType: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType }));
  }

  async remove(key: string) {
    // Versioned bucket: this adds a delete marker; earlier versions remain recoverable by an administrator.
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
