// Bootstraps the dev-only CDK environment (qualifier "mwdev") with every bootstrap role bound by the
// MCPWikiDevBoundary permissions boundary (deploy the MCPWiki-guard stack first, as an administrator).
//
// The stock bootstrap template only applies a boundary to the CloudFormation execution role; the deploy
// role has cloudformation:* on all stacks and could otherwise update prod stacks with their stored
// (administrator) execution role. Usage (administrator credentials):
//   node scripts/bootstrap-dev.mjs            # prints the commands it runs
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const QUALIFIER = 'mwdev';
const BOUNDARY = 'MCPWikiDevBoundary';
const ROLES = ['FilePublishingRole', 'ImagePublishingRole', 'LookupRole', 'DeploymentActionRole'];

const npx = (args, opts = {}) => execFileSync('npx', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts });
let template = npx(['cdk', 'bootstrap', '--show-template']);
for (const role of ROLES) {
  const header = `\n  ${role}:\n    Type: AWS::IAM::Role\n    Properties:\n`;
  if (!template.includes(header)) throw new Error(`bootstrap template changed: ${role} not found; review this script`);
  template = template.replace(
    header,
    header +
      '      PermissionsBoundary:\n' +
      '        Fn::If:\n' +
      '          - PermissionsBoundarySet\n' +
      "          - Fn::Sub: 'arn:${AWS::Partition}:iam::${AWS::AccountId}:policy/${InputPermissionsBoundary}'\n" +
      '          - Ref: AWS::NoValue\n',
  );
}
const count = (template.match(/policy\/\$\{InputPermissionsBoundary\}/g) ?? []).length;
if (count < ROLES.length + 1) throw new Error(`expected ${ROLES.length + 1} boundary references, found ${count}`);
mkdirSync('cdk.out', { recursive: true });
const file = 'cdk.out/bootstrap-dev.yaml';
writeFileSync(file, template);

const account = execFileSync('aws', ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'], { encoding: 'utf8' }).trim();
const region = process.env.AWS_REGION || execFileSync('aws', ['configure', 'get', 'region'], { encoding: 'utf8' }).trim() || 'us-west-2';
const args = [
  'cdk', 'bootstrap', `aws://${account}/${region}`, `aws://${account}/us-east-1`,
  '--qualifier', QUALIFIER,
  '--toolkit-stack-name', 'CDKToolkit-mcpwiki-dev',
  '--template', file,
  '--custom-permissions-boundary', BOUNDARY,
  '--cloudformation-execution-policies', 'arn:aws:iam::aws:policy/AdministratorAccess', // bounded by the boundary
  '--termination-protection',
];
console.log(`$ npx ${args.join(' ')}`);
execFileSync('npx', args, { stdio: 'inherit' });
