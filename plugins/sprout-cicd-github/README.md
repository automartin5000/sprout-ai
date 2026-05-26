# sprout-cicd-github

A Sprout CI/CD-provider plugin. Adds "Publish to prod" support for personal /
public-GitHub users:

- Scaffolds projen + AWS CDK into the user's project
- Creates a private GitHub repo (via `gh repo create`)
- Wires GitHub Actions workflows for build, PR-env deploy, PR-env cleanup,
  and prod deploy on PR merge
- Opens a PR for the user to review the CI/CD addition

## How Sprout uses this plugin

Sprout's main process discovers this plugin via the standard plugin loader
(`app/main/plugins/loader.ts`). The `cicd:` block in `.claude-plugin/plugin.json`
flags it as a deploy provider, and Sprout's `ProdDeployClient` (`app/main/deploy/prod-client.ts`)
drives the flow:

1. Copies `templates/` into the user's project (with `{{projectName}}` substituted)
2. Runs `scripts/bootstrap-prod.sh` in the project root
3. Initializes git, commits, calls `gh repo create`, opens a PR

The `skills/prod-help/` skill is purely AI-facing — it teaches Claude/Copilot
how to help users diagnose workflow failures and add AWS resources.

## Required user setup (one-time)

When the user accepts the PR, they still need to:

1. Create an IAM role `github-actions-deployer` in their AWS account, with
   OIDC trust for `token.actions.githubusercontent.com` and their repo.
2. Add GitHub secrets:
   - `NONPROD_AWS_ACCOUNT_ID` — AWS account id for dev / PR envs
   - `PROD_AWS_ACCOUNT_ID` — AWS account id for prod
3. Run `npx cdk bootstrap aws://<account>/us-east-1` once per AWS account.

The deploy modal links to a setup guide that walks through this. Future Sprout
phases may automate steps 1 + 3 via STS + the user's signed-in AWS identity.

## Local development of this plugin

The plugin is bundled with Sprout via the existing `bundledDir` discovery root.
Edit files in place; `pj build` doesn't restage the plugin (it's the source of
truth, no copy step). The `template-snapshot` CI guard ensures hand-edited
workflow YAMLs don't drift from the projen-generated form.
