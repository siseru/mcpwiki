import { Stack, type StackProps, aws_iam as iam } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { acknowledge } from './nag.js';

export const DEV_BOUNDARY_NAME = 'MCPWikiDevBoundary';
export const DEV_QUALIFIER = 'mwdev';

/** Services the dev environment legitimately uses (anything else is denied by the boundary). */
const DEV_SERVICES = [
  'acm', 'apigateway', 'backup', 'cloudformation', 'cloudfront', 'cloudwatch', 'cognito-idp', 'dynamodb', 'events', 'iam',
  'kms', 'lambda', 'logs', 'route53', 's3', 'secretsmanager', 'sns', 'ssm', 'sts', 'tag', 'wafv2', 'xray',
];

export interface GuardStackProps extends StackProps {
  /** Dev wiki host (Route 53 changes are limited to it and its sub-names). Omit to forbid record changes. */
  devHost?: string;
}

/**
 * Account-level guard rails that let dev and prod share one AWS account (deployed by an administrator,
 * never by CI). Everything acting for dev — the dev CDK bootstrap roles (qualifier "mwdev"), the
 * CloudFormation execution role and every role created by dev stacks — carries this permissions boundary,
 * so a compromised dev pipeline cannot reach prod, CI, other stacks in the account, or escalate via IAM/STS.
 */
