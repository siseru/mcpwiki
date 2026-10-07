import {
  CfnOutput, Duration, Stack, type StackProps,
  aws_certificatemanager as acm,
  aws_cloudwatch as cw,
  aws_cloudwatch_actions as cwActions,
  aws_route53 as route53,
  aws_sns as sns,
  aws_sns_subscriptions as subs,
  aws_wafv2 as waf,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { acknowledge } from './nag.js';

export interface DomainConfig {
  zoneName: string;
  hostedZoneId: string;
  /** Wiki host name, e.g. wiki.example.com. The login UI uses auth.<host>. */
  host: string;
}

export interface EdgeStackProps extends StackProps {
  envName: string;
  domain?: DomainConfig;
  waf: boolean;
  alarmEmail?: string;
}

/**
 * Global (us-east-1) resources used by CloudFront and Cognito custom domains:
 * the ACM certificate (DNS-validated in Route 53, renewed automatically by ACM) and the WAF web ACL.
 */
export class EdgeStack extends Stack {
  public readonly certificate?: acm.ICertificate;
  public readonly webAclArn?: string;

  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);

    if (props.domain) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
        zoneName: props.domain.zoneName,
        hostedZoneId: props.domain.hostedZoneId,
      });
      // DNS validation records stay in Route 53, which is what lets ACM renew the certificate automatically.
      const cert = new acm.Certificate(this, 'Certificate', {
        domainName: props.domain.host,
        subjectAlternativeNames: [`auth.${props.domain.host}`],
        validation: acm.CertificateValidation.fromDns(zone),
        certificateName: `mcpwiki-${props.envName}`,
      });
      this.certificate = cert;

      // Alert if renewal ever fails (ACM normally renews ~60 days before expiry).
      const topic = new sns.Topic(this, 'CertAlarms', { displayName: `MCPWiki ${props.envName} certificate alarms`, enforceSSL: true });
      if (props.alarmEmail) topic.addSubscription(new subs.EmailSubscription(props.alarmEmail));
      const alarm = new cw.Alarm(this, 'CertExpiry', {
        metric: cert.metricDaysToExpiry({ period: Duration.days(1) }),
        threshold: 30,
        evaluationPeriods: 1,
        comparisonOperator: cw.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cw.TreatMissingData.BREACHING,
        alarmDescription: `ACM certificate for ${props.domain.host} expires in < 30 days (automatic renewal failed?)`,
      });
      alarm.addAlarmAction(new cwActions.SnsAction(topic));
      acknowledge(this, [
        { id: 'AwsSolutions-SNS2', reason: 'CloudWatch alarm notifications only; SSE with aws/sns is incompatible with CloudWatch publishers.' },
      ]);
      new CfnOutput(this, 'CertificateArn', { value: cert.certificateArn });
    }

    if (props.waf) this.webAclArn = this.createWebAcl(props.envName);
  }

  private createWebAcl(envName: string): string {
    const vis = (name: string): waf.CfnWebACL.VisibilityConfigProperty => ({
      cloudWatchMetricsEnabled: true,
      metricName: `mcpwiki-${envName}-${name}`,
      sampledRequestsEnabled: true,
    });
    const managed = (name: string, priority: number, overrides: string[] = []): waf.CfnWebACL.RuleProperty => ({
      name,
      priority,
      overrideAction: { none: {} },
      statement: {
        managedRuleGroupStatement: {
          vendorName: 'AWS',
          name,
          ruleActionOverrides: overrides.map((o) => ({ name: o, actionToUse: { count: {} } })),
        },
      },
      visibilityConfig: vis(name),
    });
    const acl = new waf.CfnWebACL(this, 'WebAcl', {
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: vis('acl'),
      rules: [
        {
          name: 'RateLimitPerIp',
          priority: 0,
          action: { block: {} },
          statement: { rateBasedStatement: { limit: 1000, aggregateKeyType: 'IP', evaluationWindowSec: 300 } },
          visibilityConfig: vis('rate'),
        },
        managed('AWSManagedRulesAmazonIpReputationList', 1),
        // Wiki articles legitimately contain large Markdown bodies and code samples with HTML/script text,
        // so body-size / body-XSS rules are counted rather than blocked (rendering is sanitized + CSP).
        managed('AWSManagedRulesCommonRuleSet', 2, ['SizeRestrictions_BODY', 'CrossSiteScripting_BODY', 'GenericLFI_BODY', 'GenericRFI_BODY']),
        managed('AWSManagedRulesKnownBadInputsRuleSet', 3),
      ],
    });
    new CfnOutput(this, 'WebAclArn', { value: acl.attrArn });
    return acl.attrArn;
  }
}
