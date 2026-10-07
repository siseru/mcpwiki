// Article attachments (images + PDF). Access follows the owning article: reading an attachment requires
// read access to the article, uploading/deleting requires write access. Bytes never pass through Lambda
// on upload/download: clients use short-lived presigned S3 URLs pinned to one key, type and size.
import type { Attachment, Principal } from '../shared/types.js';
import { badRequest, forbidden, HttpError, notFound } from './errors.js';
import { newId, type WikiService } from './service.js';
import type { AttachmentBlobs, Store } from './store.js';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_ARTICLE = 100;
/** Largest image returned inline to MCP clients (base64 inside a JSON-RPC response). */
export const MAX_MCP_IMAGE_BYTES = 3 * 1024 * 1024;

const FILE_ID_RE = /^[a-z0-9]{12}$/;

/** Allowed types, verified by magic bytes after upload. SVG/HTML are deliberately excluded (script). */
export const ATTACHMENT_TYPES: Record<string, { ext: string[]; inline: boolean; magic: (b: Buffer) => boolean }> = {
  'image/png': { ext: ['png'], inline: true, magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/jpeg': { ext: ['jpg', 'jpeg'], inline: true, magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/gif': { ext: ['gif'], inline: true, magic: (b) => ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1')) },
  'image/webp': { ext: ['webp'], inline: true, magic: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  // PDFs are always served as downloads (viewers may run embedded script).
  'application/pdf': { ext: ['pdf'], inline: false, magic: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
};

export const attachmentKey = (articleId: string, fileId: string) => `attachments/${articleId}/${fileId}`;
export const attachmentPath = (articleId: string, fileId: string) => `/wiki/${articleId}/files/${fileId}`;

/** Display name: no paths, control/bidi characters or quotes; bounded length. */
export function sanitizeName(raw: unknown): string {
  const base = String(raw ?? '').split(/[\\/]/).pop() ?? '';
  const clean = base
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069"<>`]/g, '')
    .trim()
    .slice(0, 120);
  return clean || 'file';
}

export interface AttachmentView {
  fileId: string;
  name: string;
  contentType: string;
  size: number;
  uploadedBy: string;
  uploadedAt: string;
  path: string;
  markdown: string;
}

const view = (a: Attachment): AttachmentView => {
  const path = attachmentPath(a.articleId, a.fileId);
  const label = a.name.replace(/[[\]\\]/g, '');
  return {
    fileId: a.fileId, name: a.name, contentType: a.contentType, size: a.size, uploadedBy: a.uploadedBy, uploadedAt: a.uploadedAt, path,
    markdown: ATTACHMENT_TYPES[a.contentType]?.inline ? `![${label}](${path})` : `[${label}](${path})`,
  };
};

export class AttachmentService {
  constructor(
    private readonly store: Store,
    private readonly blobs: AttachmentBlobs,
    private readonly wiki: WikiService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async ready(p: Principal, articleId: string, fileId: string): Promise<Attachment> {
    await this.wiki.articleFor(p, articleId, false);
    if (!FILE_ID_RE.test(fileId)) throw notFound('attachment');
    const a = await this.store.getAttachment(articleId, fileId);
    if (!a || a.status !== 'ready' || a.deleted) throw notFound('attachment');
    return a;
  }

  async list(p: Principal, articleId: string): Promise<AttachmentView[]> {
    await this.wiki.articleFor(p, articleId, false);
    return (await this.store.listAttachments(articleId))
      .filter((a) => a.status === 'ready' && !a.deleted)
      .sort((a, b) => (a.uploadedAt < b.uploadedAt ? -1 : 1))
      .map(view);
  }

  /** Step 1: reserve an id and get a presigned POST pinned to key, type and the declared size. */
  async requestUpload(p: Principal, articleId: string, raw: unknown) {
    if (p.via === 'mcp') throw forbidden('attachments can only be uploaded from the web UI or the CLI');
    await this.wiki.articleFor(p, articleId, true);
    const r = (raw ?? {}) as Record<string, unknown>;
    const contentType = String(r.contentType ?? '');
    const size = Number(r.size);
    if (!ATTACHMENT_TYPES[contentType]) throw badRequest(`unsupported file type; allowed: ${Object.keys(ATTACHMENT_TYPES).join(', ')}`);
    if (!Number.isInteger(size) || size < 1 || size > MAX_ATTACHMENT_BYTES) throw badRequest(`size must be 1..${MAX_ATTACHMENT_BYTES} bytes`);
    const existing = (await this.store.listAttachments(articleId)).filter((a) => !a.deleted && a.status !== 'rejected');
    if (existing.length >= MAX_ATTACHMENTS_PER_ARTICLE) throw new HttpError(409, 'too_many', `at most ${MAX_ATTACHMENTS_PER_ARTICLE} attachments per article`);
    const a: Attachment = {
      articleId, fileId: newId(), name: sanitizeName(r.name), contentType, size, status: 'pending',
      uploadedBy: p.username, uploadedBySub: p.sub, uploadedAt: this.now().toISOString(),
    };
    await this.store.putAttachment(a);
    return { fileId: a.fileId, upload: this.blobs.presignUpload(attachmentKey(articleId, a.fileId), contentType, size), expiresInSeconds: 300 };
  }

  /** Step 2: verify the uploaded object (size, magic bytes) and publish it. */
  async complete(p: Principal, articleId: string, fileId: string): Promise<AttachmentView> {
    await this.wiki.articleFor(p, articleId, true);
    if (!FILE_ID_RE.test(fileId)) throw notFound('attachment');
    const a = await this.store.getAttachment(articleId, fileId);
    if (!a || a.deleted || a.uploadedBySub !== p.sub) throw notFound('attachment');
    if (a.status === 'ready') return view(a);
    if (a.status !== 'pending') throw new HttpError(409, 'rejected', 'this upload was rejected');
    const key = attachmentKey(articleId, fileId);
    const obj = await this.blobs.head(key, 16);
    if (!obj) throw new HttpError(409, 'not_uploaded', 'the file has not been uploaded yet');
    if (obj.size > a.size || obj.size > MAX_ATTACHMENT_BYTES || !ATTACHMENT_TYPES[a.contentType]!.magic(obj.head)) {
      await this.store.putAttachment({ ...a, status: 'rejected' });
      await this.blobs.remove(key);
      await this.wiki.auditEvent(p, 'attachment.rejected', articleId, `${fileId} ${a.contentType}`);
      throw badRequest('the uploaded file does not match its declared type or size');
    }
    const ready: Attachment = { ...a, size: obj.size, status: 'ready' };
    await this.store.putAttachment(ready);
    await this.wiki.auditEvent(p, 'attachment.upload', articleId, `${fileId} ${a.contentType} ${obj.size}B`);
    return view(ready);
  }

  /**
   * Admin full export: the zip is written to `exports/` (expired by a bucket lifecycle rule after a day) and
   * handed out as a short-lived presigned URL, so its size is not bound by the API response limit.
   */
  async exportArchive(p: Principal) {
    const { zip, count } = await this.wiki.exportArchive(p);
    const stamp = this.now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const key = `exports/${stamp}-${newId()}.zip`;
    await this.blobs.put(key, zip, 'application/zip');
    const filename = `mcpwiki-all-${stamp.slice(0, 8)}.zip`;
    return { count, size: zip.length, filename, url: this.blobs.presignDownload(key, 'application/zip', `attachment; filename="${filename}"`), expiresInSeconds: 300 };
  }

  /** Short-lived download URL (images inline, everything else as a download). */
  async downloadUrl(p: Principal, articleId: string, fileId: string) {
    const a = await this.ready(p, articleId, fileId);
    const inline = ATTACHMENT_TYPES[a.contentType]?.inline ?? false;
    const disposition = `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.name)}`;
    return { ...view(a), url: this.blobs.presignDownload(attachmentKey(articleId, fileId), a.contentType, disposition), expiresInSeconds: 300 };
  }

  /** Image bytes for MCP clients (small images only). */
  async imageContent(p: Principal, articleId: string, fileId: string) {
    const a = await this.ready(p, articleId, fileId);
    if (!ATTACHMENT_TYPES[a.contentType]?.inline) return { attachment: view(a), data: null as Buffer | null, reason: 'not an image' };
    if (a.size > MAX_MCP_IMAGE_BYTES) return { attachment: view(a), data: null as Buffer | null, reason: `larger than ${MAX_MCP_IMAGE_BYTES} bytes` };
    return { attachment: view(a), data: await this.blobs.read(attachmentKey(articleId, fileId), MAX_MCP_IMAGE_BYTES), reason: '' };
  }

  async remove(p: Principal, articleId: string, fileId: string): Promise<void> {
    if (p.via !== 'web') throw forbidden('attachments can only be deleted from the web UI');
    await this.wiki.articleFor(p, articleId, true);
    const a = await this.ready(p, articleId, fileId);
    await this.store.putAttachment({ ...a, deleted: true });
    await this.blobs.remove(attachmentKey(articleId, fileId));
    await this.wiki.auditEvent(p, 'attachment.delete', articleId, fileId);
  }
}