export class GuardStack extends Stack {
  constructor(scope: Construct, id: string, props: GuardStackProps) {
    super(scope, id, props);
    const a = this.account;
    const devRoles = [`arn:aws:iam::${a}:role/MCPWiki-dev*`];
    const statements: iam.PolicyStatement[] = [
      new iam.PolicyStatement({ sid: 'AllowDevServices', actions: DEV_SERVICES.map((s) => `${s}:*`), resources: ['*'] }),
      // IAM: only dev roles may be created/changed/passed, and only with this boundary attached.
      new iam.PolicyStatement({
        sid: 'DenyIamOutsideDev',
        effect: iam.Effect.DENY,
        actions: [
          'iam:Create*', 'iam:Delete*', 'iam:Put*', 'iam:Attach*', 'iam:Detach*', 'iam:Update*', 'iam:Add*', 'iam:Remove*',
          'iam:Set*', 'iam:Tag*', 'iam:Untag*', 'iam:Upload*', 'iam:Change*', 'iam:Enable*', 'iam:Deactivate*', 'iam:Reset*',
          'iam:Resync*',
        ],
        notResources: [...devRoles, `arn:aws:iam::${a}:role/aws-service-role/*`],
      }),
      // The dev deploy role hands the (boundary-limited) dev execution role to CloudFormation.
      new iam.PolicyStatement({
        sid: 'DenyPassRoleOutsideDev',
        effect: iam.Effect.DENY,
        actions: ['iam:PassRole'],
        notResources: [...devRoles, `arn:aws:iam::${a}:role/cdk-${DEV_QUALIFIER}-cfn-exec-role-*`],
      }),
      new iam.PolicyStatement({
        sid: 'RequireBoundaryOnDevRoles',
        effect: iam.Effect.DENY,
        actions: ['iam:CreateRole', 'iam:PutRolePermissionsBoundary'],
        resources: ['*'],
        conditions: { StringNotEquals: { 'iam:PermissionsBoundary': `arn:aws:iam::${a}:policy/${DEV_BOUNDARY_NAME}` } },
      }),
      new iam.PolicyStatement({ sid: 'DenyBoundaryRemoval', effect: iam.Effect.DENY, actions: ['iam:DeleteRolePermissionsBoundary'], resources: ['*'] }),
      // STS: the default CDK bootstrap roles trust the account root; never let dev assume them (or anything else).
      new iam.PolicyStatement({
        sid: 'DenyAssumeOutsideDev',
        effect: iam.Effect.DENY,
        actions: ['sts:AssumeRole', 'sts:AssumeRoleWithWebIdentity', 'sts:AssumeRoleWithSAML'],
        notResources: [...devRoles, `arn:aws:iam::${a}:role/cdk-${DEV_QUALIFIER}-*`],
      }),
      // Anything created by another CloudFormation stack (prod, CI, guard, default bootstrap, other projects).
      new iam.PolicyStatement({
        sid: 'DenyOtherStacksResources',
        effect: iam.Effect.DENY,
        actions: ['*'],
        resources: ['*'],
        conditions: {
          Null: { 'aws:ResourceTag/aws:cloudformation:stack-name': 'false' },
          StringNotLike: { 'aws:ResourceTag/aws:cloudformation:stack-name': ['MCPWiki-dev*', `CDKToolkit-mcpwiki-dev`] },
        },
      }),
      new iam.PolicyStatement({
        sid: 'DenyProdTagged',
        effect: iam.Effect.DENY,
        actions: ['*'],
        resources: ['*'],
        conditions: { StringEquals: { 'aws:ResourceTag/mcpwiki:env': 'prod' } },
      }),
      new iam.PolicyStatement({
        sid: 'DenyCreatingProdTagged',
        effect: iam.Effect.DENY,
        actions: ['*'],
        resources: ['*'],
        conditions: { StringEquals: { 'aws:RequestTag/mcpwiki:env': 'prod' } },
      }),
      new iam.PolicyStatement({
        sid: 'DenyOtherStacks',
        effect: iam.Effect.DENY,
        actions: [
          'cloudformation:CreateStack', 'cloudformation:UpdateStack', 'cloudformation:DeleteStack', 'cloudformation:CreateChangeSet',
          'cloudformation:ExecuteChangeSet', 'cloudformation:DeleteChangeSet', 'cloudformation:UpdateTerminationProtection',
          'cloudformation:SetStackPolicy', 'cloudformation:ContinueUpdateRollback', 'cloudformation:RollbackStack',
          'cloudformation:CancelUpdateStack', 'cloudformation:SignalResource', 'cloudformation:TagResource', 'cloudformation:UntagResource',
          'cloudformation:CreateStackRefactor', 'cloudformation:ExecuteStackRefactor', 'cloudformation:*StackSet*',
          'cloudformation:*StackInstances', 'cloudformation:RegisterType', 'cloudformation:ActivateType', 'cloudformation:SetTypeConfiguration',
        ],
        notResources: [`arn:aws:cloudformation:*:${a}:stack/MCPWiki-dev*/*`],
      }),
      // Name-based backstops for services/actions without resource-tag support (e.g. S3 objects).
      new iam.PolicyStatement({
        sid: 'DenyProdData',
        effect: iam.Effect.DENY,
        actions: ['s3:*', 'dynamodb:*', 'lambda:*', 'ssm:*', 'logs:*', 'backup:*'],
        resources: [
          'arn:aws:s3:::mcpwiki-prod-*', 'arn:aws:s3:::mcpwiki-prod-*/*',
          `arn:aws:s3:::cdk-hnb659fds-*`, `arn:aws:s3:::cdk-hnb659fds-*/*`, // prod/default CDK assets (deploy poisoning)
          `arn:aws:dynamodb:*:${a}:table/MCPWiki-prod-*`, `arn:aws:dynamodb:*:${a}:table/MCPWiki-prod-*/*`,
          `arn:aws:lambda:*:${a}:function:MCPWiki-prod-*`,
          `arn:aws:ssm:*:${a}:parameter/mcpwiki/prod/*`,
          `arn:aws:logs:*:${a}:log-group:/aws/lambda/MCPWiki-prod-*`, `arn:aws:logs:*:${a}:log-group:aws-waf-logs-mcpwiki-prod*`,
          `arn:aws:backup:*:${a}:backup-vault:mcpwiki-prod`,
        ],
      }),
      // The default bootstrap version parameter may be read (CloudFormation re-resolves previous parameter
      // values during updates) but never changed.
      new iam.PolicyStatement({
        sid: 'DenyDefaultBootstrapParamWrites',
        effect: iam.Effect.DENY,
        actions: ['ssm:Put*', 'ssm:Delete*', 'ssm:Label*', 'ssm:AddTags*', 'ssm:RemoveTags*', 'ssm:Unlabel*'],
        resources: [`arn:aws:ssm:*:${a}:parameter/cdk-bootstrap/hnb659fds/*`],
      }),
      // Route 53: the hosted zone is shared with prod and unrelated sites.
      new iam.PolicyStatement({
        sid: 'DenyZoneAdmin',
        effect: iam.Effect.DENY,
        actions: [
          'route53:Create*', 'route53:Delete*', 'route53:Update*', 'route53:Associate*', 'route53:Disassociate*',
          'route53:Enable*', 'route53:Disable*', 'route53:Activate*', 'route53:Deactivate*', 'route53:ChangeTagsForResource',
          'route53:ChangeCidrCollection',
        ],
        resources: ['*'],
      }),
      props.devHost
        ? new iam.PolicyStatement({
            sid: 'DenyRecordsOutsideDevHost',
            effect: iam.Effect.DENY,
            actions: ['route53:ChangeResourceRecordSets'],
            resources: ['*'],
            conditions: {
              'ForAnyValue:StringNotLike': { 'route53:ChangeResourceRecordSetsNormalizedRecordNames': [props.devHost, `*.${props.devHost}`] },
            },
          })
        : new iam.PolicyStatement({ sid: 'DenyRecords', effect: iam.Effect.DENY, actions: ['route53:ChangeResourceRecordSets'], resources: ['*'] }),
    ];
    const boundary = new iam.ManagedPolicy(this, 'DevBoundary', {
      managedPolicyName: DEV_BOUNDARY_NAME,
      description: 'Permissions boundary for everything acting on behalf of MCPWiki dev (shared account with prod).',
      statements,
    });
    acknowledge(boundary, [
      ...DEV_SERVICES.map((s) => ({ id: `AwsSolutions-IAM5[Action::${s}:*]`, reason: 'Permissions boundary: the allow set is the service allowlist; denies carve out prod/IAM/STS.' })),
      { id: 'AwsSolutions-IAM5[Resource::*]', reason: 'Permissions boundary (upper bound), not a grant.' },
    ]);
  }
}
