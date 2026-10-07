import { CfnOutput, Duration, Stack, type StackProps, aws_iam as iam } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { DEV_BOUNDARY_NAME, DEV_QUALIFIER } from './guard-stack.js';
import { acknowledge } from './nag.js';

export interface CiStackProps extends StackProps {
  /** "owner/repo" */
  githubRepo: string;
  /** Reuse an existing token.actions.githubusercontent.com provider instead of creating one. */
  existingOidcProviderArn?: string;
  /**
   * Expect the repository's OIDC subject to be customized to include the git ref
   * (include_claim_keys: ["repo", "context", "ref"]); see README. Default true (fail closed).
   */
  subjectIncludesRef?: boolean;
}

/**
 * GitHub Actions OIDC deploy roles, one per GitHub Environment. No long-lived access keys.
 * - dev: only the dev CDK bootstrap roles (qualifier "mwdev", permissions-boundary limited), only from main.
 * - prod: the default CDK bootstrap roles, only from v* tags (plus the "prod" environment approval in GitHub).
 */
export class CiStack extends Stack {
  constructor(scope: Construct, id: string, props: CiStackProps) {
    super(scope, id, props);
    const provider = props.existingOidcProviderArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GitHub', props.existingOidcProviderArn)
      : new iam.OpenIdConnectProvider(this, 'GitHub', { url: 'https://token.actions.githubusercontent.com', clientIds: ['sts.amazonaws.com'] });
    const withRef = props.subjectIncludesRef ?? true;
    const envs = {
      dev: { qualifier: DEV_QUALIFIER, ref: 'refs/heads/main' },
      prod: { qualifier: 'hnb659fds', ref: 'refs/tags/v*' },
    } as const;

    for (const [env, c] of Object.entries(envs) as [keyof typeof envs, (typeof envs)[keyof typeof envs]][]) {
      const sub = `repo:${props.githubRepo}:environment:${env}${withRef ? `:ref:${c.ref}` : ''}`;
      const role = new iam.Role(this, `Deploy-${env}`, {
        roleName: `mcpwiki-github-deploy-${env}`,
        description: `GitHub Actions deploy role for MCPWiki ${env} (environment + ref scoped OIDC)`,
        maxSessionDuration: Duration.hours(1),
        assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
          StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
          StringLike: { 'token.actions.githubusercontent.com:sub': sub },
        }),
        permissionsBoundary: env === 'dev' ? iam.ManagedPolicy.fromManagedPolicyName(this, 'DevBoundary', DEV_BOUNDARY_NAME) : undefined,
      });
      const bootstrapRoles = [this.region, 'us-east-1'].map((r) => `arn:aws:iam::${this.account}:role/cdk-${c.qualifier}-*-${this.account}-${r}`);
      role.addToPolicy(new iam.PolicyStatement({ actions: ['sts:AssumeRole'], resources: bootstrapRoles }));
      acknowledge(
        role,
        bootstrapRoles.map((arn) => ({ id: `AwsSolutions-IAM5[Resource::${arn}]`, reason: `Only the ${env} CDK bootstrap roles (qualifier ${c.qualifier}).` })),
      );
      new CfnOutput(this, `DeployRoleArn${env}`, { value: role.roleArn });
    }
    acknowledge(this, [
      { id: 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]', reason: 'CDK-managed OIDC provider custom resource.' },
      { id: 'AwsSolutions-L1', reason: 'CDK-managed custom resource runtime.' },
    ]);
  }
}
