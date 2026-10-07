import { CfnOutput, Duration, Stack, type StackProps, aws_iam as iam } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { acknowledge } from './nag.js';

export interface CiStackProps extends StackProps {
  /** "owner/repo" */
  githubRepo: string;
  /** Reuse an existing token.actions.githubusercontent.com provider instead of creating one. */
  existingOidcProviderArn?: string;
}

/**
 * GitHub Actions OIDC deploy roles, one per GitHub Environment (dev / prod).
 * No long-lived access keys. Each role may only assume the CDK bootstrap roles.
 */
export class CiStack extends Stack {
  constructor(scope: Construct, id: string, props: CiStackProps) {
    super(scope, id, props);
    const provider = props.existingOidcProviderArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GitHub', props.existingOidcProviderArn)
      : new iam.OpenIdConnectProvider(this, 'GitHub', { url: 'https://token.actions.githubusercontent.com', clientIds: ['sts.amazonaws.com'] });

    for (const env of ['dev', 'prod'] as const) {
      const role = new iam.Role(this, `Deploy-${env}`, {
        roleName: `mcpwiki-github-deploy-${env}`,
        description: `GitHub Actions deploy role for MCPWiki ${env} (environment-scoped OIDC)`,
        maxSessionDuration: Duration.hours(1),
        assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            'token.actions.githubusercontent.com:sub': `repo:${props.githubRepo}:environment:${env}`,
          },
        }),
      });
      const regions = env === 'prod' ? [this.region, 'us-east-1'] : [this.region];
      const bootstrapRoles = regions.map((r) => `arn:aws:iam::${this.account}:role/cdk-hnb659fds-*-${this.account}-${r}`);
      role.addToPolicy(new iam.PolicyStatement({ actions: ['sts:AssumeRole'], resources: bootstrapRoles }));
      acknowledge(
        role,
        bootstrapRoles.map((arn) => ({ id: `AwsSolutions-IAM5[Resource::${arn}]`, reason: 'Only the CDK bootstrap roles (deploy, file-publishing, lookup) of this account/region.' })),
      );
      new CfnOutput(this, `DeployRoleArn${env}`, { value: role.roleArn });
    }
    acknowledge(this, [
      { id: 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]', reason: 'CDK-managed OIDC provider custom resource.' },
      { id: 'AwsSolutions-L1', reason: 'CDK-managed custom resource runtime.' },
    ]);
  }
}
