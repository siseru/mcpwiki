// Tokenization for the search index, and wiki link extraction for the graph.

export const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}ー々〆';
const TOKEN_RE = new RegExp(`[${CJK}]+|(?:(?![${CJK}])[\\p{L}\\p{N}_])+`, 'gu');
const CJK_RUN_RE = new RegExp(`^[${CJK}]+$`, 'u');

export const MAX_TOKEN_LENGTH = 40;

export function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

/**
 * Split text into search tokens.
 * CJK runs become character bigrams (a 1-char run is kept as a unigram);
 * other letters/digits become whole words (>= 2 chars, or any digit run).
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of normalize(text).matchAll(TOKEN_RE)) {
    const run = m[0];
    if (CJK_RUN_RE.test(run)) {
      const chars = [...run];
      if (chars.length === 1) out.push(chars[0]!);
      for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i]! + chars[i + 1]!);
    } else if ((run.length >= 2 || /^\d+$/.test(run)) && run.length <= MAX_TOKEN_LENGTH) {
      out.push(run);
    }
  }
  return out;
}

export const MAX_INDEX_TERMS = 2000;
export const MAX_INDEXED_BODY_CHARS = 100_000;

/** Term weights for one article: body tf (capped) + title/tag boosts. */
export function indexTerms(title: string, tags: string[], description: string, body: string): Record<string, number> {
  const w = new Map<string, number>();
  const add = (tokens: string[], weight: number, cap: number) => {
    const seen = new Map<string, number>();
    for (const t of tokens) seen.set(t, (seen.get(t) ?? 0) + 1);
    for (const [t, n] of seen) w.set(t, (w.get(t) ?? 0) + Math.min(n, cap) * weight);
  };
  add(tokenize(stripMarkdown(body.slice(0, MAX_INDEXED_BODY_CHARS))), 1, 10);
  add(tokenize(description), 3, 3);
  add(tokenize(tags.join(' ')), 5, 1);
  add(tokenize(title), 10, 2);
  const sorted = [...w.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, MAX_INDEX_TERMS);
  return Object.fromEntries(sorted);
}

// All patterns below run on user-controlled bodies (up to 256KB), so every quantifier
// is bounded and stops at newlines to keep matching linear (no catastrophic backtracking).
const MD_IMAGE_RE = /!\[([^\]\n]{0,500})\]\([^)\n]{0,2000}\)/g;
const MD_LINK_RE = /\[([^\]\n]{0,500})\]\([^)\n]{0,2000}\)/g;
const MD_REFDEF_RE = /^ {0,3}\[[^\]\n]{1,500}\]:[^\n]*$/gm;
const HTML_TAG_RE = /<[^<>\n]{0,500}>/g;

/** Rough markdown -> text for indexing and snippets (link URLs removed, code kept). */
export function stripMarkdown(md: string): string {
  return md
    .replace(MD_IMAGE_RE, '$1')
    .replace(MD_LINK_RE, '$1')
    .replace(MD_REFDEF_RE, '')
    .replace(HTML_TAG_RE, ' ')
    .replace(/[#>*_~`|]+/g, ' ')
    .replace(/[ \t]+/g, ' ');
}

export const MAX_SNIPPET_SOURCE_CHARS = 20_000;

/** Short excerpt around the first query token. */
export function snippet(body: string, query: string, length = 160): string {
  const text = stripMarkdown(body.slice(0, MAX_SNIPPET_SOURCE_CHARS)).replace(/\s+/g, ' ').trim();
  const lower = normalize(text);
  let at = -1;
  for (const t of tokenize(query)) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = Math.max(0, at < 0 ? 0 : at - Math.floor(length / 3));
  const s = [...text.slice(start, start + length * 2)].slice(0, length).join('');
  return (start > 0 ? '…' : '') + s + (start + s.length < text.length ? '…' : '');
}

/** Remove fenced and inline code so links inside code are ignored (line scanner, linear time). */
function stripCode(md: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of md.split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1]!.startsWith(fence)) fence = null;
      continue;
    }
    if (m) {
      fence = m[1]!;
      continue;
    }
    out.push(line.replace(/`[^`\n]{0,2000}`/g, ''));
  }
  return out.join('\n');
}

/**
 * Extract ids of linked wiki articles.
 * Accepts `/wiki/<id>`, `/wiki/<id>.md` and relative `<id>.md` / `../wiki/<id>.md`.
 */
export function extractLinks(body: string, selfId?: string, max = 200): string[] {
  const md = stripCode(body);
  const targets: string[] = [];
  for (const m of md.matchAll(/\]\([ \t]{0,10}<?([^)\s>]{1,2000})/g)) targets.push(m[1]!);
  for (const m of md.matchAll(/^ {0,3}\[[^\]\n]{1,500}\]:[ \t]{0,10}<?([^\s>]{1,2000})/gm)) targets.push(m[1]!);
  const ids = new Set<string>();
  for (const raw of targets) {
    const id = linkTargetToId(raw);
    if (id && id !== selfId) ids.add(id);
    if (ids.size >= max) break;
  }
  return [...ids];
}

export function linkTargetToId(raw: string): string | null {
  let t = raw.split('#')[0]!.split('?')[0]!;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('//')) return null; // absolute URL
  try {
    t = decodeURIComponent(t);
  } catch {
    return null;
  }
  let m = /^\/wiki\/([^/]+?)(?:\.md)?\/?$/.exec(t);
  if (!m) m = /^(?:\.{1,2}\/)*(?:wiki\/)?([^/]+)\.md$/.exec(t);
  if (!m) return null;
  return ID_RE.test(m[1]!) ? m[1]! : null;
}
