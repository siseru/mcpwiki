import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';
import { parseExtensions, validateExtensions, type ExtensionConfig } from '../src/infra/extensions.js';
import { WikiStack } from '../src/infra/wiki-stack.js';
import { acceptRegistration, isSupportedContract } from '../src/web/extensions.js';

const REGION = 'us-west-2';
const valid = (): ExtensionConfig => ({
  id: 'demo-ext',
  contract: 1,
  bucketRegionalDomainName: 'demo-ext-bundles.s3.us-west-2.amazonaws.com',
  script: 'demo-ext-0123abcd.js',
  integrity: 'sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC',
  connectSrc: ['wss://abcdefghij.execute-api.us-west-2.amazonaws.com'],
});

test('a valid extension passes validation unchanged; absent lists mean no extensions', () => {
  assert.deepEqual(validateExtensions([valid()], REGION), [valid()]);
  assert.deepEqual(validateExtensions(undefined, REGION), []);
  assert.deepEqual(validateExtensions([], REGION), []);
  assert.deepEqual(validateExtensions([{ ...valid(), connectSrc: undefined }], REGION)[0]!.connectSrc, []);
});

test('extension values that would reach CloudFront, the CSP or config.json are validated strictly', () => {
  const bad: [string, Record<string, unknown>][] = [
    ['id', { id: 'Demo' }], ['id', { id: '../x' }], ['id', { id: 'a' }], ['id', { id: 'x'.repeat(40) }],
    ['contract', { contract: 2 }], ['contract', { contract: '1' }],
    ['bucket', { bucketRegionalDomainName: 'demo.s3.us-east-1.amazonaws.com' }], // other region
    ['bucket', { bucketRegionalDomainName: 'demo.s3.amazonaws.com' }],
    ['bucket', { bucketRegionalDomainName: 'evil.example.com' }],
    ['script', { script: '../app.js' }], ['script', { script: 'a.mjs' }], ['script', { script: 'a b.js' }],
    ['integrity', { integrity: 'sha256-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQ=' }], ['integrity', { integrity: 'sha384-<x>' }],
    ['connectSrc', { connectSrc: ['http://api.example.com'] }],
    ['connectSrc', { connectSrc: ['https://api.example.com/path'] }],
    ['connectSrc', { connectSrc: ['https://*.example.com'] }],
    ['connectSrc', { connectSrc: ['*'] }],
    ['connectSrc', { connectSrc: ['https://10.0.0.1'] }],
    ['connectSrc', { connectSrc: ['https://api.example.com:8443'] }],
    ['connectSrc', { connectSrc: ["https://a.example.com 'unsafe-inline'"] }],
    ['connectSrc', { connectSrc: ['https://a.example.com; script-src *'] }],
    ['connectSrc', { connectSrc: ['wss://a.example.com', 'wss://b.example.com', 'wss://c.example.com', 'wss://d.example.com', 'wss://e.example.com'] }],
    ['unknown key', { origin: 'x' }],
  ];
  for (const [what, patch] of bad) {
    assert.throws(() => validateExtensions([{ ...valid(), ...patch }], REGION), Error, `${what}: ${JSON.stringify(patch)}`);
  }
  assert.throws(() => validateExtensions([valid(), valid()], REGION), /duplicate id/);
  assert.throws(() => validateExtensions({}, REGION), /array/);
  assert.throws(() => parseExtensions('{"staging":[]}'), /unknown environment/);
  assert.deepEqual(parseExtensions('{"dev":[]}'), { dev: [] });
  assert.deepEqual(parseExtensions(undefined), {});
});

test('the host accepts only the configured id with the configured, supported contract', () => {
  const state = { info: { id: 'demo-ext', contract: 1, src: '/ext/demo-ext/x.js', integrity: 'sha384-x' }, status: 'loading' as const };
  assert.equal(isSupportedContract(1), true);
  assert.equal(isSupportedContract(2), false);
  assert.equal(isSupportedContract('1'), false);
  assert.equal(acceptRegistration(state, { id: 'demo-ext', contract: 1 }), true);
  assert.equal(acceptRegistration(state, { id: 'demo-ext', contract: 2 }), false); // built for another contract
  assert.equal(acceptRegistration(state, { id: 'other', contract: 1 }), false);
  assert.equal(acceptRegistration({ ...state, status: 'ready' as never }, { id: 'demo-ext', contract: 1 }), false); // registers once
  assert.equal(acceptRegistration(undefined, { id: 'demo-ext', contract: 1 }), false);
  assert.equal(acceptRegistration(state, null), false);
});

// ------------------------------------------------------------------ synthesized infrastructure

const repoRoot = fileURLToPath(new URL('../../', import.meta.url)); // build/test -> repository root
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));

function synth(extensions: ExtensionConfig[] | undefined) {
  const app = new App();
  const stack = new WikiStack(app, 'MCPWiki-dev', { env: { account: '123456789012', region: REGION }, envName: 'dev', repoRoot, extensions });
  const assembly = app.synth();
  const template = readFileSync(join(assembly.directory, assembly.getStackByName(stack.stackName).templateFile), 'utf8');
  // Source.jsonData stages config.json as a file asset of its own.
  // Values only known at deploy time are staged as unquoted <<marker:...>> placeholders.
  const configs = files(assembly.directory)
    .filter((f) => f.endsWith('config.json'))
    .map((f) => JSON.parse(readFileSync(f, 'utf8').replace(/<<marker:[^>]+>>/g, (m) => JSON.stringify(m))));
  assert.equal(configs.length, 1);
  return { template, resources: JSON.parse(template).Resources as Record<string, { Type: string; Properties: any }>, config: configs[0] };
}
const headerPolicies = (r: ReturnType<typeof synth>['resources']) =>
  Object.entries(r).filter(([, x]) => x.Type === 'AWS::CloudFront::ResponseHeadersPolicy');
