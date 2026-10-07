// Post-deploy smoke test (unauthenticated checks only).
// Usage: node scripts/smoke.mjs https://<public-url> [https://<legacy dxxxx.cloudfront.net url to check the redirect>]
const base = (process.argv[2] ?? '').replace(/\/+$/, '');
if (!/^https:\/\//.test(base)) {
  console.error('usage: node scripts/smoke.mjs https://<distribution>');
  process.exit(2);
}
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`FAIL ${name}: ${e.message}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const get = (p, init) => fetch(base + p, { redirect: 'manual', ...init, signal: AbortSignal.timeout(15000) });

await check('index.html with security headers', async () => {
  const r = await get('/');
  assert(r.status === 200, `status ${r.status}`);
  const csp = r.headers.get('content-security-policy') ?? '';
  assert(csp.includes("script-src 'self'") && csp.includes("frame-ancestors 'none'"), `CSP: ${csp}`);
  assert((r.headers.get('strict-transport-security') ?? '').includes('max-age'), 'HSTS missing');
  assert(r.headers.get('x-content-type-options') === 'nosniff', 'nosniff missing');
});
await check('SPA route falls back to index.html', async () => {
  const r = await get('/wiki/some-article');
  assert(r.status === 200 && (await r.text()).includes('id="main"'), `status ${r.status}`);
});
await check('config.json', async () => {
  const j = await (await get('/config.json')).json();
  assert(j.cognitoDomain?.startsWith('https://') && j.webClientId && j.cliClientId, JSON.stringify(j));
});
await check('api health', async () => {
  const r = await get('/api/health');
  assert(r.status === 200, `status ${r.status}`);
});
await check('api requires auth', async () => {
  const r = await get('/api/articles');
  assert(r.status === 401, `status ${r.status}`);
});
await check('mcp requires auth and advertises resource metadata', async () => {
  const r = await get('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
  assert(r.status === 401, `status ${r.status}`);
  assert((r.headers.get('www-authenticate') ?? '').includes('resource_metadata='), 'WWW-Authenticate missing');
});
await check('protected resource metadata', async () => {
  const j = await (await get('/.well-known/oauth-protected-resource')).json();
  assert(j.resource === `${base}/mcp` && j.authorization_servers?.length === 1, JSON.stringify(j));
});
await check('forged token rejected', async () => {
  const fake = 'eyJhbGciOiJSUzI1NiIsImtpZCI6IngifQ.eyJzdWIiOiJ4In0.c2ln';
  const r = await get('/api/me', { headers: { authorization: `Bearer ${fake}` } });
  assert(r.status === 401, `status ${r.status}`);
});

const legacy = (process.argv[3] ?? '').replace(/\/+$/, '');
if (legacy) {
  await check('legacy host redirects to the canonical host', async () => {
    const r = await fetch(`${legacy}/wiki/x?a=1`, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    assert(r.status === 308 && r.headers.get('location') === `${base}/wiki/x?a=1`, `status ${r.status} location ${r.headers.get('location')}`);
  });
}

if (failures.length) {
  console.error(`${failures.length} smoke check(s) failed`);
  process.exit(1);
}
console.log('smoke: all checks passed');
