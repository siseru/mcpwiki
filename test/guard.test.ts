import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App, type Stack } from 'aws-cdk-lib';
import { GuardStack } from '../src/infra/guard-stack.js';
import { WikiStack } from '../src/infra/wiki-stack.js';

const env = { account: '123456789012', region: 'us-west-2' };
const repoRoot = fileURLToPath(new URL('../../', import.meta.url)); // build/test -> repository root

function template(app: App, stack: Stack) {
  const assembly = app.synth();
  return JSON.parse(readFileSync(join(assembly.directory, assembly.getStackByName(stack.stackName).templateFile), 'utf8')) as {
    Resources: Record<string, { Type: string; Properties: any }>;
  };
}
const boundary = () => {
  const app = new App();
  const t = template(app, new GuardStack(app, 'MCPWiki-guard', { env }));
  const policy = Object.values(t.Resources).find((r) => r.Type === 'AWS::IAM::ManagedPolicy')!;
  return policy.Properties.PolicyDocument.Statement as { Sid: string; Effect: string; Action: string[]; Resource?: unknown; NotResource?: unknown }[];
};
/** IAM ARN wildcard match (`*` only). */
const matches = (pattern: string, arn: string) =>
  new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(arn);
const functionNames = (envName: 'dev' | 'prod') => {
  const app = new App();
  const t = template(app, new WikiStack(app, `MCPWiki-${envName}`, { env, envName, repoRoot }));
  return Object.values(t.Resources).filter((r) => r.Type === 'AWS::CloudFront::Function').map((r) => r.Properties.Name as string);
};

// CloudFront functions and policies cannot be tagged, so the tag-based denies never protect prod's.
test("the dev boundary lets dev change only its own CloudFront functions, never prod's", () => {
  const deny = boundary().find((s) => s.Sid === 'DenyCloudFrontFunctionsOutsideDev')!;
  assert.equal(deny.Effect, 'Deny');
  for (const a of ['cloudfront:UpdateFunction', 'cloudfront:PublishFunction', 'cloudfront:DeleteFunction']) assert.ok(deny.Action.includes(a), a);
  const [pattern] = [deny.NotResource].flat() as string[];
  const arn = (name: string) => `arn:aws:cloudfront::${env.account}:function/${name}`;
  const dev = functionNames('dev');
  const prod = functionNames('prod');
  assert.equal(dev.length, 2);
  assert.equal(prod.length, 2);
  for (const n of dev) assert.ok(matches(pattern, arn(n)), `dev function ${n} must stay deployable`);
  for (const n of prod) assert.ok(!matches(pattern, arn(n)), `prod function ${n} must be denied`);
});

test('the dev boundary denies in-place updates of CloudFront policies (addressed by id, untaggable)', () => {
  const deny = boundary().find((s) => s.Sid === 'DenyUntaggableCloudFrontUpdates')!;
  assert.equal(deny.Effect, 'Deny');
  assert.equal(deny.Resource, '*');
  for (const a of ['cloudfront:UpdateResponseHeadersPolicy', 'cloudfront:UpdateOriginAccessControl', 'cloudfront:UpdateCachePolicy']) {
    assert.ok(deny.Action.includes(a), a);
  }
});
