// Input validation shared by API, MCP and CLI.
import type { ArticleInput, JsonValue } from './types.js';
import { READ_SCOPES, STATUSES, WRITE_SCOPES } from './types.js';
import { RESERVED_KEYS } from './okf.js';
import { scopesValid } from './permissions.js';
import { ID_RE } from './text.js';
import { FORBIDDEN_KEYS } from './yaml.js';

export const LIMITS = {
  titleChars: 200,
  descriptionChars: 500,
  typeChars: 100,
  tags: 20,
  tagChars: 50,
  bodyBytes: 256 * 1024,
  extraBytes: 16 * 1024,
  extraKeys: 50,
};

const TAG_RE = /^[\p{L}\p{N}][\p{L}\p{N}_\-.+ ]*$/u;
const EXTRA_KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
/** C1 controls and bidi overrides: allowed in bodies, rejected in single-line fields (spoofing / terminal escapes). */
const LINE_UNSAFE_RE = /[\u0080-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

export class ValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(errors.join('; '));
    this.name = 'ValidationError';
  }
}

export function normalizeTag(tag: string): string {
  return tag.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function hasForbiddenKey(v: JsonValue): boolean {
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.some(hasForbiddenKey);
  return Object.keys(v).some((k) => FORBIDDEN_KEYS.has(k)) || Object.values(v).some(hasForbiddenKey);
}

function jsonDepth(v: JsonValue, d = 0): number {
  if (v === null || typeof v !== 'object') return d;
  const children = Array.isArray(v) ? v : Object.values(v);
  return children.reduce<number>((m, c) => Math.max(m, jsonDepth(c, d + 1)), d + 1);
}

/**
 * Validate and normalize an article input. Throws ValidationError.
 * `partial` = update (only supplied fields are checked).
 */
export function validateArticleInput(input: unknown, partial: boolean): ArticleInput {
  const errors: string[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError(['body must be a JSON object']);
  const src = input as Record<string, unknown>;
  const out: ArticleInput = {};

  const string = (key: string, max: number, required: boolean): string | undefined => {
    const v = src[key];
    if (v === undefined || v === null) {
      if (required) errors.push(`${key} is required`);
      return undefined;
    }
    if (typeof v !== 'string') {
      errors.push(`${key} must be a string`);
      return undefined;
    }
    const s = v.normalize('NFC').trim();
    if ([...s].length > max) errors.push(`${key} must be at most ${max} characters`);
    if (CONTROL_RE.test(s) || LINE_UNSAFE_RE.test(s) || /[\r\n]/.test(s)) errors.push(`${key} must not contain control characters or newlines`);
    return s;
  };

  if (src.id !== undefined) {
    if (typeof src.id !== 'string' || !ID_RE.test(src.id)) errors.push('id must match ^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$');
    else out.id = src.id;
  }
  const title = string('title', LIMITS.titleChars, !partial);
  if (title !== undefined) {
    if (title === '') errors.push('title must not be empty');
    out.title = title;
  }
  const description = string('description', LIMITS.descriptionChars, false);
  if (description !== undefined) out.description = description;
  const type = string('type', LIMITS.typeChars, false);
  if (type !== undefined && type !== '') out.type = type;

  if (src.tags !== undefined && src.tags !== null) {
    if (!Array.isArray(src.tags) || !src.tags.every((t) => typeof t === 'string')) {
      errors.push('tags must be an array of strings');
    } else {
      const tags = [...new Set((src.tags as string[]).map(normalizeTag).filter(Boolean))];
      if (tags.length > LIMITS.tags) errors.push(`at most ${LIMITS.tags} tags`);
      for (const t of tags) {
        if ([...t].length > LIMITS.tagChars || !TAG_RE.test(t) || LINE_UNSAFE_RE.test(t)) errors.push(`invalid tag "${t.slice(0, 60)}"`);
      }
      out.tags = tags;
    }
  } else if (!partial) {
    out.tags = [];
  }

  if (src.status !== undefined) {
    if (!(STATUSES as readonly unknown[]).includes(src.status)) errors.push(`status must be one of ${STATUSES.join(', ')}`);
    else out.status = src.status as ArticleInput['status'];
  }
  if (src.readScope !== undefined) {
    if (!(READ_SCOPES as readonly unknown[]).includes(src.readScope)) errors.push(`readScope must be one of ${READ_SCOPES.join(', ')}`);
    else out.readScope = src.readScope as ArticleInput['readScope'];
  }
  if (src.writeScope !== undefined) {
    if (!(WRITE_SCOPES as readonly unknown[]).includes(src.writeScope)) errors.push(`writeScope must be one of ${WRITE_SCOPES.join(', ')}`);
    else out.writeScope = src.writeScope as ArticleInput['writeScope'];
  }

  if (src.body !== undefined) {
    if (typeof src.body !== 'string') errors.push('body must be a string');
    else {
      const body = src.body.replace(/\r\n?/g, '\n');
      if (utf8Length(body) > LIMITS.bodyBytes) errors.push(`body must be at most ${LIMITS.bodyBytes} bytes`);
      if (CONTROL_RE.test(body)) errors.push('body must not contain control characters');
      out.body = body;
    }
  } else if (!partial) {
    out.body = '';
  }

  if (src.extra !== undefined && src.extra !== null) {
    const extra = src.extra;
    if (typeof extra !== 'object' || Array.isArray(extra)) errors.push('extra must be an object');
    else {
      const e = extra as Record<string, JsonValue>;
      const keys = Object.keys(e);
      if (keys.length > LIMITS.extraKeys) errors.push(`extra has too many keys`);
      for (const k of keys) {
        if (!EXTRA_KEY_RE.test(k)) errors.push(`invalid extra key "${k.slice(0, 64)}"`);
        if (RESERVED_KEYS.has(k)) errors.push(`extra key "${k}" is reserved`);
      }
      if (utf8Length(JSON.stringify(e)) > LIMITS.extraBytes) errors.push('extra is too large');
      if (jsonDepth(e) > 8) errors.push('extra is nested too deeply');
      if (hasForbiddenKey(e)) errors.push('extra must not contain __proto__, constructor or prototype keys');
      out.extra = e;
    }
  }

  if (out.readScope && out.writeScope && !scopesValid(out.readScope, out.writeScope)) {
    errors.push('writeScope must not be wider than readScope');
  }
  if (errors.length) throw new ValidationError(errors);
  return out;
}

const encoder = new TextEncoder();
export function utf8Length(s: string): number {
  return encoder.encode(s).length;
}
