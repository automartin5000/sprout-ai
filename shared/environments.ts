export type EnvName = 'dev' | 'prod' | 'ephemeral';

export interface Environment {
  name: EnvName;
  awsAccountId?: string;
  region: string;
  hostedZone?: string;
  auth0Domain: string;
  auth0Audience: string;
}

const DEFAULT_REGION = 'us-east-1';

export function resolveEnvironment(envName: string): Environment {
  const name = (envName as EnvName) ?? 'dev';

  const auth0Domain = process.env.AUTH0_DOMAIN ?? '';
  const hostedZone = name === 'prod'
    ? process.env.PROD_HOSTED_ZONE
    : process.env.NONPROD_HOSTED_ZONE;

  return {
    name,
    awsAccountId: name === 'prod'
      ? process.env.PROD_AWS_ACCOUNT_ID
      : process.env.NONPROD_AWS_ACCOUNT_ID,
    region: process.env.AWS_REGION ?? DEFAULT_REGION,
    hostedZone,
    auth0Domain,
    auth0Audience: process.env.AUTH0_AUDIENCE ?? buildAuth0Audience(name, hostedZone),
  };
}

export function buildAuth0Audience(envName: EnvName, hostedZone?: string): string {
  if (!hostedZone) return 'https://api.sprout.local';
  const prefix = envName === 'prod' ? '' : `${envName}.`;
  return `https://api.${prefix}sprout.${hostedZone}`;
}
