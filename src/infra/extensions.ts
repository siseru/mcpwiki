// Optional extensions: separately deployed UI bundles served from the wiki's own origin (see docs/extensions.md).
// Configured per environment, kept out of git: config/extensions.local.json, the secret MCPWIKI_EXTENSIONS
// (one-line JSON) or -c extensions='<json>'. An empty or missing configuration must synthesize exactly what a
// wiki without this feature synthesizes.
import { EXTENSION_CONTRACTS } from '../shared/types.js';

export interface ExtensionConfig {
  /** Path segment under /ext/ and /apps/. */
  id: string;
  /** Host API contract version the bundle was built for. */
  contract: number;
  /** Regional domain of the extension's own bucket; objects live under ext/<id>/. */
  bucketRegionalDomainName: string;
  /** Bundle file name under ext/<id>/ (content-hashed: served as immutable). */
  script: string;
  /** Subresource Integrity of the bundle: the browser refuses any other content. */
  integrity: string;
  /** Endpoints the bundle may connect to (added to the CSP connect-src). */
  connectSrc: string[];
}

export type ExtensionsByEnv = Partial<Record<'dev' | 'prod', ExtensionConfig[]>>;

const ID = /^[a-z][a-z0-9-]{1,30}$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const SCRIPT = /^[A-Za-z0-9._-]{1,100}\.js$/;
const INTEGRITY = /^sha(384|512)-[A-Za-z0-9+/]{43,88}={0,2}$/;
const LABEL = '(?!-)[a-z0-9-]{1,63}(?<!-)';
const HOST = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);
const MAX_CONNECT_SRC = 4;

/**
 * Validates one environment's extension list. Every value ends up in CloudFront origins, the CSP header or
 * config.json, so anything outside the expected shapes is rejected rather than escaped.
 */
export function validateExtensions(raw: unknown, region: string): ExtensionConfig[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('extensions: expected an array per environment');
  // No regular expression is built from the region: compare the suffix as a plain string.
  const bucketSuffix = `.s3.${region}.amazonaws.com`;
  const isBucketDomain = (d: string) => d.endsWith(bucketSuffix) && BUCKET.test(d.slice(0, -bucketSuffix.length));
  const seen = new Set<string>();
  return raw.map((e: unknown, i: number) => {
    const at = `extensions[${i}]`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error(`${at}: expected an object`);
    const x = e as Record<string, unknown>;
    const allowed = new Set(['id', 'contract', 'bucketRegionalDomainName', 'script', 'integrity', 'connectSrc']);
    for (const k of Object.keys(x)) if (!allowed.has(k)) throw new Error(`${at}: unknown key ${k}`);
    if (typeof x.id !== 'string' || !ID.test(x.id)) throw new Error(`${at}: invalid id`);
    if (seen.has(x.id)) throw new Error(`${at}: duplicate id ${x.id}`);
    seen.add(x.id);
    if (typeof x.contract !== 'number' || !EXTENSION_CONTRACTS.includes(x.contract)) {
      throw new Error(`${at} (${x.id}): unsupported contract ${String(x.contract)} (supported: ${EXTENSION_CONTRACTS.join(', ')})`);
    }
    if (typeof x.bucketRegionalDomainName !== 'string' || !isBucketDomain(x.bucketRegionalDomainName)) {
      throw new Error(`${at} (${x.id}): bucketRegionalDomainName must be <bucket>.s3.${region}.amazonaws.com`);
    }
    if (typeof x.script !== 'string' || !SCRIPT.test(x.script)) throw new Error(`${at} (${x.id}): invalid script file name`);
    if (typeof x.integrity !== 'string' || !INTEGRITY.test(x.integrity)) throw new Error(`${at} (${x.id}): integrity must be sha384-/sha512-<base64>`);
    const connectSrc = x.connectSrc ?? [];
    if (!Array.isArray(connectSrc) || connectSrc.length > MAX_CONNECT_SRC) throw new Error(`${at} (${x.id}): connectSrc must be a list of at most ${MAX_CONNECT_SRC}`);
    for (const c of connectSrc) {
      const m = typeof c === 'string' ? /^(https|wss):\/\/([^/:?#]+)$/.exec(c) : null;
      // Host names only: no paths, ports, wildcards or IP literals (a CSP source is a whole origin).
      if (!m || !HOST.test(m[2]!) || /^[0-9.]+$/.test(m[2]!)) throw new Error(`${at} (${x.id}): connectSrc entries must be https:// or wss:// host names`);
    }
    return {
      id: x.id,
      contract: x.contract,
      bucketRegionalDomainName: x.bucketRegionalDomainName,
      script: x.script,
      integrity: x.integrity,
      connectSrc: connectSrc as string[],
    };
  });
}

/** Parses the configuration object ({ dev?: [...], prod?: [...] }) from JSON text or an already parsed context value. */
export function parseExtensions(raw: unknown): ExtensionsByEnv {
  const v = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('extensions: expected { "dev": [...], "prod": [...] }');
  for (const k of Object.keys(v)) if (k !== 'dev' && k !== 'prod') throw new Error(`extensions: unknown environment ${k}`);
  return v as ExtensionsByEnv;
}
