import * as path from 'path';
import * as url from 'url';
import * as cdk from 'aws-cdk-lib';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Architecture, Code, Function, Runtime } from 'aws-cdk-lib/aws-lambda';
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
import { ARecord, HostedZone, IHostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { ApiGatewayv2DomainProperties } from 'aws-cdk-lib/aws-route53-targets';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { buildApiDomain } from '../../shared/domain-constants.js';
import type { EnvName } from '../../shared/environments.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ApiStackProps extends cdk.StackProps {
  envName: EnvName;
  hostedZone?: string;
  auth0Domain: string;
  auth0Audience: string;
}

export class ApiStack extends cdk.Stack {
  public readonly api: HttpApi;
  public readonly table: Table;
  public readonly lambdaFn: Function;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, { ...props, stackName: `Sprout-Api-${props.envName}` });

    this.table = this.createTable(props.envName);
    this.lambdaFn = this.createLambda(this.table, props);
    this.api = this.createApi(this.lambdaFn, props);

    // Publish the table name to SSM so other stacks can resolve it without
    // a CFN cross-stack dependency.
    new StringParameter(this, 'ApiTableNameParam', {
      parameterName: `/sprout/${props.envName}/api-table`,
      stringValue: this.table.tableName,
      description: 'DynamoDB table name for the Sprout API.',
    });

    if (props.hostedZone) {
      this.attachCustomDomain(this.api, props.envName, props.hostedZone);
    }

    cdk.Tags.of(this).add('environment', props.envName);
    cdk.Tags.of(this).add('project', 'sprout');
  }

  private createTable(envName: EnvName): Table {
    return new Table(this, 'SproutTable', {
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

  private createLambda(table: Table, props: ApiStackProps): Function {
    const fn = new Function(this, 'ApiFunction', {
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      handler: 'index.handler',
      code: Code.fromAsset(path.join(__dirname, '../../dist-lambda/api')),
      environment: {
        TABLE_NAME: table.tableName,
        DEPLOY_ENV: props.envName,
        AUTH0_DOMAIN: props.auth0Domain,
        AUTH0_AUDIENCE: props.auth0Audience,
      },
      timeout: cdk.Duration.seconds(30),
    });
    table.grantReadWriteData(fn);
    return fn;
  }

  private createApi(fn: Function, props: ApiStackProps): HttpApi {
    // Electron's main process makes requests directly via fetch (no CORS),
    // and the packaged renderer loads from file:// (also no CORS). The
    // browser-CORS surface is only the Vite dev server in dev mode.
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
    // Unauthenticated share-code routes — anyone holding the code can open the
    // project; edit-grants additionally allow publish on behalf of the owner.
    api.addRoutes({
      path: '/share/{token}',
      methods: [HttpMethod.GET],
      integration,
    });
    api.addRoutes({
      path: '/share/{code}/open',
      methods: [HttpMethod.GET],
      integration,
    });
    api.addRoutes({
      path: '/share/{code}/publish',
      methods: [HttpMethod.POST],
      integration,
    });
    api.addRoutes({
      path: '/healthz',
      methods: [HttpMethod.GET],
      integration,
    });

    new cdk.CfnOutput(this, 'ApiEndpoint', { value: api.apiEndpoint });
    return api;
  }

  private attachCustomDomain(api: HttpApi, envName: EnvName, hostedZone: string): void {
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

    new cdk.CfnOutput(this, 'ApiCustomDomainUrl', {
      value: `https://${apiDomain}`,
    });
  }
}
