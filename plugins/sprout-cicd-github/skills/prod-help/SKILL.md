---
name: prod-help
description: Helping the user understand and debug their Sprout app's GitHub Actions + CDK production deploy pipeline. Use this when the user asks why a workflow failed, what a workflow does, what AWS resources their app has, or how to add a new resource.
---

# Sprout production deploy — GitHub Actions + AWS CDK

This project was set up by Sprout to deploy to AWS production via GitHub Actions
and AWS CDK. Here's the shape:

## What runs when

- **Every push to a non-`main` branch** → `.github/workflows/build.yml`. Runs
  `bun install && bun run build && bun projen synth`, uploads the `cdk.out/`
  directory as an artifact named `cdk-out-<sha>`.
- **Every open or updated PR** → `.github/workflows/deploy-pr-environment.yml`.
  Deploys an ephemeral stack `<projectName>-pr<number>` to the dev AWS account.
  Posts the URL as a PR comment.
- **PR closed (merged or not)** → `.github/workflows/cleanup-pr-environment.yml`.
  Tears down the ephemeral stack.
- **PR merged to `main`** → `.github/workflows/prod-deploy.yml`. Finds the
  successful build artifact for the merge commit, downloads it, assumes the
  AWS prod role via OIDC, runs `cdk deploy` against the prod stack.

## AWS resources defined by `infra/lib/sprout-app-stack.ts`

- **S3 bucket** for static assets (served by CloudFront)
- **CloudFront distribution** with OAC to S3
- **DynamoDB table** (PAY_PER_REQUEST, single-table design)
- **Lambda function** for the server (Hono via `hono/aws-lambda`)
- **API Gateway HTTP API** in front of the Lambda

Per-env differences: prod gets `RemovalPolicy.RETAIN` + point-in-time recovery
on DynamoDB. Dev/PR envs get `DESTROY` so teardowns are clean.

## When a workflow is red

Most failures fall into three buckets:

1. **AWS credentials** — usually means the GitHub OIDC IAM role
   `github-actions-deployer` doesn't exist yet or its trust policy doesn't
   include this repo. See the project's `README.md` for the one-time AWS setup
   steps.
2. **Missing secrets** — `NONPROD_AWS_ACCOUNT_ID` or `PROD_AWS_ACCOUNT_ID`
   not set in repo settings.
3. **CDK bootstrap missing** — first deploy to a fresh AWS account/region
   needs a one-time `npx cdk bootstrap aws://<account>/us-east-1`.

Surface the bucket the failure falls into and tell the user the exact command
or setting to change. Don't make them open the AWS console blind.

## Adding a new AWS resource

Edit `infra/lib/sprout-app-stack.ts`. Don't add CDK code anywhere else in the
project — keeping all infra in one stack file makes diffs reviewable and
teardowns predictable.

Example (adding an SQS queue):

```ts
// inside SproutAppStack constructor
const eventsQueue = new sqs.Queue(this, 'EventsQueue', {
  visibilityTimeout: cdk.Duration.seconds(30),
});
// grant the server Lambda permission to send messages
eventsQueue.grantSendMessages(this.serverFn);
this.serverFn.addEnvironment('EVENTS_QUEUE_URL', eventsQueue.queueUrl);
```

After edits, run `bun projen synth` to validate locally. The PR pipeline will
deploy the change to the ephemeral env where the user can test it before merge.
