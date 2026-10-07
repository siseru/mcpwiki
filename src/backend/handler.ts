// AWS Lambda entry point (API Gateway HTTP API, payload format 2.0).
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { TokenVerifier, type Jwk } from './auth.js';
import { createApp, type Req, type Res } from './app.js';
import { DynamoStore } from './dynamo-store.js';
import { WikiService } from './service.js';
import { CognitoUserDirectory } from './users.js';

interface HttpEvent {
  rawPath: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string }; requestId: string };
}

interface HttpResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: boolean;
}

interface RuntimeConfig {
  webClientId: string;
  cliClientId: string;
  publicUrl: string;
}

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

const region = env('AWS_REGION');
const poolId = env('USER_POOL_ID');
const issuer = `https://cognito-idp.${region}.amazonaws.com/${poolId}`;
const ssm = new SSMClient({ region });

let configCache: { value: RuntimeConfig; at: number } | undefined;
async function runtimeConfig(): Promise<RuntimeConfig> {
  if (configCache && Date.now() - configCache.at < 5 * 60_000) return configCache.value;
  const res = await ssm.send(new GetParameterCommand({ Name: env('CONFIG_PARAM') }));
  const value = JSON.parse(res.Parameter?.Value ?? '{}') as RuntimeConfig;
  configCache = { value, at: Date.now() };
  return value;
}

let app: ((req: Req) => Promise<Res>) | undefined;
async function getApp() {
  if (app) return app;
  const cfg = await runtimeConfig();
  const store = new DynamoStore(env('TABLE_NAME'), env('BUCKET_NAME'), region);
  const verifier = new TokenVerifier({
    issuer,
    store,
    clients: async () => {
      const c = await runtimeConfig();
      return { [c.webClientId]: 'web', [c.cliClientId]: 'cli' };
    },
    fetchJwks: async () => {
      const r = await fetch(`${issuer}/.well-known/jwks.json`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(`jwks fetch failed: ${r.status}`);
      return (await r.json()) as { keys: Jwk[] };
    },
  });
  app = createApp({
    service: new WikiService(store, new CognitoUserDirectory(poolId, region)),
    verifier,
    store,
    publicUrl: cfg.publicUrl,
    issuer,
    originSecret: process.env.ORIGIN_SECRET || undefined,
    rateLimit: { perMinute: Number(process.env.RATE_PER_MINUTE ?? 300), writesPerMinute: Number(process.env.WRITES_PER_MINUTE ?? 60) },
  });
  return app;
}

export async function handler(event: HttpEvent): Promise<HttpResult> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(event.headers ?? {})) if (v !== undefined) headers[k.toLowerCase()] = v;
  const query: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(event.rawQueryString ?? '')) query[k] = v;
  const body = event.body === undefined ? null : Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
  const res = await (await getApp())({
    method: event.requestContext.http.method.toUpperCase(),
    path: event.rawPath,
    query,
    headers,
    body,
    requestId: event.requestContext.requestId,
  });
  const binary = Buffer.isBuffer(res.body);
  return {
    statusCode: res.status,
    headers: res.headers,
    body: binary ? (res.body as Buffer).toString('base64') : (res.body as string),
    isBase64Encoded: binary,
  };
}
