/**
 * Multi-environment CDK app for a Sprout-deployed user app.
 *
 *   dev/<projectName>   — auto-deployed by GitHub Actions on PR open
 *   prod/<projectName>  — deployed on PR merge to main
 *   pr<N>/<projectName> — ephemeral per-PR, torn down on PR close
 *
 * The `DEPLOY_ENV` env var (set by each workflow) picks which stacks to
 * synth — every CDK command runs with the right scope automatically.
 *
 * The CDK stack itself lives in `infra/lib/sprout-app-stack.ts`. Edit there
 * to add resources; this file just decides which env each stack belongs to.
 */
import * as cdk from 'aws-cdk-lib';
import { SproutAppStack } from '../lib/sprout-app-stack.js';

const app = new cdk.App();

const deployEnv = process.env.DEPLOY_ENV ?? 'dev';
const isProd = deployEnv === 'prod';
const isPr = deployEnv.startsWith('pr');

const accountId = isProd
  ? process.env.PROD_AWS_ACCOUNT_ID
  : process.env.NONPROD_AWS_ACCOUNT_ID;

new SproutAppStack(app, `${deployEnv}-app`, {
  envName: deployEnv,
  isProd,
  isPr,
  env: {
    account: accountId,
    region: process.env.AWS_REGION ?? 'us-east-1',
  },
});

cdk.Tags.of(app).add('sprout:env', deployEnv);
cdk.Tags.of(app).add('sprout:app', '{{projectName}}');
