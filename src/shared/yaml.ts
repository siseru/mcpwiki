// Minimal YAML subset parser/serializer for OKF frontmatter.
// Supported: block mappings, block sequences (incl. sequences of mappings),
// flow sequences/mappings on a single line, plain / single- / double-quoted
// scalars, literal (|) and folded (>) block scalars, comments.
// Not supported (rejected or treated as plain text): anchors, aliases, tags,
// multi-line flow collections, multi-document streams.

import type { JsonValue } from './types.js';

export class YamlError extends Error {
  constructor(message: string, line?: number) {
    super(line === undefined ? message : `${message} (line ${line + 1})`);
    this.name = 'YamlError';
  }
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_DEPTH = 32;

interface Peeked {
  indent: number;
  content: string;
}

class BlockParser {
  private readonly lines: string[];
  private i = 0;

  constructor(src: string) {
    this.lines = src.replace(/\r\n?/g, '\n').split('\n');
  }

  parseDocument(): JsonValue {
    const first = this.peek();
    if (!first) return null;
    const value = this.parseBlock(first.indent, 0);
    const rest = this.peek();
    if (rest) throw new YamlError('unexpected content', this.i);
    return value;
  }

  private peek(): Peeked | null {
    while (this.i < this.lines.length) {
      const raw = this.lines[this.i]!;
      const trimmed = raw.trim();
      if (trimmed === '' || trimmed.startsWith('#')) {
        this.i++;
        continue;
      }
      const lead = raw.length - raw.trimStart().length;
      if (raw.slice(0, lead).includes('\t')) throw new YamlError('tabs are not allowed for indentation', this.i);
      return { indent: lead, content: raw.trim() };
    }
    return null;
  }

  private parseBlock(indent: number, depth: number): JsonValue {
    if (depth > MAX_DEPTH) throw new YamlError('nesting too deep', this.i);
    const l = this.peek();
    if (!l) return null;
    if (isSeqItem(l.content)) return this.parseSeq(indent, depth);
    if (splitKey(l.content)) return this.parseMap(indent, depth);
    // A lone scalar block (e.g. the whole document is a scalar).
    this.i++;
    return parseInline(l.content, this.i - 1);
  }

  private parseMap(indent: number, depth: number): Record<string, JsonValue> {
    const obj: Record<string, JsonValue> = {};
    for (;;) {
      const l = this.peek();
      if (!l || l.indent < indent) break;
      if (l.indent > indent) throw new YamlError('bad indentation', this.i);
      if (isSeqItem(l.content)) break;
      const kv = splitKey(l.content);
      if (!kv) throw new YamlError('expected "key: value"', this.i);
      const [key, rest] = kv;
      if (FORBIDDEN_KEYS.has(key)) throw new YamlError(`forbidden key "${key}"`, this.i);
      if (Object.prototype.hasOwnProperty.call(obj, key)) throw new YamlError(`duplicate key "${key}"`, this.i);
      const lineNo = this.i;
      this.i++;
      let value: JsonValue;
      if (rest === '') {
        const next = this.peek();
        if (next && next.indent > indent) value = this.parseBlock(next.indent, depth + 1);
        else if (next && next.indent === indent && isSeqItem(next.content)) value = this.parseSeq(indent, depth + 1);
        else value = null;
      } else if (/^[|>][-+]?$/.test(stripComment(rest))) {
        value = this.parseBlockScalar(stripComment(rest), indent);
      } else {
        value = parseInline(rest, lineNo);
      }
      obj[key] = value;
    }
    return obj;
  }

