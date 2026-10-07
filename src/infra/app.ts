// CDK app. Stacks (per env): MCPWiki-<env>-edge (us-east-1: certificate / WAF), MCPWiki-<env>; plus MCPWiki-ci.
//   cdk deploy MCPWiki-dev-edge MCPWiki-dev
//   cdk deploy MCPWiki-prod-edge MCPWiki-prod
//   cdk deploy MCPWiki-ci -c githubRepo=<owner>/<repo>
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App, Annotations, DefaultStackSynthesizer, PermissionsBoundary, Tags, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import type { IConstruct } from 'constructs';
import { CiStack } from './ci-stack.js';
import { EdgeStack, type DomainConfig } from './edge-stack.js';
import { DEV_BOUNDARY_NAME, DEV_QUALIFIER, GuardStack } from './guard-stack.js';
import { WikiStack } from './wiki-stack.js';

// build/src/infra/app.js -> repository root
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
if (!existsSync(`${repoRoot}dist/backend/index.mjs`)) {
  throw new Error('dist/ is missing: run "npm run build" before cdk synth/deploy');
}

const app = new App();
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = (app.node.tryGetContext('region') as string | undefined) ?? process.env.CDK_DEFAULT_REGION ?? 'us-west-2';
const alarmEmail = (app.node.tryGetContext('alarmEmail') as string | undefined) ?? process.env.MCPWIKI_ALARM_EMAIL;

/** Optional custom domains: { zoneName, hostedZoneId, hosts: { dev?: string, prod?: string } } (see config/domains.example.json). */
interface DomainsContext {
  zoneName: string;
  hostedZoneId: string;
  hosts: Partial<Record<'dev' | 'prod', string>>;
}
// Kept out of git: config/domains.local.json, or MCPWIKI_DOMAINS (JSON, e.g. a GitHub Environment variable), or -c domains='<json>'.
function loadDomains(): DomainsContext | undefined {
  const ctx = app.node.tryGetContext('domains') as DomainsContext | string | undefined;
  if (ctx) return typeof ctx === 'string' ? (JSON.parse(ctx) as DomainsContext) : ctx;
  if (process.env.MCPWIKI_DOMAINS) return JSON.parse(process.env.MCPWIKI_DOMAINS) as DomainsContext;
  const file = `${repoRoot}config/domains.local.json`;
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as DomainsContext) : undefined;
}
const domains = loadDomains();
const domainFor = (env: 'dev' | 'prod'): DomainConfig | undefined => {
  const host = domains?.hosts?.[env];
  if (!domains || !host) return undefined;
  // Validated strictly: the host is interpolated into CloudFront Function code and IAM conditions.
  if (!/^(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})+$/.test(host)) throw new Error(`invalid host name: ${host}`);
  if (!/^Z[A-Z0-9]{5,32}$/.test(domains.hostedZoneId)) throw new Error(`invalid hosted zone id: ${domains.hostedZoneId}`);
  if (!host.endsWith(`.${domains.zoneName}`)) throw new Error(`${host} is not inside the hosted zone ${domains.zoneName}`);
  return { zoneName: domains.zoneName, hostedZoneId: domains.hostedZoneId, host };
};

// Shared-account guard rails (deploy manually as an administrator; see README "dev / prod isolation").
// Cost allocation tags (keys follow the account's active cost allocation tags; extend or override with
// -c costTags='{"CostCenter":"..."}'). The guard and CI stacks serve both environments.
const costTagsCtx = app.node.tryGetContext('costTags') as Record<string, string> | string | undefined;
const extraCostTags: Record<string, string> = typeof costTagsCtx === 'string' ? JSON.parse(costTagsCtx) : (costTagsCtx ?? {});
for (const [k, v] of Object.entries(extraCostTags)) {
  if (!/^(?!aws:)[\p{L}\p{N} _.:/=+@-]{1,128}$/u.test(k) || typeof v !== 'string' || !/^[\p{L}\p{N} _.:/=+@-]{0,256}$/u.test(v)) {
    throw new Error(`invalid cost tag: ${k}`);
  }
}
const costTags = (scope: IConstruct, environment: string, component: string) => {
  for (const [k, v] of Object.entries({ Project: 'mcpwiki', Environment: environment, Component: component, ManagedBy: 'cdk', ...extraCostTags })) {
    Tags.of(scope).add(k, v);
  }
};

