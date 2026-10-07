// Open Knowledge Format (OKF v0.2) document mapping.
// https://github.com/GoogleCloudPlatform/open-knowledge-format
import type { ArticleMeta, JsonValue, ReadScope, Status, WriteScope } from './types.js';
import { READ_SCOPES, STATUSES, WRITE_SCOPES } from './types.js';
import { parseYaml, stringifyYaml, YamlError } from './yaml.js';

export const OKF_VERSION = '0.2';
export const DEFAULT_TYPE = 'Wiki Article';
/** Directory articles live in inside an exported bundle. Concept id = `wiki/<id>`. */
export const BUNDLE_DIR = 'wiki';
/** Extension key holding MCPWiki-specific metadata. */
export const EXT_KEY = 'mcpwiki';

/** Frontmatter keys MCPWiki manages; everything else is preserved as `extra`. */
export const RESERVED_KEYS = new Set([
  'type', 'title', 'description', 'tags', 'status', 'generated', 'verified', 'timestamp', EXT_KEY,
]);

export interface OkfDocument {
  frontmatter: Record<string, JsonValue>;
  body: string;
}

export function parseOkfDocument(text: string): OkfDocument {
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!src.startsWith('---\n')) return { frontmatter: {}, body: src };
  const end = src.indexOf('\n---', 3);
  if (end < 0) throw new YamlError('unterminated frontmatter');
  const after = src.slice(end + 4);
  if (after !== '' && !after.startsWith('\n')) throw new YamlError('frontmatter closing line must be "---"');
  const fm = parseYaml(src.slice(4, end + 1));
  if (fm !== null && (typeof fm !== 'object' || Array.isArray(fm))) throw new YamlError('frontmatter must be a mapping');
  let body = after.slice(1);
  if (body.startsWith('\n')) body = body.slice(1);
  return { frontmatter: (fm ?? {}) as Record<string, JsonValue>, body };
}

export function serializeOkfDocument(doc: OkfDocument): string {
  return `---\n${stringifyYaml(doc.frontmatter)}---\n\n${doc.body}`;
}

export function articleFrontmatter(meta: ArticleMeta): Record<string, JsonValue> {
  const fm: Record<string, JsonValue> = { type: meta.type || DEFAULT_TYPE, title: meta.title };
  if (meta.description) fm.description = meta.description;
  fm.tags = meta.tags;
  fm.status = meta.status;
  fm.generated = { by: meta.generatedBy, at: meta.updatedAt };
  if (meta.verified.length) fm.verified = meta.verified.map((v) => ({ by: v.by, at: v.at }));
  for (const [k, v] of Object.entries(meta.extra)) if (!RESERVED_KEYS.has(k)) fm[k] = v;
  fm[EXT_KEY] = {
    id: meta.id,
    owner: meta.ownerName,
    read_scope: meta.readScope,
    write_scope: meta.writeScope,
    version: meta.version,
    created_at: meta.createdAt,
    updated_by: meta.updatedBy,
  };
  return fm;
}

export function articleToOkf(meta: ArticleMeta, body: string): string {
  return serializeOkfDocument({ frontmatter: articleFrontmatter(meta), body });
}

/** Fields recovered from an OKF document (import / CLI editing). */
export interface OkfArticleFields {
  type?: string;
  title?: string;
  description?: string;
  tags?: string[];
  status?: Status;
  verified?: { by: string; at: string }[];
  readScope?: ReadScope;
  writeScope?: WriteScope;
  id?: string;
  version?: number;
  extra: Record<string, JsonValue>;
  body: string;
}

function str(v: JsonValue | undefined): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

export function okfToArticleFields(doc: OkfDocument): OkfArticleFields {
  const fm = doc.frontmatter;
  const out: OkfArticleFields = { extra: {}, body: doc.body };
  out.type = str(fm.type);
  out.title = str(fm.title);
  out.description = str(fm.description);
  if (Array.isArray(fm.tags)) out.tags = fm.tags.map((t) => str(t)).filter((t): t is string => !!t);
  else if (typeof fm.tags === 'string') out.tags = fm.tags.split(',').map((t) => t.trim()).filter(Boolean);
  const status = str(fm.status);
  if (status && (STATUSES as readonly string[]).includes(status)) out.status = status as Status;
  const verified = Array.isArray(fm.verified) ? fm.verified : fm.verified && typeof fm.verified === 'object' ? [fm.verified] : [];
  out.verified = verified
    .map((v) => (v && typeof v === 'object' && !Array.isArray(v) ? { by: str(v.by) ?? '', at: str(v.at) ?? '' } : null))
    .filter((v): v is { by: string; at: string } => !!v && !!v.by);
  const ext = fm[EXT_KEY];
  if (ext && typeof ext === 'object' && !Array.isArray(ext)) {
    out.id = str(ext.id);
    const rs = str(ext.read_scope);
    if (rs && (READ_SCOPES as readonly string[]).includes(rs)) out.readScope = rs as ReadScope;
    const ws = str(ext.write_scope);
    if (ws && (WRITE_SCOPES as readonly string[]).includes(ws)) out.writeScope = ws as WriteScope;
    if (typeof ext.version === 'number') out.version = ext.version;
  }
  for (const [k, v] of Object.entries(fm)) if (!RESERVED_KEYS.has(k)) out.extra[k] = v;
  return out;
}

/** Rewrite internal links `/wiki/<id>` -> `/wiki/<id>.md` for bundle export. */
export function toBundleLinks(body: string): string {
  return body.replace(/(\]\(\s*<?)\/wiki\/([a-z0-9-]+)(?!\.md)(?=[)#?\s>])/g, '$1/wiki/$2.md');
}

/** Bundle-root index.md (OKF: no frontmatter except okf_version at the root). */
export function bundleIndex(metas: ArticleMeta[], title: string): string {
  const lines = ['---', `okf_version: "${OKF_VERSION}"`, '---', '', `# ${title}`, ''];
  const byType = new Map<string, ArticleMeta[]>();
  for (const m of metas) {
    const t = m.type || DEFAULT_TYPE;
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t)!.push(m);
  }
  for (const [type, list] of [...byType.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`## ${type}`, '');
    for (const m of list.sort((a, b) => a.title.localeCompare(b.title))) {
      const desc = m.description ? ` - ${m.description.replace(/\s+/g, ' ')}` : '';
      lines.push(`* [${escapeLinkText(m.title)}](/${BUNDLE_DIR}/${m.id}.md)${desc}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function escapeLinkText(s: string): string {
  return s.replace(/([\\[\]])/g, '\\$1');
}
