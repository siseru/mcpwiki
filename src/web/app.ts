// MCPWiki single-page app (user + admin screens).
import type { ArticleSummary, Graph, HistoryEntry, ReadScope, WriteScope } from '../shared/types.js';
import { READ_SCOPES, STATUSES, WRITE_SCOPES } from '../shared/types.js';
import { scopesValid } from '../shared/permissions.js';
import { linkTargetToId } from '../shared/text.js';
import { api, apiBlob, ApiError } from './api.js';
import { handleCallback, isSignedIn, loadConfig, login, logout } from './auth.js';
import { append, clear, fmtDate, h } from './dom.js';
import { renderGraph } from './graph.js';
import { renderMarkdown } from './markdown.js';
import { ACCEPT, deleteAttachment, FILE_PATH_RE, formatSize, hydrateAttachments, listAttachments, openAttachment, uploadAttachment, type AttachmentInfo } from './attachments.js';

interface Me {
  username: string;
  role: 'admin' | 'editor' | 'viewer';
}

let me: Me;
const main = () => document.getElementById('main')!;

const READ_LABEL: Record<ReadScope, string> = { admin: '管理者のみ', owner: 'オーナーのみ', all: 'だれでも' };
const WRITE_LABEL: Record<WriteScope, string> = { none: '読み取りのみ', admin: '管理者のみ編集可', owner: 'オーナーのみ編集可', all: '投稿者全員が編集可' };

// ------------------------------------------------------------------ routing

export function navigate(path: string, replace = false) {
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  void render();
}

