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

/** Rough markdown -> text for indexing and snippets (link URLs removed, code kept). */
export function stripMarkdown(md: string): string {
  return md
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}\[[^\]]+\]:\s*\S+.*$/gm, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#>*_~`|]+/g, ' ')
    .replace(/[ \t]+/g, ' ');
}

/** Short excerpt around the first query token. */
export function snippet(body: string, query: string, length = 160): string {
  const text = stripMarkdown(body).replace(/\s+/g, ' ').trim();
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

/** Remove fenced and inline code so links inside code are ignored. */
function stripCode(md: string): string {
  return md.replace(/^(\s*)(```|~~~)[^\n]*\n[\s\S]*?^\1\2[^\n]*$/gm, '').replace(/`[^`\n]*`/g, '');
}

/**
 * Extract ids of linked wiki articles.
 * Accepts `/wiki/<id>`, `/wiki/<id>.md` and relative `<id>.md` / `../wiki/<id>.md`.
 */
export function extractLinks(body: string, selfId?: string, max = 200): string[] {
  const md = stripCode(body);
  const targets: string[] = [];
  for (const m of md.matchAll(/\]\(\s*<?([^)\s>]+)/g)) targets.push(m[1]!);
  for (const m of md.matchAll(/^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/gm)) targets.push(m[1]!);
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
