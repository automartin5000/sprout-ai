/**
 * SproutAppStack — the AWS infra for one Sprout-built user app.
 *
 * Single-stack design (matches Sprout's own infra/lib/sprout-stack.ts shape):
 *
 *   - DynamoDB table (single-table, pay-per-request)
 *   - S3 bucket for static assets (served by CloudFront)
 *   - Lambda for the server (Hono via hono/aws-lambda)
 *   - HTTP API Gateway in front of the Lambda
 *   - CloudFront distribution: static assets from S3, /api/* to API Gateway
 *
 * Edit this file when you need new AWS resources. Keeping everything in one
 * stack makes diffs reviewable, teardowns predictable, and lets the AI agent
 * find what it needs without hunting through multiple files.
 */
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import {
  HttpApi,
  HttpMethod,
} from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { HttpOrigin, S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Architecture, Code, Function, Runtime } from 'aws-cdk-lib/aws-lambda';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface SproutAppStackProps extends cdk.StackProps {
  envName: string;
  isProd: boolean;
  isPr: boolean;
}

export class SproutAppStack extends cdk.Stack {
  public readonly table: Table;
  public readonly serverFn: Function;
  public readonly assetsBucket: Bucket;
  public readonly uploadsBucket: Bucket;
  public readonly distribution: Distribution;

  constructor(scope: Construct, id: string, props: SproutAppStackProps) {
    super(scope, id, props);

    // ── Data layer ────────────────────────────────────────────────
    this.table = new Table(this, 'AppTable', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: props.isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: props.isProd,
      },
    });

    // ── Static assets ─────────────────────────────────────────────
    this.assetsBucket = new Bucket(this, 'AssetsBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: props.isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !props.isProd,
    });

    // ── Uploads (user-generated content) ──────────────────────────
    // Separate from assets: assets are CloudFront-served build output (read
    // by viewers); uploads are app-controlled (read/write by the server
    // Lambda only, presigned URLs to clients if needed). Mirrors Sprout's
    // sandbox uploads bucket so the same SPROUT_UPLOADS_BUCKET env var
    // points at "the user-content store" in either mode.
    this.uploadsBucket = new Bucket(this, 'UploadsBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: props.isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !props.isProd,
    });

    // ── Server function ──────────────────────────────────────────
    // Sprout's local build produces server-dist/server.js for the Hono app.
    // PRs / first deploys without a server bundle: the Lambda still gets
    // created so the API Gateway integration synth-validates, but it'll
    // return 500 until the user runs `bun run build`.
    //
    // The SPROUT_* env vars MUST match what the multi-tenant sandbox sets
    // in runtime/handler.ts of the Sprout repo. AI-generated user code
    // reads these names; if they diverge between modes, code that works
    // in Share preview silently breaks on Promote to prod. SPROUT_MODE is
    // the explicit switch for code that needs to branch by mode.
    this.serverFn = new Function(this, 'ServerFunction', {
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      handler: 'server.handler',
      code: Code.fromAsset(path.join(process.cwd(), 'server-dist')),
      environment: {
        // Legacy names — kept so any pre-Phase-5 user code that read them
        // directly continues to work. New code should use the SPROUT_* names.
        TABLE_NAME: this.table.tableName,
        ASSETS_BUCKET: this.assetsBucket.bucketName,
        DEPLOY_ENV: props.envName,
        // Sprout env-var compatibility contract (Phase 5). Mirrors what
        // runtime/handler.ts sets per-request in sandbox.
        SPROUT_MODE: 'prod',
        SPROUT_PROJECT_ID: '{{projectId}}',
        SPROUT_DATA_TABLE: this.table.tableName,
        SPROUT_ASSETS_BUCKET: this.assetsBucket.bucketName,
        SPROUT_UPLOADS_BUCKET: this.uploadsBucket.bucketName,
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 1024,
    });
    this.table.grantReadWriteData(this.serverFn);
    this.assetsBucket.grantRead(this.serverFn);
    this.uploadsBucket.grantReadWrite(this.serverFn);

    // ── HTTP API Gateway → Lambda ─────────────────────────────────
    const httpApi = new HttpApi(this, 'HttpApi', {
      description: `Sprout app API (${props.envName})`,
    });
    httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [HttpMethod.ANY],
      integration: new HttpLambdaIntegration('ServerIntegration', this.serverFn),
    });

    // ── CloudFront ───────────────────────────────────────────────
    // Static assets from S3 (with OAC), /api/* to the API Gateway.
    const apiOrigin = new HttpOrigin(
      cdk.Fn.select(2, cdk.Fn.split('/', httpApi.apiEndpoint)),
    );
    this.distribution = new Distribution(this, 'Distribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(this.assetsBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
      },
      additionalBehaviors: {
        'api/*': {
          origin: apiOrigin,
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          allowedMethods: AllowedMethods.ALLOW_ALL,
        },
      },
      errorResponses: [
        // SPA fallback — Vite / React Router need `/about` → /index.html.
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
    });

    cdk.Tags.of(this).add('environment', props.envName);

    // Outputs the workflow + Sprout deploy modal read to surface the URL.
    new cdk.CfnOutput(this, 'AppUrl', {
      value: `https://${this.distribution.domainName}`,
    });
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: httpApi.apiEndpoint,
    });
  }
}