document.addEventListener('click', (ev) => {
  const a = (ev.target as Element | null)?.closest?.('a');
  if (!a || a.target || ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
  const href = a.getAttribute('href');
  if (!href || a.hasAttribute('download')) return;
  const url = new URL(href, location.href);
  if (url.origin !== location.origin) return;
  // Wiki links written in OKF bundle style (/wiki/x.md or x.md) map to the article route.
  const id = linkTargetToId(href);
  ev.preventDefault();
  navigate(id && !/^\/wiki\/[^/]+\/./.test(url.pathname) ? `/wiki/${id}${url.hash}` : url.pathname + url.search + url.hash);
});
window.addEventListener('popstate', () => void render());

const link = (href: string, ...children: (Node | string)[]) => h('a', { href }, ...children);

function tagList(tags: string[]) {
  return h('span', { class: 'tags' }, ...tags.map((t) => link(`/tags/${encodeURIComponent(t)}`, h('span', { class: 'tag' }, t))));
}

function errorBox(e: unknown) {
  const msg = e instanceof ApiError ? `${e.status} ${e.message}` : e instanceof Error ? e.message : String(e);
  return h('div', { class: 'error', role: 'alert' }, msg);
}

function scopeBadge(a: Pick<ArticleSummary, 'readScope' | 'writeScope'>) {
  return h('span', { class: `badge scope-${a.readScope}`, title: `${READ_LABEL[a.readScope]} / ${WRITE_LABEL[a.writeScope]}` }, `${READ_LABEL[a.readScope]}・${WRITE_LABEL[a.writeScope]}`);
}

function articleRow(a: ArticleSummary, extra?: Node) {
  return h(
    'li',
    { class: 'article-row' },
    h('div', null, link(`/wiki/${a.id}`, h('strong', null, a.title)), ' ', a.status !== 'stable' ? h('span', { class: `badge status-${a.status}` }, a.status) : null, ' ', tagList(a.tags)),
    a.description ? h('div', { class: 'muted' }, a.description) : null,
    h('div', { class: 'meta' }, `${a.updatedBy} ・ ${fmtDate(a.updatedAt)} ・ v${a.version} ・ `, scopeBadge(a)),
    extra ?? null,
  );
}

async function render() {
  const el = main();
  clear(el);
  el.appendChild(h('p', { class: 'muted' }, '読み込み中…'));
  const path = decodeURI(location.pathname);
  const q = new URLSearchParams(location.search);
  let m: RegExpExecArray | null;
  try {
    let view: Node;
    if (path === '/') view = await homeView();
    else if (path === '/search') view = await searchView(q.get('q') ?? '', q.get('tag') ?? '');
    else if ((m = /^\/tags\/(.+)$/.exec(path))) view = await tagView(m[1]!);
    else if (path === '/tags') view = await tagsView();
    else if (path === '/new') view = editorView(null);
    else if (path === '/graph') view = await graphView(undefined);
    else if ((m = /^\/wiki\/([a-z0-9-]+?)(?:\.md)?$/.exec(path))) view = await articleView(m[1]!, undefined);
    else if ((m = /^\/wiki\/([a-z0-9-]+)\/edit$/.exec(path))) view = await editView(m[1]!);
    else if ((m = /^\/wiki\/([a-z0-9-]+)\/history$/.exec(path))) view = await historyView(m[1]!);
    else if ((m = /^\/wiki\/([a-z0-9-]+)\/history\/(\d+)$/.exec(path))) view = await articleView(m[1]!, Number(m[2]));
    else if ((m = /^\/wiki\/([a-z0-9-]+)\/graph$/.exec(path))) view = await graphView(m[1]!);
    else if (FILE_PATH_RE.test(path)) view = await attachmentView(path);
    else if (path === '/admin' || path.startsWith('/admin/')) view = await adminView(path);
    else view = h('div', null, h('h1', null, '404'), h('p', null, 'ページが見つかりません。'));
    clear(el);
    el.appendChild(view);
    window.scrollTo(0, 0);
    document.body.classList.remove('sidebar-open');
    void refreshSidebar();
  } catch (e) {
    clear(el);
    el.appendChild(errorBox(e));
  }
}

// ------------------------------------------------------------------ views

async function homeView() {
  const list = await api<{ items: ArticleSummary[]; cursor?: string }>('GET', '/api/articles?limit=50');
  const ul = h('ul', { class: 'articles' }, ...list.items.map((a) => articleRow(a)));
  const more = list.cursor ? moreButton(ul, list.cursor) : null;
  return h(
    'section',
    null,
    h('h1', null, '最近更新された記事'),
    list.items.length ? ul : h('p', { class: 'muted' }, 'まだ記事がありません。'),
    more,
  );
}

function moreButton(ul: HTMLElement, cursor: string, base = '/api/articles?limit=50') {
  const btn: HTMLButtonElement = h('button', {
    class: 'secondary',
    onclick: async () => {
      btn.disabled = true;
      const r = await api<{ items: ArticleSummary[]; cursor?: string }>('GET', `${base}&cursor=${encodeURIComponent(cursor)}`);
      append(ul, r.items.map((a) => articleRow(a)));
      if (r.cursor) btn.replaceWith(moreButton(ul, r.cursor, base));
      else btn.remove();
    },
  }, 'さらに表示');
  return btn;
}

async function searchView(q: string, tag: string) {
  const input = h('input', { type: 'search', name: 'q', value: q, placeholder: 'キーワード', 'aria-label': '検索語' });
  const form = h('form', { class: 'searchform', onsubmit: (ev: Event) => (ev.preventDefault(), navigate(`/search?q=${encodeURIComponent(input.value)}`)) }, input, h('button', { type: 'submit' }, '検索'));
  if (!q.trim()) return h('div', null, h('h1', null, '検索'), form);
  const r = await api<{ items: (ArticleSummary & { snippet: string })[] }>('GET', `/api/search?q=${encodeURIComponent(q)}${tag ? `&tag=${encodeURIComponent(tag)}` : ''}`);
  return h(
    'div',
    null,
    h('h1', null, `「${q}」の検索結果`),
    form,
    r.items.length ? h('ul', { class: 'articles' }, ...r.items.map((a) => articleRow(a, h('div', { class: 'snippet' }, a.snippet)))) : h('p', { class: 'muted' }, '見つかりませんでした。'),
  );
}

async function tagView(tag: string) {
  const base = `/api/articles?limit=50&tag=${encodeURIComponent(tag)}`;
  const r = await api<{ items: ArticleSummary[]; cursor?: string }>('GET', base);
  const ul = h('ul', { class: 'articles' }, ...r.items.map((a) => articleRow(a)));
  return h('div', null, h('h1', null, `タグ: ${tag}`), ul, r.cursor ? moreButton(ul, r.cursor, base) : null);
}

async function tagsView() {
  const r = await api<{ items: { tag: string; count: number }[] }>('GET', '/api/tags');
  return h('div', null, h('h1', null, 'タグ一覧'), h('div', { class: 'tagcloud' }, ...r.items.map((t) => link(`/tags/${encodeURIComponent(t.tag)}`, h('span', { class: 'tag' }, `${t.tag} (${t.count})`)))));
}

/** Sanitized Markdown with attachment images/links wired up (before it is inserted into the page). */
function markdown(md: string): DocumentFragment {
  const frag = renderMarkdown(md);
  hydrateAttachments(frag);
  return frag;
}

async function articleView(id: string, version: number | undefined) {
  const a = await api<any>('GET', `/api/articles/${id}${version ? `?version=${version}` : ''}`);
  const isOld = version !== undefined;
  const backlinks = isOld ? { items: [] as ArticleSummary[] } : await api<{ items: ArticleSummary[] }>('GET', `/api/articles/${id}/backlinks`);
  const actions = h('div', { class: 'actions' });
  if (!isOld) {
    if (a.canEdit) actions.appendChild(link(`/wiki/${id}/edit`, h('span', { class: 'button' }, '編集')));
    actions.appendChild(link(`/wiki/${id}/history`, h('span', { class: 'button secondary' }, '履歴')));
    actions.appendChild(link(`/wiki/${id}/graph`, h('span', { class: 'button secondary' }, '関連グラフ')));
    actions.appendChild(h('a', { href: '#', class: 'button secondary', onclick: (ev: Event) => (ev.preventDefault(), void downloadOkf(id)) }, 'OKF'));
    if (me.role !== 'viewer') {
      actions.appendChild(
        h('button', {
          class: 'secondary',
          title: 'OKF の verified に自分を追加します',
          onclick: async () => {
            try {
              await api('POST', `/api/articles/${id}/verify`);
              void render();
            } catch (e) {
              alert(e instanceof Error ? e.message : String(e));
            }
          },
        }, 'レビュー済みにする'),
      );
    }
    if (me.role === 'admin' || (me.role === 'editor' && a.ownerName === me.username)) {
      actions.appendChild(
        h('button', {
          class: 'danger',
          onclick: async () => {
            if (!confirm(`「${a.title}」を削除しますか？（管理者は復元できます）`)) return;
            try {
              await api('DELETE', `/api/articles/${id}`);
              invalidateSidebar();
              navigate('/');
            } catch (e) {
              alert(e instanceof Error ? e.message : String(e));
            }
          },
        }, '削除'),
      );
    }
  }
  const verified = (a.verified ?? []) as { by: string; at: string }[];
  return h(
    'article',
    null,
    isOld ? h('div', { class: 'notice' }, `過去の版 (v${a.version}) を表示しています。`, link(`/wiki/${id}`, '最新版へ')) : null,
    h('h1', null, a.title),
    h(
      'div',
      { class: 'meta' },
      a.status !== 'stable' ? h('span', { class: `badge status-${a.status}` }, a.status) : null,
      ' ',
      tagList(a.tags),
      ' ',
      scopeBadge(a),
      h('br'),
      `オーナー ${a.ownerName} ・ 更新 ${a.updatedBy} ${fmtDate(a.updatedAt)} ・ v${a.version} ・ ${a.generatedBy ?? ''}`,
      verified.length ? h('span', { class: 'verified' }, ` ✓ レビュー済み: ${verified.map((v) => v.by.replace(/^human:/, '')).join(', ')}`) : null,
    ),
    a.description ? h('p', { class: 'description' }, a.description) : null,
    actions,
    h('div', { class: 'markdown-body' }, markdown(a.body)),
    isOld ? null : await attachmentsSection(id, a.canEdit),
    backlinks.items.length ? h('section', { class: 'backlinks' }, h('h2', null, 'この記事へのリンク'), h('ul', null, ...backlinks.items.map((b) => h('li', null, link(`/wiki/${b.id}`, b.title))))) : null,
  );
}

async function attachmentsSection(id: string, canEdit: boolean) {
  const { items } = await listAttachments(id);
  if (!items.length) return null;
  const rows = items.map((f: AttachmentInfo) =>
    h(
      'li',
      null,
      h('a', { href: f.path, onclick: (ev: Event) => (ev.preventDefault(), void openAttachment(f.path).catch((e) => alert(String(e)))) }, f.name),
      h('span', { class: 'muted' }, ` ${formatSize(f.size)} ・ ${f.uploadedBy} ・ ${fmtDate(f.uploadedAt)} `),
      h('code', { class: 'snippet-md' }, f.markdown),
      canEdit && me.role !== 'viewer'
        ? h('button', {
            class: 'danger small',
            onclick: async () => {
              if (!confirm(`添付「${f.name}」を削除しますか？`)) return;
              try {
                await deleteAttachment(id, f.fileId);
                void render();
              } catch (e) {
                alert(e instanceof Error ? e.message : String(e));
              }
            },
          }, '削除')
        : null,
    ),
  );
  return h('section', { class: 'attachments' }, h('h2', null, `添付ファイル (${items.length})`), h('ul', null, ...rows));
}

async function attachmentView(path: string) {
  // Direct link to an attachment: open/download it, then show the article.
  const m = FILE_PATH_RE.exec(path)!;
  try {
    await openAttachment(path);
  } catch (e) {
    return h('div', null, errorBox(e), link(`/wiki/${m[1]}`, '記事へ戻る'));
  }
  return h('div', null, h('p', null, 'ファイルを開きました。'), link(`/wiki/${m[1]}`, '記事へ戻る'));
}

async function downloadOkf(id: string) {
  const r = await apiBlob('GET', `/api/articles/${id}?format=okf`);
  if (!r.ok) return alert(r.json?.error?.message ?? `HTTP ${r.status}`);
  saveBlob(r.blob, `${id}.md`);
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function historyView(id: string) {
  const [a, hist] = await Promise.all([api<any>('GET', `/api/articles/${id}`), api<{ items: HistoryEntry[] }>('GET', `/api/articles/${id}/history`)]);
  return h(
    'div',
    null,
    h('h1', null, `履歴: ${a.title}`),
    h(
      'table',
      { class: 'grid' },
      h('thead', null, h('tr', null, ...['版', '日時', '更新者', '経路', '操作', 'タイトル'].map((t) => h('th', null, t)))),
      h('tbody', null, ...hist.items.map((e) => h('tr', null, h('td', null, link(`/wiki/${id}/history/${e.version}`, `v${e.version}`)), h('td', null, fmtDate(e.updatedAt)), h('td', null, e.updatedBy), h('td', null, e.via), h('td', null, e.action), h('td', null, e.title)))),
    ),
  );
}

async function graphView(id: string | undefined) {
  const tagEdges = new URLSearchParams(location.search).get('tags') === '1';
  const g = await api<Graph>('GET', `/api/graph?${id ? `id=${id}&depth=2&` : ''}${tagEdges ? 'tags=1' : ''}`);
  const toggle = link(`${location.pathname}${tagEdges ? '' : '?tags=1'}`, tagEdges ? 'タグの関連を隠す' : 'タグの関連も表示');
  return h(
    'div',
    null,
    h('h1', null, id ? `関連グラフ: ${g.nodes.find((n) => n.id === id)?.title ?? id}` : '全体グラフ'),
    h('p', { class: 'muted' }, `${g.nodes.length} 記事 / ${g.edges.length} 関連${g.truncated ? '（一部のみ表示）' : ''} ・ `, toggle),
    g.nodes.length ? renderGraph(g, id, navigate) : h('p', null, '関連する記事はありません。'),
  );
}

async function editView(id: string) {
  const a = await api<any>('GET', `/api/articles/${id}`);
  if (!a.canEdit) throw new Error('この記事を編集する権限がありません。');
  return editorView(a);
}

function editorView(a: any | null) {
  if (!a && me.role === 'viewer') throw new Error('閲覧者は記事を作成できません。');
  const isOwner = !a || me.role === 'admin' || a.ownerName === me.username;
  const title = h('input', { type: 'text', value: a?.title ?? '', required: true, maxlength: 200, 'aria-label': 'タイトル' });
  const idInput = h('input', { type: 'text', value: '', placeholder: '省略すると自動採番 (a-z, 0-9, -)', pattern: '[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?', 'aria-label': 'ID' });
  const description = h('input', { type: 'text', value: a?.description ?? '', maxlength: 500, 'aria-label': '概要' });
  const tags = h('input', { type: 'text', value: (a?.tags ?? []).join(', '), placeholder: 'カンマ区切り', 'aria-label': 'タグ' });
  const status = h('select', { 'aria-label': 'ステータス' }, ...STATUSES.map((s) => h('option', { value: s, selected: (a?.status ?? 'stable') === s }, s)));
  const readScope = h('select', { disabled: !isOwner, 'aria-label': '閲覧範囲' }, ...READ_SCOPES.map((s) => h('option', { value: s, selected: (a?.readScope ?? 'all') === s }, READ_LABEL[s])));
  const writeScope = h('select', { disabled: !isOwner, 'aria-label': '編集範囲' }, ...WRITE_SCOPES.map((s) => h('option', { value: s, selected: (a?.writeScope ?? 'owner') === s }, WRITE_LABEL[s])));
  const body = h('textarea', { rows: 24, spellcheck: false, 'aria-label': '本文 (Markdown)' });
  body.value = a?.body ?? '';
  const preview = h('div', { class: 'markdown-body preview' });
  const status_ = h('div', { class: 'form-status', role: 'status' });
  let timer: number | undefined;
  const updatePreview = () => {
    clear(preview);
    preview.appendChild(markdown(body.value));
  };
  // Attachments: file picker, drag & drop and paste insert a Markdown snippet at the cursor.
  const insertAtCursor = (text: string) => {
    const at = body.selectionStart ?? body.value.length;
    const before = body.value.slice(0, at);
    body.value = before + (before && !before.endsWith('\n') ? '\n' : '') + text + '\n' + body.value.slice(body.selectionEnd ?? at);
    updatePreview();
  };
  const uploadStatus = h('span', { class: 'muted', role: 'status' });
  const uploadFiles = async (files: Iterable<File>) => {
    if (!a) return;
    for (const f of files) {
      uploadStatus.textContent = `アップロード中: ${f.name}`;
      try {
        insertAtCursor((await uploadAttachment(a.id, f)).markdown);
        uploadStatus.textContent = `添付しました: ${f.name}`;
      } catch (e) {
        uploadStatus.textContent = `${f.name}: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  };
  const picker = h('input', { type: 'file', accept: ACCEPT, multiple: true, 'aria-label': 'ファイルを添付' });
  picker.addEventListener('change', () => void uploadFiles(Array.from(picker.files ?? [])).then(() => (picker.value = '')));
  body.addEventListener('dragover', (ev) => {
    if (a && (ev as DragEvent).dataTransfer?.types.includes('Files')) ev.preventDefault();
  });
  body.addEventListener('drop', (ev) => {
    const files = (ev as DragEvent).dataTransfer?.files;
    if (!a || !files?.length) return;
    ev.preventDefault();
    void uploadFiles(Array.from(files));
  });
  body.addEventListener('paste', (ev) => {
    const files = Array.from((ev as ClipboardEvent).clipboardData?.files ?? []);
    if (!a || !files.length) return;
    ev.preventDefault();
    void uploadFiles(files);
  });
  const attachBar = a
    ? h('div', { class: 'attach-bar' }, h('label', { class: 'button secondary' }, '画像・PDF を添付', picker), ' ', uploadStatus, h('span', { class: 'muted' }, ' （ドラッグ＆ドロップや貼り付けでも添付できます。PNG / JPEG / GIF / WebP / PDF、10MB まで）'))
    : h('p', { class: 'muted' }, 'ファイルの添付は、記事を作成（保存）したあとで行えます。');
  body.addEventListener('input', () => {
    clearTimeout(timer);
    timer = window.setTimeout(updatePreview, 250);
  });
  updatePreview();
  const save = h('button', { type: 'submit' }, a ? '保存' : '作成');
  const form = h(
    'form',
    {
      class: 'editor',
      onsubmit: async (ev: Event) => {
        ev.preventDefault();
        clear(status_);
        const rs = readScope.value as ReadScope;
        const ws = writeScope.value as WriteScope;
        if (!scopesValid(rs, ws)) {
          status_.appendChild(errorBox(new Error('編集範囲は閲覧範囲より広くできません。')));
          return;
        }
        const input: Record<string, unknown> = {
          title: title.value,
          description: description.value,
          tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean),
          status: status.value,
          body: body.value,
        };
        if (isOwner) Object.assign(input, { readScope: rs, writeScope: ws });
        save.disabled = true;
        try {
          if (a) {
            await api('PUT', `/api/articles/${a.id}`, { ...input, version: a.version });
            invalidateSidebar();
            navigate(`/wiki/${a.id}`);
          } else {
            if (idInput.value) input.id = idInput.value;
            const r = await api<ArticleSummary>('POST', '/api/articles', input);
            invalidateSidebar();
            navigate(`/wiki/${r.id}`);
          }
        } catch (e) {
          save.disabled = false;
          if (e instanceof ApiError && e.code === 'version_conflict') {
            status_.appendChild(h('div', { class: 'error' }, '他の人が先に更新しました。内容を控えてから ', h('a', { href: `/wiki/${a.id}`, target: '_blank', rel: 'noopener' }, '最新版'), ' を確認してください。'));
          } else status_.appendChild(errorBox(e));
        }
      },
    },
    h('div', { class: 'fields' },
      h('label', null, 'タイトル', title),
      a ? null : h('label', null, 'ID', idInput),
      h('label', null, '概要', description),
      h('label', null, 'タグ', tags),
      h('label', null, 'ステータス', status),
      h('label', null, '閲覧', readScope),
      h('label', null, '編集', writeScope),
    ),
    h('p', { class: 'muted' }, '他の記事へのリンク: [表示名](/wiki/記事ID)'),
    attachBar,
    h('div', { class: 'split' }, body, preview),
    status_,
    h('div', { class: 'actions' }, save, link(a ? `/wiki/${a.id}` : '/', h('span', { class: 'button secondary' }, 'キャンセル'))),
  );
  return h('div', null, h('h1', null, a ? `編集: ${a.title}` : '新しい記事'), form);
}

// ------------------------------------------------------------------ admin

async function adminView(path: string) {
  if (me.role !== 'admin') throw new Error('管理者のみアクセスできます。');
  const nav = h('nav', { class: 'tabs' }, ...[['/admin', 'ユーザ'], ['/admin/articles', '記事'], ['/admin/audit', '監査ログ'], ['/admin/okf', 'OKF 入出力']].map(([p, t]) => link(p!, h('span', { class: path === p ? 'tab active' : 'tab' }, t!))));
  let body: Node;
  if (path === '/admin') body = await adminUsers();
  else if (path === '/admin/articles') body = await adminArticles();
  else if (path === '/admin/audit') body = await adminAudit(new URLSearchParams(location.search).get('date') ?? new Date().toISOString().slice(0, 10));
  else if (path === '/admin/okf') body = adminOkf();
  else body = h('p', null, 'not found');
  return h('div', null, h('h1', null, '管理'), nav, body);
}

async function adminUsers() {
  const r = await api<{ items: any[] }>('GET', '/api/admin/users');
  const username = h('input', { type: 'text', placeholder: 'username', required: true, pattern: '[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}' });
  const email = h('input', { type: 'email', placeholder: 'email', required: true });
  const role = h('select', null, ...['viewer', 'editor', 'admin'].map((x) => h('option', { value: x }, x)));
  const msg = h('div', { role: 'status' });
  const invite = h(
    'form',
    {
      class: 'inline-form',
      onsubmit: async (ev: Event) => {
        ev.preventDefault();
        clear(msg);
        try {
          await api('POST', '/api/admin/users', { username: username.value, email: email.value, role: role.value });
          void render();
        } catch (e) {
          msg.appendChild(errorBox(e));
        }
      },
    },
    username, email, role, h('button', { type: 'submit' }, '招待'),
  );
  const rows = r.items.map((u) => {
    const sel = h('select', { disabled: u.username === me.username }, ...['viewer', 'editor', 'admin'].map((x) => h('option', { value: x, selected: u.role === x }, x)));
    sel.addEventListener('change', async () => {
      try {
        await api('PUT', `/api/admin/users/${encodeURIComponent(u.username)}`, { role: sel.value });
        void render();
      } catch (e) {
        alert(e instanceof Error ? e.message : String(e));
      }
    });
    const toggle = h('button', {
      class: u.enabled ? 'danger' : 'secondary',
      disabled: u.username === me.username,
      onclick: async () => {
        if (u.enabled && !confirm(`${u.username} を無効化しますか？`)) return;
        try {
          await api('PUT', `/api/admin/users/${encodeURIComponent(u.username)}`, { enabled: !u.enabled });
          void render();
        } catch (e) {
          alert(e instanceof Error ? e.message : String(e));
        }
      },
    }, u.enabled ? '無効化' : '有効化');
    return h('tr', null, h('td', null, u.username), h('td', null, u.email), h('td', null, sel), h('td', null, u.status), h('td', null, u.enabled ? '有効' : '無効'), h('td', null, fmtDate(u.createdAt)), h('td', null, toggle));
  });
  return h(
    'div',
    null,
    h('h2', null, 'ユーザ招待'),
    h('p', { class: 'muted' }, '招待メールに仮パスワードが届きます。初回ログイン時にパスワード変更と MFA (TOTP) 登録が必須です。'),
    invite,
    msg,
    h('h2', null, 'ユーザ一覧'),
    h('table', { class: 'grid' }, h('thead', null, h('tr', null, ...['ユーザ', 'メール', 'ロール', '状態', '有効', '作成', ''].map((t) => h('th', null, t)))), h('tbody', null, ...rows)),
    h('p', { class: 'muted' }, 'ロール変更・無効化を行うと、そのユーザの既存トークンは即時に無効になります。'),
  );
}

async function adminArticles() {
  const deleted = new URLSearchParams(location.search).get('deleted') === '1';
  const r = await api<{ items: ArticleSummary[] }>('GET', `/api/admin/articles?limit=200${deleted ? '&deleted=1' : ''}`);
  const rows = r.items.map((a) =>
    h(
      'tr',
      null,
      h('td', null, deleted ? a.title : link(`/wiki/${a.id}`, a.title)),
      h('td', null, a.id),
      h('td', null, a.ownerName),
      h('td', null, scopeBadge(a)),
      h('td', null, fmtDate(a.updatedAt)),
      h(
        'td',
        null,
        deleted
          ? h('button', { class: 'secondary', onclick: async () => (await api('POST', `/api/articles/${a.id}/restore`), void render()) }, '復元')
          : link(`/wiki/${a.id}/edit`, '権限・内容を編集'),
      ),
    ),
  );
  return h(
    'div',
    null,
    h('p', null, link(deleted ? '/admin/articles' : '/admin/articles?deleted=1', deleted ? '← 公開中の記事' : '削除済みの記事を表示')),
    h('table', { class: 'grid' }, h('thead', null, h('tr', null, ...['タイトル', 'ID', 'オーナー', '権限', '更新', ''].map((t) => h('th', null, t)))), h('tbody', null, ...rows)),
  );
}

async function adminAudit(date: string) {
  const r = await api<{ items: any[] }>('GET', `/api/admin/audit?date=${date}`);
  const picker = h('input', { type: 'date', value: date });
  picker.addEventListener('change', () => navigate(`/admin/audit?date=${picker.value}`));
  return h(
    'div',
    null,
    h('label', null, '日付 ', picker),
    h('table', { class: 'grid' }, h('thead', null, h('tr', null, ...['時刻', 'ユーザ', '経路', '操作', '記事', '詳細'].map((t) => h('th', null, t)))), h('tbody', null, ...r.items.map((e) => h('tr', null, h('td', null, fmtDate(e.ts)), h('td', null, e.actor), h('td', null, e.via), h('td', null, e.action), h('td', null, e.articleId ? link(`/wiki/${e.articleId}`, e.articleId) : ''), h('td', null, e.detail ?? ''))))),
    r.items.length ? null : h('p', { class: 'muted' }, '記録はありません。'),
  );
}

function adminOkf() {
  const msg = h('div', { role: 'status' });
  const file = h('input', { type: 'file', accept: '.zip,application/zip' });
  const exportBtn = h('button', {
    onclick: async () => {
      const r = await apiBlob('GET', '/api/export');
      if (!r.ok) return alert(r.json?.error?.message ?? `HTTP ${r.status}`);
      saveBlob(r.blob, 'mcpwiki-okf.zip');
    },
  }, 'OKF バンドルをダウンロード');
  const importBtn = h('button', {
    onclick: async () => {
      clear(msg);
      const f = file.files?.[0];
      if (!f) return;
      const r = await apiBlob('POST', '/api/admin/import', f, 'application/zip');
      if (!r.ok) return msg.appendChild(errorBox(new Error(r.json?.error?.message ?? `HTTP ${r.status}`)));
      const j = r.json;
      msg.appendChild(h('div', { class: 'notice' }, `作成 ${j.created.length} 件 / 更新 ${j.updated.length} 件 / スキップ ${j.skipped.length} 件`));
      if (j.skipped.length) msg.appendChild(h('ul', null, ...j.skipped.map((s: any) => h('li', null, `${s.name}: ${s.reason}`))));
    },
  }, 'インポート');
  const reindexBtn = h('button', {
    class: 'secondary',
    onclick: async () => {
      clear(msg);
      let cursor: string | undefined;
      let total = 0;
      const failed: string[] = [];
      do {
        const r: { processed: number; failed: string[]; cursor?: string } = await api('POST', '/api/admin/reindex', cursor ? { cursor } : {});
        total += r.processed;
        failed.push(...r.failed);
        cursor = r.cursor;
      } while (cursor);
      msg.appendChild(h('div', { class: 'notice' }, `再インデックス: ${total} 件処理、失敗 ${failed.length} 件${failed.length ? ` (${failed.join(', ')})` : ''}`));
    },
  }, '検索インデックス・リンクを再構築');
  return h(
    'div',
    null,
    h('h2', null, 'エクスポート'),
    h('p', { class: 'muted' }, 'Open Knowledge Format v0.2 のバンドル (index.md + wiki/<id>.md) を ZIP で出力します。'),
    exportBtn,
    h('h2', null, 'インポート'),
    h('p', { class: 'muted' }, 'OKF バンドルの ZIP を取り込みます。同じ ID の記事は更新されます (最大 1000 ファイル / 20MB)。'),
    file,
    ' ',
    importBtn,
    h('h2', null, 'メンテナンス'),
    reindexBtn,
    msg,
  );
}

// ------------------------------------------------------------------ boot

function header() {
  const q = h('input', { type: 'search', placeholder: '検索', 'aria-label': '検索' });
  const hdr = document.getElementById('header')!;
  clear(hdr);
  append(hdr, [
    h('button', {
      class: 'secondary menu-toggle',
      'aria-label': 'メニュー',
      'aria-controls': 'sidebar',
      onclick: () => document.body.classList.toggle('sidebar-open'),
    }, '☰'),
    link('/', h('span', { class: 'brand' }, 'MCPWiki')),
    h('form', { class: 'hsearch', onsubmit: (ev: Event) => (ev.preventDefault(), navigate(`/search?q=${encodeURIComponent(q.value)}`)) }, q),
    h(
      'nav',
      null,
      h('span', { class: 'user' }, `${me.username} (${me.role})`),
      h('button', { class: 'secondary', onclick: () => void logout() }, 'ログアウト'),
    ),
  ]);
}

// ------------------------------------------------------------------ sidebar (always visible; ☰ on small screens)

const sideRecent = h('ul', { class: 'side-list' });
const sideTags = h('div', { class: 'side-tags' });
let sidebarLoadedAt = 0;

function sidebar() {
  const el = document.getElementById('sidebar')!;
  clear(el);
  const nav = (href: string, label: string) => h('li', null, link(href, label));
  append(el, [
    h('nav', { class: 'side-section' }, h('ul', { class: 'side-list' },
      nav('/', 'トップ'),
      me.role !== 'viewer' ? nav('/new', '＋ 新規作成') : null,
      nav('/tags', 'タグ一覧'),
      nav('/graph', '全体グラフ'),
      me.role === 'admin' ? nav('/admin', '管理') : null,
    )),
    h('section', { class: 'side-section' }, h('h2', null, 'ヘルプ'), h('ul', { class: 'side-list' },
      nav('/wiki/help-wiki', 'MCPWiki の使い方'),
      nav('/wiki/help-markdown', 'Markdown の書き方'),
    )),
    h('section', { class: 'side-section' }, h('h2', null, '最近の更新'), sideRecent),
    h('section', { class: 'side-section' }, h('h2', null, 'タグ'), sideTags),
  ]);
}

const invalidateSidebar = () => {
  sidebarLoadedAt = 0;
};

/** Recent articles / tags are refreshed at most every 30s (and right after saving or deleting). */
async function refreshSidebar() {
  markActive();
  if (Date.now() - sidebarLoadedAt < 30_000) return;
  sidebarLoadedAt = Date.now();
  try {
    const [recent, tags] = await Promise.all([
      api<{ items: ArticleSummary[] }>('GET', '/api/articles?limit=10'),
      api<{ items: { tag: string; count: number }[] }>('GET', '/api/tags'),
    ]);
    clear(sideRecent);
    append(sideRecent, recent.items.map((a) => h('li', null, link(`/wiki/${a.id}`, a.title))));
    if (!recent.items.length) sideRecent.appendChild(h('li', { class: 'muted' }, 'まだ記事がありません'));
    clear(sideTags);
    append(sideTags, tags.items.slice(0, 30).map((t) => link(`/tags/${encodeURIComponent(t.tag)}`, h('span', { class: 'tag' }, `${t.tag} ${t.count}`))));
    markActive();
  } catch {
    sidebarLoadedAt = 0; // retry on the next navigation
  }
}

function markActive() {
  const path = decodeURI(location.pathname);
  for (const a of document.querySelectorAll<HTMLAnchorElement>('#sidebar a')) {
    const href = a.getAttribute('href') ?? '';
    const active = href === path || (href !== '/' && href.startsWith('/admin') && path.startsWith('/admin'));
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

async function boot() {
  const cfg = await loadConfig();
  document.body.dataset.env = cfg.env;
  try {
    await handleCallback();
  } catch (e) {
    main().appendChild(errorBox(e));
    main().appendChild(h('button', { onclick: () => void login() }, 'もう一度ログイン'));
    return;
  }
  if (!isSignedIn()) {
    clear(main());
    main().appendChild(
      h('div', { class: 'login' }, h('h1', null, 'MCPWiki'), h('p', null, 'サインインが必要です（多要素認証）。'), h('button', { onclick: () => void login() }, 'サインイン')),
    );
    return;
  }
  me = await api<Me>('GET', '/api/me');
  header();
  sidebar();
  await render();
}

boot().catch((e) => {
  clear(main());
  main().appendChild(errorBox(e));
});