const cspOf = (x: { Properties: any }) => JSON.stringify(x.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy);
const csp = (r: ReturnType<typeof synth>['resources']) => cspOf(headerPolicies(r).find(([k]) => k.startsWith('SecurityHeaders'))![1]);
const behaviors = (r: ReturnType<typeof synth>['resources']) =>
  Object.values(r).find((x) => x.Type === 'AWS::CloudFront::Distribution')!.Properties.DistributionConfig.CacheBehaviors as { PathPattern: string; AllowedMethods: string[] }[];

test('without extensions the wiki synthesizes byte-identical infrastructure and config.json', () => {
  const none = synth(undefined);
  const empty = synth([]);
  assert.equal(empty.template, none.template);
  assert.deepEqual(empty.config, none.config);
  assert.equal('extensions' in none.config, false);
  assert.ok(!none.template.includes('/ext/'));
});

test('an extension adds only its CloudFront behavior (with OAC), its connect-src and its config.json entry', () => {
  const off = synth([]);
  const on = synth([valid()]);
  const added = Object.keys(on.resources).filter((k) => !(k in off.resources));
  const removed = Object.keys(off.resources).filter((k) => !(k in on.resources));
  assert.deepEqual(removed, []);
  assert.deepEqual(added.map((k) => on.resources[k]!.Type).sort(), ['AWS::CloudFront::OriginAccessControl', 'AWS::CloudFront::ResponseHeadersPolicy']);
  const changed = Object.keys(off.resources).filter((k) => JSON.stringify(off.resources[k]) !== JSON.stringify(on.resources[k]));
  // The distribution (behavior + origin), the security headers (CSP) and the root deployment (new config.json asset).
  assert.deepEqual(changed.map((k) => on.resources[k]!.Type).sort(), ['AWS::CloudFront::Distribution', 'AWS::CloudFront::ResponseHeadersPolicy', 'Custom::CDKBucketDeployment']);
  const ext = behaviors(on.resources).find((b) => b.PathPattern === '/ext/demo-ext/demo-ext-0123abcd.js')!;
  assert.deepEqual(ext.AllowedMethods, ['GET', 'HEAD']);
  assert.ok(csp(on.resources).includes(' wss://abcdefghij.execute-api.us-west-2.amazonaws.com;'));
  assert.ok(!csp(off.resources).includes('execute-api.us-west-2.amazonaws.com;'));
  assert.deepEqual(on.config.extensions, [{ id: 'demo-ext', contract: 1, src: '/ext/demo-ext/demo-ext-0123abcd.js', integrity: valid().integrity }]);
  // Only what the browser needs: no bucket name, no endpoints.
  assert.ok(!JSON.stringify(on.config).includes('s3.us-west-2'));
  assert.ok(!JSON.stringify(on.config).includes('execute-api'));
  const { extensions: _x, ...rest } = on.config;
  assert.deepEqual(rest, off.config);
});

test('only the approved bundle is served from the extension bucket, never as a page of the wiki origin', () => {
  const on = synth([valid()]);
  const ext = behaviors(on.resources).filter((b) => b.PathPattern.startsWith('/ext/'));
  // A wildcard would serve any object of the bucket (e.g. an HTML page loading an unhashed script) without the SRI check.
  assert.deepEqual(ext.map((b) => b.PathPattern), ['/ext/demo-ext/demo-ext-0123abcd.js']);
  const [extKey, extPolicy] = headerPolicies(on.resources).find(([k]) => k.startsWith('ExtensionHeaders'))!;
  const behavior = behaviors(on.resources).find((b) => b.PathPattern.startsWith('/ext/')) as unknown as { ResponseHeadersPolicyId: unknown };
  assert.deepEqual(behavior.ResponseHeadersPolicyId, { Ref: extKey });
  assert.ok(cspOf(extPolicy).includes("default-src 'none'; sandbox"));
});

test('response headers policies are named after their content, so changes replace them (dev may not update policies)', () => {
  const name = (r: ReturnType<typeof synth>['resources'], prefix: string) =>
    headerPolicies(r).find(([k]) => k.startsWith(prefix))![1].Properties.ResponseHeadersPolicyConfig.Name as string;
  const off = synth([]);
  const on = synth([valid()]);
  const other = synth([{ ...valid(), connectSrc: ['wss://klmnopqrst.execute-api.us-west-2.amazonaws.com'] }]);
  assert.match(name(off.resources, 'SecurityHeaders'), /^[A-Za-z0-9_-]{1,100}-[0-9a-f]{16}$/);
  assert.notEqual(name(on.resources, 'SecurityHeaders'), name(off.resources, 'SecurityHeaders'));
  assert.notEqual(name(other.resources, 'SecurityHeaders'), name(on.resources, 'SecurityHeaders'));
  assert.equal(name(other.resources, 'ExtensionHeaders'), name(on.resources, 'ExtensionHeaders'));
  assert.equal(name(synth([]).resources, 'SecurityHeaders'), name(off.resources, 'SecurityHeaders'));
});
