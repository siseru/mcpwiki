import { join } from 'node:path';
import {
  Arn, CfnOutput, Duration, Fn, RemovalPolicy, Stack, type StackProps,
  aws_apigatewayv2 as apigw,
  aws_backup as backup,
  aws_apigatewayv2_integrations as integrations,
  aws_cloudfront as cf,
  aws_certificatemanager as acm,
  aws_cloudfront_origins as origins,
  aws_cloudwatch as cw,
  aws_cloudwatch_actions as cwActions,
  aws_cognito as cognito,
  aws_dynamodb as ddb,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_route53 as route53,
  aws_route53_targets as targets,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  aws_secretsmanager as secrets,
  aws_sns as sns,
  aws_sns_subscriptions as subs,
  aws_ssm as ssm,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { DomainConfig } from './edge-stack.js';
import { acknowledge } from './nag.js';

export const CLI_REDIRECT_URI = 'http://localhost:53682/callback';

export interface WikiStackProps extends StackProps {
  envName: 'dev' | 'prod';
  repoRoot: string;
  /** CLOUDFRONT-scope WAF web ACL (created in us-east-1). */
  webAclArn?: string;
  /** Custom domain; the certificate (us-east-1) must cover host and auth.<host>. */
  domain?: DomainConfig & { certificate: acm.ICertificate };
  alarmEmail?: string;
}

export class WikiStack extends Stack {
  constructor(scope: Construct, id: string, props: WikiStackProps) {
    super(scope, id, props);
    const { envName } = props;
    const prod = envName === 'prod';
    const removalPolicy = prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const dist = (p: string) => join(props.repoRoot, 'dist', p);

    // ---------------------------------------------------------------- storage
    const logsBucket = new s3.Bucket(this, 'Logs', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED, // required by CloudFront standard logging
      lifecycleRules: [{ expiration: Duration.days(prod ? 365 : 30) }],
      removalPolicy,
      autoDeleteObjects: !prod,
    });

    const contentBucket = new s3.Bucket(this, 'Content', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true, // article history = object versions
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      serverAccessLogsBucket: logsBucket,
      serverAccessLogsPrefix: 's3-content/',
      removalPolicy,
      autoDeleteObjects: !prod,
      // Browsers upload attachments with presigned POSTs and fetch them with presigned GETs, from the wiki origin only.
      cors: [
        {
          allowedOrigins: [props.domain ? `https://${props.domain.host}` : 'https://*.cloudfront.net'],
          allowedMethods: [s3.HttpMethods.POST, s3.HttpMethods.GET],
          allowedHeaders: ['content-type'],
          maxAge: 600,
        },
      ],
    });

    const webBucket = new s3.Bucket(this, 'Web', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      serverAccessLogsBucket: logsBucket,
      serverAccessLogsPrefix: 's3-web/',
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const table = new ddb.Table(this, 'Table', {
      partitionKey: { name: 'PK', type: ddb.AttributeType.STRING },
      sortKey: { name: 'SK', type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'expireAt',
      deletionProtection: prod,
      removalPolicy,
    });
    table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: ddb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: ddb.AttributeType.STRING },
      projectionType: ddb.ProjectionType.ALL,
    });

    if (prod) {
      // Independent, locked recovery point store: even an attacker who obtains admin cannot delete
      // recovery points before minRetention (vault lock, governance mode).
      const vault = new backup.BackupVault(this, 'BackupVault', {
        backupVaultName: 'mcpwiki-prod',
        lockConfiguration: { minRetention: Duration.days(7) },
        removalPolicy: RemovalPolicy.RETAIN,
      });
      const plan = backup.BackupPlan.daily35DayRetention(this, 'BackupPlan', vault);
      const backupRole = new iam.Role(this, 'BackupRole', {
        assumedBy: new iam.ServicePrincipal('backup.amazonaws.com'),
        managedPolicies: [
          'service-role/AWSBackupServiceRolePolicyForBackup',
          'service-role/AWSBackupServiceRolePolicyForRestores',
          'AWSBackupServiceRolePolicyForS3Backup',
          'AWSBackupServiceRolePolicyForS3Restore',
        ].map((n) => iam.ManagedPolicy.fromAwsManagedPolicyName(n)),
      });
      plan.addSelection('Data', {
        role: backupRole,
        disableDefaultBackupPolicy: true,
        resources: [backup.BackupResource.fromDynamoDbTable(table), backup.BackupResource.fromArn(contentBucket.bucketArn)],
      });
      acknowledge(backupRole, [
        { id: 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup]', reason: 'AWS Backup service role.' },
        { id: 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores]', reason: 'AWS Backup service role.' },
        { id: 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/AWSBackupServiceRolePolicyForS3Backup]', reason: 'Required for S3 backups.' },
        { id: 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/AWSBackupServiceRolePolicyForS3Restore]', reason: 'Required for S3 restores.' },
      ]);
    }

    // ---------------------------------------------------------------- auth
    const userPool = new cognito.UserPool(this, 'Users', {
      userPoolName: `mcpwiki-${envName}`,
      selfSignUpEnabled: false,
      signInAliases: { username: true, email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { otp: true, sms: false },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: Duration.days(3),
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // An attacker with a session cannot silently re-point the sign-in e-mail.
      keepOriginal: { email: true },
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      userInvitation: {
        emailSubject: `MCPWiki (${envName}) への招待`,
        emailBody:
          'MCPWiki に招待されました。ユーザ名: {username} / 仮パスワード: {####}\n' +
          '管理者から伝えられた URL でサインインし、パスワード変更と多要素認証 (TOTP) の登録を行ってください。',
      },
      deletionProtection: prod,
      removalPolicy,
    });
    const groups = ['admin', 'editor', 'viewer'].map(
      (name, i) => new cognito.CfnUserPoolGroup(this, `Group-${name}`, { userPoolId: userPool.userPoolId, groupName: name, precedence: i + 1 }),
    );
    void groups;
    const custom = props.domain;
    const authHost = custom ? `auth.${custom.host}` : `mcpwiki-${envName}-${this.account}.auth.${this.region}.amazoncognito.com`;
    const cognitoUrl = `https://${authHost}`;
    const zone = custom ? route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', { zoneName: custom.zoneName, hostedZoneId: custom.hostedZoneId }) : undefined;

    // ---------------------------------------------------------------- api
    const originSecret = new secrets.Secret(this, 'OriginSecret', {
      description: 'Shared secret CloudFront sends to the API origin (blocks direct execute-api access).',
      generateSecretString: { passwordLength: 40, excludePunctuation: true },
    });

    const configParamName = `/mcpwiki/${envName}/runtime-config`;
    const apiLogGroup = new logs.LogGroup(this, 'ApiFnLogs', { retention: logs.RetentionDays.THREE_MONTHS, removalPolicy: RemovalPolicy.DESTROY });
    const fn = new lambda.Function(this, 'ApiFn', {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(dist('backend')),
      memorySize: 512,
      // Caps the blast radius of a flood (e.g. against dev) on the account-wide concurrency pool.
      reservedConcurrentExecutions: prod ? 100 : 20,
      timeout: Duration.seconds(25),
      logGroup: apiLogGroup,
      environment: {
        TABLE_NAME: table.tableName,
        BUCKET_NAME: contentBucket.bucketName,
        USER_POOL_ID: userPool.userPoolId,
        CONFIG_PARAM: configParamName,
        ORIGIN_SECRET_ARN: originSecret.secretArn,
        RATE_PER_MINUTE: '300',
        WRITES_PER_MINUTE: '60',
      },
      description: `MCPWiki ${envName} API + MCP`,
    });
    // Least privilege: no object deletion for articles (history is immutable), only the operations the store uses.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject', 's3:GetObject', 's3:GetObjectVersion'],
        resources: [contentBucket.arnForObjects('articles/*')],
      }),
    );
    // Attachments: the Lambda role signs presigned POST/GET URLs (so it needs Put/Get) and removes rejected or
    // deleted files (versioned bucket: a delete marker; earlier versions stay recoverable, no DeleteObjectVersion).
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'],
        resources: [contentBucket.arnForObjects('attachments/*')],
      }),
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query',
          'dynamodb:BatchGetItem', 'dynamodb:BatchWriteItem', 'dynamodb:ConditionCheckItem',
        ],
        resources: [table.tableArn, `${table.tableArn}/index/GSI1`],
      }),
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:AdminAddUserToGroup', 'cognito-idp:AdminRemoveUserFromGroup', 'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminDisableUser', 'cognito-idp:AdminEnableUser', 'cognito-idp:AdminGetUser',
          'cognito-idp:AdminUserGlobalSignOut', 'cognito-idp:ListUsers', 'cognito-idp:ListUsersInGroup',
        ],
        resources: [userPool.userPoolArn],
      }),
    );
    originSecret.grantRead(fn);
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [Arn.format({ service: 'ssm', resource: 'parameter', resourceName: configParamName.slice(1) }, this)],
      }),
    );

    const api = new apigw.HttpApi(this, 'Api', { apiName: `mcpwiki-${envName}`, description: 'MCPWiki API (behind CloudFront)' });
    const integration = new integrations.HttpLambdaIntegration('ApiIntegration', fn, { payloadFormatVersion: apigw.PayloadFormatVersion.VERSION_2_0 });
    api.addRoutes({ path: '/api/{proxy+}', methods: [apigw.HttpMethod.ANY], integration });
    api.addRoutes({ path: '/mcp', methods: [apigw.HttpMethod.ANY], integration });
    api.addRoutes({ path: '/.well-known/{proxy+}', methods: [apigw.HttpMethod.GET], integration });
    const accessLogs = new logs.LogGroup(this, 'ApiAccessLogs', { retention: logs.RetentionDays.THREE_MONTHS, removalPolicy: RemovalPolicy.DESTROY });
    const stage = api.defaultStage!.node.defaultChild as apigw.CfnStage;
    stage.defaultRouteSettings = { throttlingRateLimit: 50, throttlingBurstLimit: 100 };
    stage.accessLogSettings = {
      destinationArn: accessLogs.logGroupArn,
      format: JSON.stringify({
        requestId: '$context.requestId', ip: '$context.identity.sourceIp', method: '$context.httpMethod', path: '$context.path',
        status: '$context.status', latency: '$context.responseLatency', integrationError: '$context.integrationErrorMessage', time: '$context.requestTime',
      }),
    };

    // ---------------------------------------------------------------- cdn
    // With a custom domain, requests to the default *.cloudfront.net name are redirected (308 keeps method and body).
    const canonical = custom
      ? `var host = r.headers.host ? r.headers.host.value : ''; if (host !== '${custom.host}') { ` +
        "var qs = Object.keys(r.querystring).map(function (k) { var q = r.querystring[k]; return q.multiValue ? q.multiValue.map(function (m) { return k + '=' + m.value; }).join('&') : k + '=' + q.value; }).join('&'); " +
        `return { statusCode: 308, statusDescription: 'Permanent Redirect', headers: { location: { value: 'https://${custom.host}' + r.uri + (qs ? '?' + qs : '') } } }; } `
      : '';
    const spaRewrite = new cf.Function(this, 'SpaRewrite', {
      runtime: cf.FunctionRuntime.JS_2_0,
      comment: 'Canonical host redirect + serve index.html for SPA routes',
      code: cf.FunctionCode.fromInline(
        `function handler(event) { var r = event.request; ${canonical}var u = r.uri; if (u.indexOf('/assets/') !== 0 && u !== '/config.json') { r.uri = '/index.html'; } return r; }`,
      ),
    });
    // Viewer-request function for API / MCP: canonical-host redirect (custom domain) and the real client IP
    // for logs (API Gateway only sees CloudFront edge addresses). Overwrites any client-supplied value.
    const apiViewer = new cf.Function(this, 'ApiViewerRequest', {
      runtime: cf.FunctionRuntime.JS_2_0,
      comment: 'Canonical host redirect + viewer address header for API / MCP',
      code: cf.FunctionCode.fromInline(
        `function handler(event) { var r = event.request; ${canonical}r.headers['x-viewer-address'] = { value: event.viewer.ip }; return r; }`,
      ),
    });
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data: blob:", // no third-party images (no reader beacons); blob: = attachments fetched with auth
      // Attachments are uploaded to / downloaded from the content bucket with presigned URLs.
      `connect-src 'self' ${cognitoUrl} https://${contentBucket.bucketRegionalDomainName}`,
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      `form-action 'self' ${cognitoUrl}`,
      'upgrade-insecure-requests',
    ].join('; ');
    const headers = new cf.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: csp, override: true },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, preload: false, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cf.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cf.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
      },
      customHeadersBehavior: {
        customHeaders: [
          { header: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()', override: true },
          { header: 'Cross-Origin-Opener-Policy', value: 'same-origin', override: true },
        ],
      },
      removeHeaders: ['Server'],
    });
    const apiOrigin = new origins.HttpOrigin(`${api.apiId}.execute-api.${this.region}.amazonaws.com`, {
      protocolPolicy: cf.OriginProtocolPolicy.HTTPS_ONLY,
      customHeaders: { 'x-origin-verify': originSecret.secretValue.unsafeUnwrap() },
      readTimeout: Duration.seconds(30),
    });
    const apiBehavior: cf.BehaviorOptions = {
      origin: apiOrigin,
      viewerProtocolPolicy: cf.ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: cf.AllowedMethods.ALLOW_ALL,
      cachePolicy: cf.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cf.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      responseHeadersPolicy: headers,
      compress: true,
      functionAssociations: [{ function: apiViewer, eventType: cf.FunctionEventType.VIEWER_REQUEST }],
    };
    const distribution = new cf.Distribution(this, 'Cdn', {
      comment: `MCPWiki ${envName}`,
      defaultRootObject: 'index.html',
      httpVersion: cf.HttpVersion.HTTP2_AND_3,
      priceClass: cf.PriceClass.PRICE_CLASS_100,
      enableLogging: true,
      logBucket: logsBucket,
      logFilePrefix: 'cloudfront/',
      webAclId: props.webAclArn,
      ...(custom ? { domainNames: [custom.host], certificate: custom.certificate, minimumProtocolVersion: cf.SecurityPolicyProtocol.TLS_V1_2_2021 } : {}),
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cf.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
        functionAssociations: [{ function: spaRewrite, eventType: cf.FunctionEventType.VIEWER_REQUEST }],
        compress: true,
      },
      additionalBehaviors: { '/api/*': apiBehavior, '/mcp': apiBehavior, '/.well-known/*': apiBehavior },
    });
    const publicUrl = custom ? `https://${custom.host}` : `https://${distribution.distributionDomainName}`;

    // ---------------------------------------------------------------- dns + login domain
    let domain: cognito.UserPoolDomain;
    if (custom && zone) {
      const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution));
      const a = new route53.ARecord(this, 'AliasA', { zone, recordName: custom.host, target });
      new route53.AaaaRecord(this, 'AliasAAAA', { zone, recordName: custom.host, target });
      domain = userPool.addDomain('CustomDomain', {
        customDomain: { domainName: authHost, certificate: custom.certificate },
        managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
      });
      domain.node.addDependency(a); // Cognito requires the parent domain to resolve first
      new route53.ARecord(this, 'AuthAliasA', { zone, recordName: authHost, target: route53.RecordTarget.fromAlias({
          // CloudFront's fixed alias hosted zone; avoids the deprecated lookup custom resource in UserPoolDomainTarget.
          bind: () => ({ dnsName: domain.cloudFrontEndpoint, hostedZoneId: 'Z2FDTNDATAQYW2' }),
        }),
      });
    } else {
      domain = userPool.addDomain('Domain', {
        cognitoDomain: { domainPrefix: authHost.split('.')[0]! },
        managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN, // supports TOTP enrollment at first sign-in
      });
    }

    // ---------------------------------------------------------------- app clients
    const scopes = [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE];
    const webClient = userPool.addClient('WebClient', {
      userPoolClientName: 'web',
      generateSecret: false,
      writeAttributes: new cognito.ClientAttributes(), // users cannot self-modify attributes (e.g. e-mail alias)
      oAuth: { flows: { authorizationCodeGrant: true }, scopes, callbackUrls: [`${publicUrl}/callback`], logoutUrls: [`${publicUrl}/`] },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      accessTokenValidity: Duration.minutes(60),
      idTokenValidity: Duration.minutes(60),
      refreshTokenValidity: Duration.hours(12),
      enableTokenRevocation: true,
      preventUserExistenceErrors: true,
    });
    const cliClient = userPool.addClient('CliClient', {
      userPoolClientName: 'cli-mcp',
      generateSecret: false,
      writeAttributes: new cognito.ClientAttributes(), // users cannot self-modify attributes (e.g. e-mail alias)
      oAuth: { flows: { authorizationCodeGrant: true }, scopes, callbackUrls: [CLI_REDIRECT_URI], logoutUrls: ['http://localhost:53682/'] },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      accessTokenValidity: Duration.minutes(60),
      idTokenValidity: Duration.minutes(60),
      refreshTokenValidity: Duration.days(7),
      enableTokenRevocation: true,
      preventUserExistenceErrors: true,
    });
    for (const [name, c] of [['web', webClient], ['cli', cliClient]] as const) {
      // Managed login + PKCE only: no SRP/password APIs (their tokens carry aws.cognito.signin.user.admin).
      (c.node.defaultChild as cognito.CfnUserPoolClient).explicitAuthFlows = ['ALLOW_REFRESH_TOKEN_AUTH'];
      c.node.addDependency(domain);
      new cognito.CfnManagedLoginBranding(this, `LoginBranding-${name}`, {
        userPoolId: userPool.userPoolId,
        clientId: c.userPoolClientId,
        useCognitoProvidedValues: true,
      });
    }

    new ssm.StringParameter(this, 'RuntimeConfig', {
      parameterName: configParamName,
      description: 'MCPWiki runtime configuration read by the API Lambda',
      stringValue: Fn.toJsonString({ webClientId: webClient.userPoolClientId, cliClientId: cliClient.userPoolClientId, publicUrl }),
    });

    // ---------------------------------------------------------------- web content
    new s3deploy.BucketDeployment(this, 'DeployAssets', {
      sources: [s3deploy.Source.asset(dist('web/assets'))],
      destinationBucket: webBucket,
      destinationKeyPrefix: 'assets/',
      cacheControl: [s3deploy.CacheControl.fromString('public, max-age=31536000, immutable')],
      prune: true,
      memoryLimit: 256,
    });
    new s3deploy.BucketDeployment(this, 'DeployRoot', {
      sources: [
        s3deploy.Source.asset(dist('web/root')),
        s3deploy.Source.jsonData('config.json', {
          env: envName,
          region: this.region,
          cognitoDomain: cognitoUrl,
          webClientId: webClient.userPoolClientId,
          cliClientId: cliClient.userPoolClientId,
          cliRedirectUri: CLI_REDIRECT_URI,
          issuer: `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
        }),
      ],
      destinationBucket: webBucket,
      cacheControl: [s3deploy.CacheControl.fromString('no-cache')],
      prune: false,
      distribution,
      distributionPaths: ['/index.html', '/config.json'],
      memoryLimit: 256,
    });

    // ---------------------------------------------------------------- monitoring
    const topic = new sns.Topic(this, 'Alarms', { displayName: `MCPWiki ${envName} alarms`, enforceSSL: true });
    if (props.alarmEmail) topic.addSubscription(new subs.EmailSubscription(props.alarmEmail));
    const alarm = (id: string, metric: cw.IMetric, threshold: number, desc: string) => {
      const a = new cw.Alarm(this, id, {
        metric,
        threshold,
        evaluationPeriods: 1,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
        alarmDescription: desc,
      });
      a.addAlarmAction(new cwActions.SnsAction(topic));
    };
    alarm('FnErrors', fn.metricErrors({ period: Duration.minutes(5) }), 5, 'API Lambda errors');
    alarm('FnThrottles', fn.metricThrottles({ period: Duration.minutes(5) }), 1, 'API Lambda throttled');
    alarm('Api5xx', api.metricServerError({ period: Duration.minutes(5) }), 5, 'API 5xx responses');
    alarm('Api4xxSpike', api.metricClientError({ period: Duration.minutes(5) }), 500, 'Unusual number of 4xx (possible scanning / brute force)');

    // ---------------------------------------------------------------- outputs
    new CfnOutput(this, 'Url', { value: publicUrl });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'CliConfigure', { value: `mcpwiki configure --env ${envName} --url ${publicUrl}` });
    new CfnOutput(this, 'McpEndpoint', { value: `${publicUrl}/mcp` });

    // ---------------------------------------------------------------- cdk-nag
    // CDK-managed BucketDeployment / autoDeleteObjects custom resources.
    for (const child of this.node.children) {
      if (!child.node.id.startsWith('Custom::')) continue;
      acknowledge(child, [
        ...['s3:List*', 's3:GetObject*', 's3:GetBucket*', 's3:DeleteObject*', 's3:Abort*'].map((a) => ({
          id: `AwsSolutions-IAM5[Action::${a}]`,
          reason: 'CDK-managed BucketDeployment copies assets into the web bucket (scoped to the asset and web buckets).',
        })),
        { id: 'AwsSolutions-IAM5[Resource::*]', reason: 'CDK-managed BucketDeployment (CloudFront invalidation has no resource-level permissions).' },
        ...['hnb659fds', 'mwdev'].map((q) => ({ id: `AwsSolutions-IAM5[Resource::arn:aws:s3:::cdk-${q}-assets-${this.account}-${this.region}/*]`, reason: 'CDK asset bucket.' })),
        { id: `AwsSolutions-IAM5[Resource::<${this.getLogicalId(webBucket.node.defaultChild as s3.CfnBucket)}.Arn>/*]`, reason: 'Deploys the web app into the web bucket.' },
        { id: 'AwsSolutions-L1', reason: 'CDK-managed custom resource runtime.' },
      ]);
    }
    acknowledge(this, [
      { id: 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]', reason: 'CloudWatch Logs only.' },
      { id: `AwsSolutions-IAM5[Resource::<${this.getLogicalId(contentBucket.node.defaultChild as s3.CfnBucket)}.Arn>/articles/*]`, reason: 'Article objects (put/get/get-version only, no delete).' },
      { id: `AwsSolutions-IAM5[Resource::<${this.getLogicalId(contentBucket.node.defaultChild as s3.CfnBucket)}.Arn>/attachments/*]`, reason: 'Attachment objects: presigned upload/download and removal of rejected/deleted files (no version deletion).' },
      { id: 'AwsSolutions-COG8', reason: 'Cognito Plus tier (threat protection) is not used for cost reasons; MFA is mandatory.' },
      { id: 'AwsSolutions-COG3', reason: 'Threat protection requires the Cognito Plus tier; MFA is mandatory and WAF rate limiting is applied in prod (cost trade-off).' },
      { id: 'AwsSolutions-APIG4', reason: 'Authorization is performed in the Lambda (Cognito JWT verification, see src/backend/auth.ts) so MCP clients get RFC 9728 WWW-Authenticate responses.' },
      { id: 'AwsSolutions-CFR1', reason: 'Geo restriction is not a requirement.' },
      { id: 'AwsSolutions-SMG4', reason: 'Origin verification secret: rotate by redeploying (changing the secret) — automatic rotation would desynchronize CloudFront.' },
      { id: 'AwsSolutions-SNS2', reason: 'CloudWatch alarm notifications only (no sensitive data); SSE with aws/sns is incompatible with CloudWatch publishers.' },
      { id: 'AwsSolutions-S1', reason: 'The logs bucket itself does not log access (would recurse).' },
    ]);
    if (!custom) {
      acknowledge(this, [{ id: 'AwsSolutions-CFR4', reason: 'Default *.cloudfront.net certificate (no custom domain configured); configure context "domains" to pin TLSv1.2_2021.' }]);
    }
    if (!props.webAclArn) {
      acknowledge(this, [{ id: 'AwsSolutions-CFR2', reason: 'WAF is enabled for prod only (cost); dev relies on API throttling and per-user rate limits.' }]);
    }
  }
}
