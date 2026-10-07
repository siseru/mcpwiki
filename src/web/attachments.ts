// Attachments in the SPA. Files are private like their article, so <img src> cannot point at them directly
// (no cookies are used): the app fetches a short-lived presigned URL with the bearer token, downloads the
// bytes and shows them through a blob: URL.
import { api } from './api.js';

export const FILE_PATH_RE = /^\/wiki\/([a-z0-9-]+)\/files\/([a-z0-9]{12})$/;
export const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,application/pdf';
export const MAX_BYTES = 10 * 1024 * 1024;

export interface AttachmentInfo {
  fileId: string;
  name: string;
  contentType: string;
  size: number;
  uploadedBy: string;
  uploadedAt: string;
  path: string;
  markdown: string;
}

const objectUrls = new Map<string, Promise<string>>();

async function signedUrl(path: string): Promise<{ url: string; name: string; contentType: string }> {
  const m = FILE_PATH_RE.exec(path);
  if (!m) throw new Error('not an attachment path');
  return api('GET', `/api/articles/${m[1]}/attachments/${m[2]}/url`);
}

function objectUrl(path: string): Promise<string> {
  if (!objectUrls.has(path)) {
    objectUrls.set(
      path,
      (async () => {
        const { url } = await signedUrl(path);
        const r = await fetch(url);
        if (!r.ok) throw new Error(`download failed (${r.status})`);
        return URL.createObjectURL(await r.blob());
      })().catch((e) => {
        objectUrls.delete(path);
        throw e;
      }),
    );
  }
  return objectUrls.get(path)!;
}

/** Opens / downloads an attachment (PDFs are served as downloads, images open in a new tab). */
export async function openAttachment(path: string): Promise<void> {
  const { url, contentType } = await signedUrl(path);
  if (contentType.startsWith('image/')) window.open(url, '_blank', 'noopener,noreferrer');
  else location.assign(url);
}

/** Wire attachment images and links inside rendered (sanitized) Markdown. Call before inserting into the page. */
export function hydrateAttachments(root: ParentNode): void {
  for (const img of root.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? '';
    if (!FILE_PATH_RE.test(src)) continue;
    img.removeAttribute('src'); // never request the SPA route as an image
    img.classList.add('attachment-loading');
    objectUrl(src)
      .then((u) => {
        img.src = u;
        img.classList.remove('attachment-loading');
      })
      .catch(() => {
        img.classList.remove('attachment-loading');
        img.classList.add('attachment-missing');
        img.alt = `${img.alt || '画像'}（表示できません）`;
      });
  }
  for (const a of root.querySelectorAll('a')) {
    const href = a.getAttribute('href') ?? '';
    if (!FILE_PATH_RE.test(href)) continue;
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      openAttachment(href).catch((e: unknown) => alert(e instanceof Error ? e.message : String(e)));
    });
  }
}

/** Presigned POST straight to S3, then ask the API to verify and publish the file. */
export async function uploadAttachment(articleId: string, file: File): Promise<AttachmentInfo> {
  if (!ACCEPT.split(',').includes(file.type)) throw new Error('アップロードできるのは PNG / JPEG / GIF / WebP / PDF です');
  if (file.size > MAX_BYTES) throw new Error('ファイルサイズの上限は 10MB です');
  const req = await api<{ fileId: string; upload: { url: string; fields: Record<string, string> } }>('POST', `/api/articles/${articleId}/attachments`, {
    name: file.name,
    contentType: file.type,
    size: file.size,
  });
  const form = new FormData();
  for (const [k, v] of Object.entries(req.upload.fields)) form.append(k, v);
  form.append('file', file); // must be the last field
  const up = await fetch(req.upload.url, { method: 'POST', body: form });
  if (!up.ok) throw new Error(`アップロードに失敗しました (${up.status})`);
  return api<AttachmentInfo>('POST', `/api/articles/${articleId}/attachments/${req.fileId}/complete`);
}

export const listAttachments = (articleId: string) => api<{ items: AttachmentInfo[] }>('GET', `/api/articles/${articleId}/attachments`);
export const deleteAttachment = (articleId: string, fileId: string) => api('DELETE', `/api/articles/${articleId}/attachments/${fileId}`);

export function formatSize(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}