  private parseSeq(indent: number, depth: number): JsonValue[] {
    const arr: JsonValue[] = [];
    for (;;) {
      const l = this.peek();
      if (!l || l.indent < indent) break;
      if (l.indent > indent) throw new YamlError('bad indentation', this.i);
      if (!isSeqItem(l.content)) break;
      const rest = l.content.slice(1).trimStart();
      const itemIndent = indent + (l.content.length - rest.length);
      if (rest === '') {
        this.i++;
        const next = this.peek();
        arr.push(next && next.indent > indent ? this.parseBlock(next.indent, depth + 1) : null);
      } else if (isSeqItem(rest) || (splitKey(rest) && !/^[[{"']/.test(rest))) {
        // "- key: v" or "- - x": re-read this line as a nested block at itemIndent.
        this.lines[this.i] = ' '.repeat(itemIndent) + rest;
        arr.push(this.parseBlock(itemIndent, depth + 1));
      } else if (/^[|>][-+]?$/.test(stripComment(rest))) {
        this.i++;
        arr.push(this.parseBlockScalar(stripComment(rest), indent));
      } else {
        this.i++;
        arr.push(parseInline(rest, this.i - 1));
      }
    }
    return arr;
  }

  private parseBlockScalar(header: string, parentIndent: number): string {
    const folded = header[0] === '>';
    const chomp = header[1] ?? '';
    const collected: string[] = [];
    let contentIndent = -1;
    while (this.i < this.lines.length) {
      const raw = this.lines[this.i]!;
      if (raw.trim() === '') {
        collected.push('');
        this.i++;
        continue;
      }
      const lead = raw.length - raw.trimStart().length;
      if (lead <= parentIndent) break;
      if (contentIndent < 0) contentIndent = lead;
      if (lead < contentIndent) break;
      collected.push(raw.slice(contentIndent));
      this.i++;
    }
    // Trailing blank lines belong to chomping, not content.
    let trailing = 0;
    while (collected.length && collected[collected.length - 1] === '') {
      collected.pop();
      trailing++;
    }
    let text: string;
    if (folded) {
      text = '';
      for (let k = 0; k < collected.length; k++) {
        const line = collected[k]!;
        if (k === 0) text = line;
        else if (line === '') text += '\n';
        else if (collected[k - 1] === '') text += line;
        else text += ' ' + line;
      }
    } else {
      text = collected.join('\n');
    }
    if (chomp === '-' || collected.length === 0) return text;
    if (chomp === '+') return text + '\n'.repeat(trailing + 1);
    return text + '\n';
  }
}

function isSeqItem(content: string): boolean {
  return content === '-' || content.startsWith('- ');
}

/** Split "key: rest" (key may be quoted). Returns null when the line isn't a mapping entry. */
function splitKey(content: string): [string, string] | null {
  if (content.startsWith('"') || content.startsWith("'")) {
    const q = readQuoted(content, 0);
    if (!q) return null;
    const after = content.slice(q.end);
    const m = /^\s*:(?:\s+|$)/.exec(after);
    if (!m) return null;
    return [q.value, after.slice(m[0].length).trim()];
  }
  if (/^[[{#&*!|>%@`]/.test(content) || isSeqItem(content)) return null;
  for (let k = 0; k < content.length; k++) {
    const c = content[k];
    if (c === '#' && k > 0 && /\s/.test(content[k - 1]!)) return null;
    if (c === ':' && (k + 1 === content.length || content[k + 1] === ' ')) {
      const key = content.slice(0, k).trim();
      if (key === '') return null;
      return [key, content.slice(k + 1).trim()];
    }
  }
  return null;
}

function stripComment(s: string): string {
  const m = /(^|\s)#/.exec(s);
  return (m ? s.slice(0, m.index) : s).trim();
}

function parseInline(text: string, line: number): JsonValue {
  const t = text.trim();
  if (t.startsWith('[') || t.startsWith('{') || t.startsWith('"') || t.startsWith("'")) {
    const fp = new FlowParser(t, line);
    const v = fp.parseValue(false);
    fp.expectEnd();
    return v;
  }
  if (/^[&*!]/.test(t)) throw new YamlError('anchors, aliases and tags are not supported', line);
  return resolvePlain(stripComment(t));
}

export function resolvePlain(s: string): JsonValue {
  if (s === '' || s === '~' || /^(null|Null|NULL)$/.test(s)) return null;
  if (/^(true|True|TRUE)$/.test(s)) return true;
  if (/^(false|False|FALSE)$/.test(s)) return false;
  if (/^[-+]?(0|[1-9][0-9]*)$/.test(s)) {
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : s;
  }
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? n : s;
  }
  return s;
}

function readQuoted(s: string, pos: number): { value: string; end: number } | null {
  const q = s[pos];
  if (q === "'") {
    let out = '';
    for (let k = pos + 1; k < s.length; k++) {
      if (s[k] === "'") {
        if (s[k + 1] === "'") {
          out += "'";
          k++;
          continue;
        }
        return { value: out, end: k + 1 };
      }
      out += s[k];
    }
    return null;
  }
  if (q === '"') {
    let out = '';
    for (let k = pos + 1; k < s.length; k++) {
      const c = s[k]!;
      if (c === '"') return { value: out, end: k + 1 };
      if (c !== '\\') {
        out += c;
        continue;
      }
      const e = s[++k];
      switch (e) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case '0': out += '\0'; break;
        case ' ': out += ' '; break;
        case 'x': case 'u': case 'U': {
          const len = e === 'x' ? 2 : e === 'u' ? 4 : 8;
          const hex = s.slice(k + 1, k + 1 + len);
          if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex)) return null;
          const cp = parseInt(hex, 16);
          if (cp > 0x10ffff) return null;
          out += String.fromCodePoint(cp);
          k += len;
          break;
        }
        default:
          return null;
      }
    }
    return null;
  }
  return null;
}

class FlowParser {
  private pos = 0;
  private depth = 0;
  constructor(private readonly s: string, private readonly line: number) {}

  private ws(): void {
    while (this.pos < this.s.length && /\s/.test(this.s[this.pos]!)) this.pos++;
  }

  expectEnd(): void {
    this.ws();
    const rest = this.s.slice(this.pos);
    if (rest !== '' && !rest.startsWith('#')) throw new YamlError('unexpected characters after value', this.line);
  }

  parseValue(inFlow: boolean): JsonValue {
    this.ws();
    const c = this.s[this.pos];
    if (c === '[' || c === '{') {
      if (++this.depth > MAX_DEPTH) throw new YamlError('nesting too deep', this.line);
      const v = c === '[' ? this.parseSeq() : this.parseMap();
      this.depth--;
      return v;
    }
    if (c === '"' || c === "'") {
      const q = readQuoted(this.s, this.pos);
      if (!q) throw new YamlError('unterminated or invalid quoted string', this.line);
      this.pos = q.end;
      return q.value;
    }
    return resolvePlain(this.readPlain(inFlow, false));
  }

  private readPlain(inFlow: boolean, isKey: boolean): string {
    const start = this.pos;
    while (this.pos < this.s.length) {
      const c = this.s[this.pos]!;
      if (inFlow && (c === ',' || c === ']' || c === '}')) break;
      if (isKey && c === ':' && /[\s,\]}]/.test(this.s[this.pos + 1] ?? ' ')) break;
      if (c === '#' && this.pos > start && /\s/.test(this.s[this.pos - 1]!)) break;
      this.pos++;
    }
    return this.s.slice(start, this.pos).trim();
  }

  private parseSeq(): JsonValue[] {
    this.pos++; // [
    const arr: JsonValue[] = [];
    this.ws();
    if (this.s[this.pos] === ']') {
      this.pos++;
      return arr;
    }
    for (;;) {
      arr.push(this.parseValue(true));
      this.ws();
      const c = this.s[this.pos];
      if (c === ',') {
        this.pos++;
        this.ws();
        if (this.s[this.pos] === ']') {
          this.pos++;
          return arr;
        }
        continue;
      }
      if (c === ']') {
        this.pos++;
        return arr;
      }
      throw new YamlError('expected "," or "]"', this.line);
    }
  }

  private parseMap(): Record<string, JsonValue> {
    this.pos++; // {
    const obj: Record<string, JsonValue> = {};
    this.ws();
    if (this.s[this.pos] === '}') {
      this.pos++;
      return obj;
    }
    for (;;) {
      this.ws();
      let key: string;
      const c = this.s[this.pos];
      if (c === '"' || c === "'") {
        const q = readQuoted(this.s, this.pos);
        if (!q) throw new YamlError('invalid quoted key', this.line);
        this.pos = q.end;
        key = q.value;
      } else {
        key = this.readPlain(true, true);
      }
      if (FORBIDDEN_KEYS.has(key)) throw new YamlError(`forbidden key "${key}"`, this.line);
      if (Object.prototype.hasOwnProperty.call(obj, key)) throw new YamlError(`duplicate key "${key}"`, this.line);
      this.ws();
      if (this.s[this.pos] === ':') {
        this.pos++;
        obj[key] = this.parseValue(true);
      } else {
        obj[key] = null;
      }
      this.ws();
      const d = this.s[this.pos];
      if (d === ',') {
        this.pos++;
        this.ws();
        if (this.s[this.pos] === '}') {
          this.pos++;
          return obj;
        }
        continue;
      }
      if (d === '}') {
        this.pos++;
        return obj;
      }
      throw new YamlError('expected "," or "}"', this.line);
    }
  }
}

export function parseYaml(src: string): JsonValue {
  return new BlockParser(src).parseDocument();
}

// ---------------------------------------------------------------- serializer

function needsQuote(s: string, inFlow: boolean): boolean {
  if (s === '' || s !== s.trim()) return true;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return true;
  if (/:\s|:$|\s#/.test(s)) return true;
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(s)) return true;
  if (inFlow && /[,[\]{}]/.test(s)) return true;
  return resolvePlain(s) !== s;
}

function scalar(v: JsonValue, inFlow: boolean): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new YamlError('non-finite numbers are not supported');
    return String(v);
  }
  if (typeof v === 'string') return needsQuote(v, inFlow) ? JSON.stringify(v) : v;
  return flow(v);
}

/** JSON-ish flow representation (valid YAML). */
function flow(v: JsonValue): string {
  if (Array.isArray(v)) return '[' + v.map((x) => flow(x)).join(', ') + ']';
  if (v !== null && typeof v === 'object') {
    return '{ ' + Object.entries(v).map(([k, x]) => `${scalar(k, true)}: ${flow(x)}`).join(', ') + ' }';
  }
  return scalar(v, true);
}

function isScalar(v: JsonValue): v is string | number | boolean | null {
  return v === null || typeof v !== 'object';
}

function emitMap(obj: Record<string, JsonValue>, indent: number, out: string[]): void {
  const pad = ' '.repeat(indent);
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    const key = scalar(k, false);
    if (isScalar(v)) {
      out.push(`${pad}${key}: ${scalar(v, false)}`);
    } else if (Array.isArray(v)) {
      if (v.length === 0) {
        out.push(`${pad}${key}: []`);
      } else if (v.every(isScalar) && flow(v).length <= 80) {
        out.push(`${pad}${key}: ${flow(v)}`);
      } else {
        out.push(`${pad}${key}:`);
        emitSeq(v, indent + 2, out);
      }
    } else if (Object.keys(v).length === 0) {
      out.push(`${pad}${key}: {}`);
    } else {
      out.push(`${pad}${key}:`);
      emitMap(v, indent + 2, out);
    }
  }
}

function emitSeq(arr: JsonValue[], indent: number, out: string[]): void {
  const pad = ' '.repeat(indent);
  for (const item of arr) {
    if (item !== null && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length > 0) {
      const sub: string[] = [];
      emitMap(item, indent + 2, sub);
      sub[0] = pad + '- ' + sub[0]!.slice(indent + 2);
      out.push(...sub);
    } else if (isScalar(item)) {
      out.push(`${pad}- ${scalar(item, false)}`);
    } else {
      out.push(`${pad}- ${flow(item)}`);
    }
  }
}

export function stringifyYaml(obj: Record<string, JsonValue>): string {
  const out: string[] = [];
  emitMap(obj, 0, out);
  return out.length ? out.join('\n') + '\n' : '';
}
