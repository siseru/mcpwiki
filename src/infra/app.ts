// CDK app. Stacks (per env): MCPWiki-<env>-edge (us-east-1: certificate / WAF), MCPWiki-<env>; plus MCPWiki-ci.
//   cdk deploy MCPWiki-dev-edge MCPWiki-dev
//   cdk deploy MCPWiki-prod-edge MCPWiki-prod
//   cdk deploy MCPWiki-ci -c githubRepo=<owner>/<repo>
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { App, Tags, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { CiStack } from './ci-stack.js';
import { EdgeStack, type DomainConfig } from './edge-stack.js';
import { WikiStack } from './wiki-stack.js';

// build/src/infra/app.js -> repository root
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
if (!existsSync(`${repoRoot}dist/backend/index.mjs`)) {
  throw new Error('dist/ is missing: run "npm run build" before cdk synth/deploy');
}

const app = new App();
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = (app.node.tryGetContext('region') as string | undefined) ?? process.env.CDK_DEFAULT_REGION ?? 'us-west-2';
const alarmEmail = app.node.tryGetContext('alarmEmail') as string | undefined;

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
  if (!host.endsWith(`.${domains.zoneName}`)) throw new Error(`${host} is not inside the hosted zone ${domains.zoneName}`);
  return { zoneName: domains.zoneName, hostedZoneId: domains.hostedZoneId, host };
};

for (const envName of ['dev', 'prod'] as const) {
  const domain = domainFor(envName);
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
        })
      : undefined;
  new WikiStack(app, `MCPWiki-${envName}`, {
    env: { account, region },
    envName,
    repoRoot,
    alarmEmail,
    webAclArn: edge?.webAclArn,
    domain: domain && edge?.certificate ? { ...domain, certificate: edge.certificate } : undefined,
    crossRegionReferences: true,
    terminationProtection: envName === 'prod',
  });
}

const githubRepo = app.node.tryGetContext('githubRepo') as string | undefined;
if (githubRepo) {
  new CiStack(app, 'MCPWiki-ci', {
    env: { account, region },
    githubRepo,
    existingOidcProviderArn: app.node.tryGetContext('githubOidcProviderArn') as string | undefined,
  });
}

Tags.of(app).add('app', 'mcpwiki');
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