const guard = new GuardStack(app, 'MCPWiki-guard', { env: { account, region }, devHost: domainFor('dev')?.host });

for (const envName of ['dev', 'prod'] as const) {
  const domain = domainFor(envName);
  // dev uses its own CDK bootstrap (qualifier mwdev) whose roles carry the dev permissions boundary.
  const synthesizer = envName === 'dev' ? new DefaultStackSynthesizer({ qualifier: DEV_QUALIFIER }) : undefined;
  // Applied to every role in the stack, including CDK-internal custom resource provider roles.
  const permissionsBoundary = envName === 'dev' ? PermissionsBoundary.fromName(DEV_BOUNDARY_NAME) : undefined;
  const wafEnabled = envName === 'prod';
  const edge =
    domain || wafEnabled
      ? new EdgeStack(app, `MCPWiki-${envName}-edge`, {
          env: { account, region: 'us-east-1' },
          envName,
          domain,
          waf: wafEnabled,
          alarmEmail,
          crossRegionReferences: true,
          synthesizer,
          permissionsBoundary,
        })
      : undefined;
  const wiki = new WikiStack(app, `MCPWiki-${envName}`, {
    env: { account, region },
    envName,
    repoRoot,
    alarmEmail,
    webAclArn: edge?.webAclArn,
    domain: domain && edge?.certificate ? { ...domain, certificate: edge.certificate } : undefined,
    crossRegionReferences: true,
    terminationProtection: envName === 'prod',
    synthesizer,
    permissionsBoundary,
  });
  for (const st of [wiki, edge]) {
    if (!st) continue;
    Tags.of(st).add('mcpwiki:env', envName);
  }
  costTags(wiki, envName, 'app');
  if (edge) costTags(edge, envName, 'edge');
  if (envName === 'prod' && !alarmEmail) {
    Annotations.of(wiki).addWarningV2('mcpwiki:noAlarmEmail', 'prod has no alarm recipient: set MCPWIKI_ALARM_EMAIL (or -c alarmEmail=...)');
  }
}

const githubRepo = app.node.tryGetContext('githubRepo') as string | undefined;
if (githubRepo) {
  const ci = new CiStack(app, 'MCPWiki-ci', {
    env: { account, region },
    githubRepo,
    existingOidcProviderArn: app.node.tryGetContext('githubOidcProviderArn') as string | undefined,
    subjectPrefix: app.node.tryGetContext('githubOidcSubjectPrefix') as string | undefined,
  });
  costTags(ci, 'shared', 'cicd');
}

Tags.of(app).add('app', 'mcpwiki');
costTags(guard, 'shared', 'guard');
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));

// CDK-internal providers created during the final synthesis phase (e.g. cross-region reference
// readers/writers) are not reached by PermissionsBoundary. Patch the synthesized dev templates
// deterministically; the dev boundary denies creating roles without it, so a miss fails closed.
const assembly = app.synth();
for (const st of assembly.stacks) {
  if (!/^MCPWiki-dev(-|$)/.test(st.stackName)) continue;
  const file = join(assembly.directory, st.templateFile);
  const template = JSON.parse(readFileSync(file, 'utf8')) as { Resources?: Record<string, { Type: string; Properties?: Record<string, unknown> }> };
  let patched = 0;
  for (const r of Object.values(template.Resources ?? {})) {
    if (r.Type !== 'AWS::IAM::Role' || r.Properties?.PermissionsBoundary) continue;
    r.Properties = { ...r.Properties, PermissionsBoundary: { 'Fn::Sub': `arn:\${AWS::Partition}:iam::\${AWS::AccountId}:policy/${DEV_BOUNDARY_NAME}` } };
    patched++;
  }
  if (patched) writeFileSync(file, JSON.stringify(template, null, 1));
}

