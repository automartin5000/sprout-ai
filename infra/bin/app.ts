import { App } from 'aws-cdk-lib';
import { SproutStack } from '../lib/sprout-stack.js';
import { resolveEnvironment } from '../../shared/environments.js';

const app = new App();
const env = resolveEnvironment(process.env.DEPLOY_ENV ?? 'dev');

const awsEnv = {
  account: env.awsAccountId,
  region: env.region,
};

new SproutStack(app, `Sprout-${env.name}`, {
  env: awsEnv,
  envName: env.name,
  hostedZone: env.hostedZone,
  auth0Domain: env.auth0Domain,
  auth0Audience: env.auth0Audience,
});

app.synth();
