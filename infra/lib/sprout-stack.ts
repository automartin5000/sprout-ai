import * as path from 'node:path';
import * as url from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import {
  Architecture,
  Code,
  Function as LambdaFunction,
  FunctionUrlAuthType,
  Runtime,
  HttpMethod as FunctionUrlHttpMethod,
} from 'aws-cdk-lib/aws-lambda';
import {
  Bucket,
  BlockPublicAccess,
  BucketEncryption,
  ObjectOwnership,
} from 'aws-cdk-lib/aws-s3';
import {
  ApiMapping,
  CorsHttpMethod,
  DomainName,
  HttpApi,
  HttpMethod,
} from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';
import { ARecord, HostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { ApiGatewayv2DomainProperties } from 'aws-cdk-lib/aws-route53-targets';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  LambdaEdgeEventType,
  OriginRequestCookieBehavior,
  OriginRequestHeaderBehavior,
  OriginRequestPolicy,
  OriginRequestQueryStringBehavior,
  PriceClass,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { experimental as cloudfrontExperimental } from 'aws-cdk-lib/aws-cloudfront';
// `EdgeFunction` is both a constructor and a type. Re-export both shapes so
// callsites can `new EdgeFunction(...)` AND declare `: EdgeFunction` props.
const EdgeFunction = cloudfrontExperimental.EdgeFunction;
type EdgeFunction = InstanceType<typeof cloudfrontExperimental.EdgeFunction>;
import { FunctionUrlOrigin, S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { Rule, RuleTargetInput, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as LambdaTarget } from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';
import { buildApiDomain } from '../../shared/domain-constants.js';
import type { EnvName } from '../../shared/environments.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, '../..');
const LAMBDA_DIR = path.join(REPO_ROOT, 'dist-lambda/api');
const RUNTIME_DIST = path.join(REPO_ROOT, 'runtime/dist');

export interface SproutStackProps extends cdk.StackProps {
  envName: EnvName;
  hostedZone?: string;
  auth0Domain: string;
  auth0Audience: string;
}

/**
 * The unified Sprout infrastructure stack. One CFN stack per environment owns
 * every shared resource — DynamoDB, all four S3 buckets, the API Lambda + HTTP
 * API, the shared-runtime Lambda + EventBridge warmer, the Lambda@Edge router,
 * and the CloudFront distribution at apps.sprout.${env}.
 *
 * NOTE on VPC config: the company-internal CDK wrapper layer attaches VPC
 * subnets/SGs to Lambda constructs at synth time on the work machine. This
 * code intentionally declares Lambdas without `vpc:` — the wrapper layers
 * it in. Do NOT add VPC config here.
 */
export class SproutStack extends cdk.Stack {
  public readonly table: Table;
  public readonly api: HttpApi;
  public readonly apiLambda: LambdaFunction;
  public readonly runtimeLambda: LambdaFunction;
  public readonly edgeRouter: EdgeFunction;
  public readonly distribution: Distribution;
  public readonly assetsBucket: Bucket;
  public readonly codeBucket: Bucket;
  public readonly uploadsBucket: Bucket;
  public readonly stagingBucket: Bucket;

  constructor(scope: Construct, id: string, props: SproutStackProps) {
    super(scope, id, { ...props, stackName: `Sprout-${props.envName}` });

    // ---- Storage layer ------------------------------------------------------
    this.table = this.createTable(props.envName);
    this.assetsBucket = this.createBucket('AssetsBucket', `sprout-assets-${props.envName}`, false);
    this.codeBucket = this.createBucket('CodeBucket', `sprout-code-${props.envName}`, false);
    this.uploadsBucket = this.createBucket('UploadsBucket', `sprout-uploads-${props.envName}`, false);
    this.stagingBucket = this.createBucket('StagingBucket', `sprout-staging-${props.envName}`, true);

    // ---- Shared runtime Lambda ---------------------------------------------
    this.runtimeLambda = this.createRuntimeLambda(props.envName);
    this.createRuntimeWarmer(this.runtimeLambda);
    const runtimeUrl = this.runtimeLambda.addFunctionUrl({
      // OAC (CloudFront → Function URL) requires AWS_IAM auth. The OAC's
      // signing role grants invoke permission; direct internet callers get
      // 403 from IAM. So we get CloudFront-only access for free.
      authType: FunctionUrlAuthType.AWS_IAM,
      // CORS is irrelevant: CloudFront is the only legitimate caller. We set
      // wide CORS so direct testing also works during dev.
      cors: {
        allowedOrigins: ['*'],
        allowedHeaders: ['*'],
        // Function URL CORS expects lambda.HttpMethod (from aws-cdk-lib/aws-lambda),
        // which is a separate enum from apigatewayv2's HttpMethod. Use the
        // wildcard '*' to sidestep both — CloudFront is the only legitimate caller.
        allowedMethods: [FunctionUrlHttpMethod.ALL],
      },
    });

    // ---- API Lambda + HTTP API ---------------------------------------------
    this.apiLambda = this.createApiLambda(props);
    this.api = this.createApi(this.apiLambda, props);

    // ---- Lambda@Edge router ------------------------------------------------
    this.edgeRouter = this.createEdgeRouter(props.envName);
    // The edge router reads PROJECT#<id>/META from DDB on every cache miss
    // to validate that a projectId exists + grab its current version. Without
    // this grant the lookup throws and the router fail-opens — forwarding
    // requests to the runtime Lambda for projects that don't exist, which
    // then returns 403 (the Function URL's AWS_IAM auth blocks edge-bypass
    // requests from arbitrary callers). Adding read-only DDB access on the
    // single table the edge function needs.
    this.table.grantReadData(this.edgeRouter);

    // ---- CloudFront distribution -------------------------------------------
    this.distribution = this.createDistribution(this.edgeRouter, runtimeUrl, this.assetsBucket);

    // ---- Lambda Function URL permission (Oct-2025 rule) --------------------
    // Per https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html (top
    // of page note): "Starting in October 2025, new function URLs will
    // require both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction`
    // permissions." CDK's FunctionUrlOrigin.withOriginAccessControl only
    // grants InvokeFunctionUrl — so out-of-the-box, CloudFront's OAC sigs
    // are valid but Lambda still 403s for InvokeFunction. Add the second
    // statement explicitly. SourceArn pins it to this distribution.
    this.runtimeLambda.addPermission('CloudFrontOacInvokeFunction', {
      principal: new cdk.aws_iam.ServicePrincipal('cloudfront.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceArn: cdk.Fn.join('', [
        'arn:',
        cdk.Aws.PARTITION,
        ':cloudfront::',
        cdk.Aws.ACCOUNT_ID,
        ':distribution/',
        this.distribution.distributionId,
      ]),
    });

    // The publishedUrl() helper in lambda/api/routes/publish.ts uses
    // APPS_BASE_URL to build the per-project public URLs (and is what the
    // desktop client surfaces to the user post-publish). With no custom
    // hostedZone, that's the CloudFront default domain — wire it back into
    // the API Lambda env so /publish, /publish/complete, and /share/:code/open
    // all return reachable URLs instead of the apps.sprout.local fallback.
    const appsBaseUrl = props.hostedZone
      ? `https://apps.${props.envName}.sprout.${props.hostedZone}`
      : cdk.Fn.join('', ['https://', this.distribution.distributionDomainName]);
    this.apiLambda.addEnvironment('APPS_BASE_URL', appsBaseUrl);

    // ---- SSM discovery -----------------------------------------------------
    this.publishSsmParams(props.envName);

    // ---- Custom domain for the API only (apps.sprout.${env} stays on the
    // default cloudfront.net cert for v1 — see Distribution note above) -----
    if (props.hostedZone) {
      this.attachApiCustomDomain(this.api, props.envName, props.hostedZone);
    }

    cdk.Tags.of(this).add('environment', props.envName);
    cdk.Tags.of(this).add('project', 'sprout');
  }

  // ===========================================================================
  // DynamoDB
  // ===========================================================================
  private createTable(envName: EnvName): Table {
    return new Table(this, 'SproutTable', {
      tableName: `sprout-${envName}`,
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: envName === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: envName === 'prod',
      },
    });
  }

  // ===========================================================================
  // S3
  // ===========================================================================
  private createBucket(id: string, name: string, withTransientLifecycle: boolean): Bucket {
    const fullName = `${name}-${this.account}`;
    return new Bucket(this, id, {
      bucketName: fullName,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: withTransientLifecycle
        ? [{ id: 'expire-transient', expiration: cdk.Duration.days(1) }]
        : undefined,
    });
  }

  // ===========================================================================
  // Shared runtime Lambda
  // ===========================================================================
  private createRuntimeLambda(envName: EnvName): LambdaFunction {
    const fn = new LambdaFunction(this, 'RuntimeFunction', {
      functionName: `sprout-runtime-${envName}`,
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      handler: 'index.handler',
      code: Code.fromAsset(path.join(RUNTIME_DIST, 'handler.zip')),
      memorySize: 1024,
      timeout: cdk.Duration.seconds(30),
      // /tmp 10GB via ephemeralStorageSize
      ephemeralStorageSize: cdk.Size.mebibytes(10240),
      environment: {
        TABLE_NAME: this.table.tableName,
        DEPLOY_ENV: envName,
        CODE_BUCKET: this.codeBucket.bucketName,
        ASSETS_BUCKET: this.assetsBucket.bucketName,
        // The uploads bucket has existed in this stack since Phase 3 and the
        // runtime Lambda has read/write to it (grantReadWrite below), but the
        // name was never plumbed through to user-app code. SKILL.md has been
        // documenting SPROUT_UPLOADS_BUCKET as a usable var the whole time;
        // exposing it here makes that documentation true. The handler reads
        // this and re-exports it as SPROUT_UPLOADS_BUCKET per request.
        UPLOADS_BUCKET: this.uploadsBucket.bucketName,
      },
    });

    // Tenancy is convention-based for v1 (see plan trade-offs). Grant the
    // runtime Lambda everything it needs and trust the project code to use
    // its SPROUT_PROJECT_ID prefix.
    this.codeBucket.grantRead(fn);
    this.assetsBucket.grantReadWrite(fn);
    this.uploadsBucket.grantReadWrite(fn);
    this.table.grantReadWriteData(fn);
    return fn;
  }

  private createRuntimeWarmer(runtime: LambdaFunction): void {
    new Rule(this, 'RuntimeWarmupRule', {
      ruleName: `sprout-runtime-warmup-${this.stackEnv}`,
      description: 'Pings the shared runtime Lambda every 5 min to keep it warm.',
      schedule: Schedule.rate(cdk.Duration.minutes(5)),
      targets: [
        new LambdaTarget(runtime, {
          event: RuleTargetInput.fromObject({ warmup: true }),
        }),
      ],
    });
  }

  private get stackEnv(): string {
    // Convenience: the env name is the stack name suffix. Avoids passing
    // envName through every helper.
    return this.stackName.replace(/^Sprout-/, '');
  }

  // ===========================================================================
  // API Lambda + HTTP API
  // ===========================================================================
  private createApiLambda(props: SproutStackProps): LambdaFunction {
    const fn = new LambdaFunction(this, 'ApiFunction', {
      functionName: `sprout-api-${props.envName}`,
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      handler: 'index.handler',
      code: Code.fromAsset(LAMBDA_DIR),
      environment: {
        TABLE_NAME: this.table.tableName,
        DEPLOY_ENV: props.envName,
        AUTH0_DOMAIN: props.auth0Domain,
        AUTH0_AUDIENCE: props.auth0Audience,
        STAGING_BUCKET: this.stagingBucket.bucketName,
        ASSETS_BUCKET: this.assetsBucket.bucketName,
        CODE_BUCKET: this.codeBucket.bucketName,
        RUNTIME_FUNCTION_NAME: this.runtimeLambda.functionName,
      },
      timeout: cdk.Duration.seconds(30),
    });
    this.table.grantReadWriteData(fn);
    this.stagingBucket.grantReadWrite(fn);
    this.assetsBucket.grantReadWrite(fn);
    this.codeBucket.grantReadWrite(fn);
    // Allow API to invoke the runtime (warmup ping / publish-time eviction).
    this.runtimeLambda.grantInvoke(fn);
    return fn;
  }

  private createApi(fn: LambdaFunction, props: SproutStackProps): HttpApi {
    const allowedOrigins = [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:3000',
    ];

    const api = new HttpApi(this, 'SproutHttpApi', {
      description: 'HTTP API for Sprout',
      disableExecuteApiEndpoint: !!props.hostedZone,
      corsPreflight: {
        allowOrigins: allowedOrigins,
        allowMethods: [
          CorsHttpMethod.GET,
          CorsHttpMethod.POST,
          CorsHttpMethod.PUT,
          CorsHttpMethod.DELETE,
          CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['Content-Type', 'Authorization'],
        allowCredentials: true,
      },
    });

    const authorizer = new HttpJwtAuthorizer(
      'Auth0JWTAuthorizer',
      `https://${props.auth0Domain}/`,
      {
        authorizerName: 'Auth0JWTAuthorizer',
        identitySource: ['$request.header.Authorization'],
        jwtAudience: [props.auth0Audience],
      },
    );

    const integration = new HttpLambdaIntegration('ApiLambdaIntegration', fn);

    const authedPaths = [
      '/projects',
      '/projects/{id}',
      '/projects/{id}/state',
      '/projects/{projectId}/chat',
      '/projects/{projectId}/publish',
      // Phase 4.0 split publish into start + complete. Both halves need
      // JWT routes registered or the second leg returns the API Gateway
      // default 404 (and the desktop modal looks like the publish "did
      // nothing" even though the staging bucket got the upload).
      '/projects/{projectId}/publish/complete',
      '/projects/{projectId}/share',
      '/jobs/{jobId}',
      '/jobs/{jobId}/start',
      '/share',
    ];
    for (const p of authedPaths) {
      api.addRoutes({
        path: p,
        methods: [HttpMethod.GET, HttpMethod.POST, HttpMethod.PUT, HttpMethod.DELETE],
        integration,
        authorizer,
      });
    }
    api.addRoutes({ path: '/share/{token}', methods: [HttpMethod.GET], integration });
    api.addRoutes({ path: '/share/{code}/open', methods: [HttpMethod.GET], integration });
    api.addRoutes({ path: '/share/{code}/publish', methods: [HttpMethod.POST], integration });
    // Share-code publish/complete is also unauthenticated (the share code
    // itself is the credential — same as /share/{code}/publish).
    api.addRoutes({ path: '/share/{code}/publish/complete', methods: [HttpMethod.POST], integration });
    api.addRoutes({ path: '/healthz', methods: [HttpMethod.GET], integration });

    new cdk.CfnOutput(this, 'ApiEndpoint', { value: api.apiEndpoint });
    return api;
  }

  // ===========================================================================
  // Lambda@Edge router
  // ===========================================================================
  private createEdgeRouter(envName: EnvName): EdgeFunction {
    // EdgeFunction is forced into us-east-1. The build script emits a CJS
    // bundle that hard-codes the table name via a string marker (see
    // edge-router.ts) — but for simplicity in v1 we accept that the artifact
    // is environment-specific and rebuild per env. Future enhancement: ship
    // one artifact + a small SSM-backed configuration shim.
    return new EdgeFunction(this, 'EdgeRouter', {
      functionName: `sprout-edge-router-${envName}`,
      runtime: Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: Code.fromAsset(path.join(RUNTIME_DIST, 'edge-router.zip')),
      memorySize: 128,
      timeout: cdk.Duration.seconds(5),
      // Lambda@Edge can't have env vars — table name is baked at build time.
    });
  }

  // ===========================================================================
  // CloudFront distribution
  // ===========================================================================
  private createDistribution(
    edge: EdgeFunction,
    runtimeUrl: cdk.aws_lambda.FunctionUrl,
    assets: Bucket,
  ): Distribution {
    // TODO(phase-3-followup): allocate an ACM cert in us-east-1 for
    // `apps.sprout.${env}.${hostedZone}` and attach it here. Until that's
    // requested via the company's manual process, the distribution uses the
    // default `*.cloudfront.net` certificate.
    const runtimeOrigin = FunctionUrlOrigin.withOriginAccessControl(runtimeUrl);
    const assetsOrigin = S3BucketOrigin.withOriginAccessControl(assets);

    const edgeLambdas = [
      {
        functionVersion: edge.currentVersion,
        eventType: LambdaEdgeEventType.VIEWER_REQUEST,
      },
    ];

    // For the api behavior we ALSO need the request body delivered to the
    // edge function (IncludeBody: true) so it can compute SHA256(body) and
    // inject `x-amz-content-sha256` before CloudFront signs the OAC request
    // — Lambda Function URL otherwise rejects POST/PUT/PATCH with
    // SignatureDoesNotMatch. AWS hard-caps IncludeBody bodies at 40 KB,
    // which bounds the API request size for /api/*; CRUD JSON bodies are
    // well under this in practice.
    const edgeLambdasWithBody = [
      {
        functionVersion: edge.currentVersion,
        eventType: LambdaEdgeEventType.VIEWER_REQUEST,
        includeBody: true,
      },
    ];

    // OAC + Lambda Function URL gotcha: when CloudFront's OAC signs the
    // request to a Lambda Function URL, the signature lives in the
    // Authorization header. If the OriginRequestPolicy ALSO forwards the
    // viewer's Authorization header (as ALL_VIEWER_EXCEPT_HOST_HEADER does),
    // the two headers fight — and in practice the signed request gets
    // rejected with 403/AccessDeniedException at the Function URL boundary.
    //
    // Per AWS docs on "Origin access control for Lambda function URL
    // origins": the origin request policy MUST NOT include Authorization.
    // We allow-list the headers the user app actually needs (User-Agent,
    // cookies, content-type, etc.) and explicitly omit Authorization.
    // Headers set by the Lambda@Edge router (x-sprout-project-id, etc.)
    // pass through automatically — they're not viewer headers.
    const runtimeOriginPolicy = new OriginRequestPolicy(this, 'RuntimeOriginPolicy', {
      originRequestPolicyName: `sprout-runtime-origin-policy-${this.stackEnv}`,
      comment: 'Forwards viewer headers needed by user apps but NOT Authorization (OAC owns that)',
      cookieBehavior: OriginRequestCookieBehavior.all(),
      queryStringBehavior: OriginRequestQueryStringBehavior.all(),
      // CDK validates that Authorization + Accept-Encoding cannot be in an
      // OriginRequestPolicy allowList — they must come via CachePolicy
      // instead. Authorization is exactly the header we WANT excluded
      // (OAC sets it); Accept-Encoding we just don't forward at all.
      //
      // GOTCHA: the OriginRequestPolicy applies to ALL headers in the
      // outgoing request, INCLUDING headers added by Lambda@Edge. So even
      // though edge-router.ts calls setHeader('x-sprout-project-id', …),
      // CloudFront strips it before forwarding unless the name is in this
      // allow-list. The runtime Lambda then 400s with "missing X-Sprout-
      // Project-Id". Both x-sprout-* headers MUST be allow-listed here.
      // CloudFront caps an OriginRequestPolicy at 10 headers AND rejects
      // certain header names that are handled elsewhere:
      //   - Authorization / Accept-Encoding → managed via CachePolicy
      //   - Cookie → handled by cookieBehavior (above)
      //   - Host / Connection / etc → managed by CloudFront itself
      // Listing any of those returns InvalidRequest from CFN.
      headerBehavior: OriginRequestHeaderBehavior.allowList(
        'User-Agent',
        'Referer',
        'Accept',
        'Accept-Language',
        'Content-Type',
        'Content-Length',
        'Origin',
        'CloudFront-Forwarded-Proto',
        'x-sprout-project-id',
        'x-sprout-route',
      ),
    });

    // CloudFront routes by ORIGINAL request URI (before any Lambda@Edge URI
    // rewrites). So:
    //   - `*/api/*` matches the original `/<projectId>/api/...` and goes to
    //     the runtime Lambda Function URL.
    //   - Everything else falls through to the default behavior, which hits
    //     the assets S3 bucket. The edge router rewrites the URI to
    //     `/<projectId>/v<version>/<rest>` (or `.../index.html` for SPA
    //     routes) before S3 sees it, so static files are served straight
    //     from cache with no Lambda hop.
    const distribution = new Distribution(this, 'SproutDistribution', {
      comment: `Sprout ${this.stackEnv} — path-routed multi-tenant front door`,
      priceClass: PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: assetsOrigin,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        // SPA shells don't need POST/PUT — but allowing all keeps the surface
        // uniform and costs nothing for paths that never see those methods.
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        edgeLambdas,
      },
      additionalBehaviors: {
        // `/api/*` (anchored at start, no leading wildcard) catches
        // origin-absolute fetches from SPA code that forgot the project
        // base path (e.g. `fetch("/api/scores")` from a page mounted at
        // `/<id>/`). The edge function's Referer shim then recovers the
        // projectId and rewrites the URI. Without this behavior, `/api/*`
        // requests fall through to the S3 default and 403. Must come BEFORE
        // `*/api/*` so CloudFront picks the more-specific anchored pattern
        // for apex-relative requests.
        '/api/*': {
          origin: runtimeOrigin,
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_ALL,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          compress: false,
          edgeLambdas: edgeLambdasWithBody,
        },
        // `*/api/*` matches `/<projectId>/api/<anything>` on the way in.
        // Lambda@Edge runs with IncludeBody: true so it can compute
        // SHA256(body) and inject `x-amz-content-sha256` before CloudFront's
        // OAC signs the request to the Lambda Function URL. Per AWS docs,
        // every POST/PUT to a Function URL behind OAC needs that header set
        // by the caller; we set it at the edge so user apps don't have to.
        //
        // Compression off: CloudFront could re-encode bodies in transit if
        // it negotiates gzip with the origin, which would invalidate the
        // hash. Runtime serves JSON (small) — bandwidth cost is negligible.
        //
        // No OriginRequestPolicy: forward only the minimum CloudFront's
        // signing/OAC requires (Host is overridden anyway). The user app's
        // Hono handler doesn't rely on forwarded viewer headers; if that
        // changes, add a minimal allow-list here (but be aware of the
        // SigV4 interaction — every signed header must match what the
        // Function URL sees).
        '*/api/*': {
          origin: runtimeOrigin,
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_ALL,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          compress: false,
          edgeLambdas: edgeLambdasWithBody,
        },
      },
    });

    new cdk.CfnOutput(this, 'CloudFrontDomain', {
      value: distribution.distributionDomainName,
    });
    return distribution;
  }

  // ===========================================================================
  // SSM
  // ===========================================================================
  private publishSsmParams(envName: EnvName): void {
    const base = `/sprout/${envName}`;
    new StringParameter(this, 'ParamRuntimeFunctionName', {
      parameterName: `${base}/runtime-function-name`,
      stringValue: this.runtimeLambda.functionName,
    });
    new StringParameter(this, 'ParamStagingBucket', {
      parameterName: `${base}/staging-bucket`,
      stringValue: this.stagingBucket.bucketName,
    });
    new StringParameter(this, 'ParamCodeBucket', {
      parameterName: `${base}/code-bucket`,
      stringValue: this.codeBucket.bucketName,
    });
    new StringParameter(this, 'ParamAssetsBucket', {
      parameterName: `${base}/assets-bucket`,
      stringValue: this.assetsBucket.bucketName,
    });
    new StringParameter(this, 'ParamApiTable', {
      parameterName: `${base}/api-table`,
      stringValue: this.table.tableName,
    });
  }

  // ===========================================================================
  // API custom domain (apex of API, not of apps.sprout)
  // ===========================================================================
  private attachApiCustomDomain(api: HttpApi, envName: EnvName, hostedZone: string): void {
    const apiDomain = buildApiDomain({ envName, hostedZone });
    const zone = HostedZone.fromLookup(this, 'HostedZone', { domainName: hostedZone });

    const cert = new Certificate(this, 'ApiCertificate', {
      domainName: apiDomain,
      validation: CertificateValidation.fromDns(zone),
    });

    const domain = new DomainName(this, 'ApiDomainName', {
      domainName: apiDomain,
      certificate: cert,
    });

    new ApiMapping(this, 'ApiMapping', { api, domainName: domain });

    new ARecord(this, 'ApiAliasRecord', {
      zone,
      recordName: apiDomain.replace(`.${zone.zoneName}`, ''),
      target: RecordTarget.fromAlias(
        new ApiGatewayv2DomainProperties(
          domain.regionalDomainName,
          domain.regionalHostedZoneId,
        ),
      ),
    });

    new cdk.CfnOutput(this, 'ApiCustomDomainUrl', { value: `https://${apiDomain}` });
  }
}
