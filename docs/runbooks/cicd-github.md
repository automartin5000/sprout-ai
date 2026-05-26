# RUNBOOK — "Publish to prod" via GitHub Actions

End-to-end manual smoke test for the GitHub-flavoured prod deploy path. Run
this on a personal machine after every change to the `sprout-cicd-github`
plugin or the `ProdDeployClient` orchestrator.

## Prerequisites (one-time per machine)

- `gh` CLI installed + `gh auth login` done (any GitHub account)
- An AWS account you control (personal sandbox is fine)
- AWS account region defaults to `us-east-1` for Sprout
- `npx cdk bootstrap aws://<account>/us-east-1` run once in that account
- An IAM role named **`github-actions-deployer`** in that account with OIDC
  trust for `token.actions.githubusercontent.com` and your future repo. Minimum
  policy = `AdministratorAccess` for the smoke test (tighten later).

## Smoke test

1. `pj app:dev` to launch Sprout.
2. Onboarding → create a fresh project, e.g. **"Demo App"**, with the
   `sprout:new-app` starter.
3. In chat, ask the AI to "build a habit tracker" or any small change. Wait
   for the preview to come up.
4. Top bar should show three buttons: **Share** (icon-only), **Share preview**,
   and **Publish to prod**. If the third is missing, check:
   - `app/resources/plugins/sprout-cicd-github/` exists (staged by `pj build`)
   - `gh auth status` returns 0 (you're logged in)
5. Click **Publish to prod**.
6. Modal walks through phases: preflight → scaffolding → bootstrapping →
   committing → creating-repo → pushing → opening-pr → done.
7. Modal lands on "Review the PR" with a link. Open it.

### Expected GitHub state

- A new **private** repo: `github.com/<user>/demo-app`
- An open PR titled "Set up cloud deploys (Sprout)" on branch `sprout/cicd`
- Workflows triggered on the PR branch:
  - **build** (✓ should pass)
  - **deploy-pr-environment** (✓ once you add secrets — see below)
  - **pull-request-lint** (✓ — title is `feat:` prefixed)

### Repo-side one-time setup (post-PR, before merge)

In repo Settings → Secrets and variables → Actions, add:

- `NONPROD_AWS_ACCOUNT_ID` — your AWS account id (12 digits)
- `PROD_AWS_ACCOUNT_ID` — same account is fine for the smoke test

After the secrets exist, re-run the **deploy-pr-environment** workflow on the
PR. Expected: a CloudFront URL is commented on the PR within ~5 minutes.

### Merge the PR

After merge to `main`, the **prod-deploy** workflow runs automatically:

- Finds the build artifact for the merge commit
- Assumes the OIDC role
- Runs `bun projen deploy "prod/*"`
- Returns a CloudFront URL via the workflow's "Done" step

First prod deploy takes 10–15 minutes for CloudFront to propagate. The Sprout
modal's final-state copy tells the user this.

## Teardown

1. `gh repo delete github.com/<user>/demo-app --yes`
2. Manually destroy the CloudFront + S3 + Lambda from your AWS console (or
   `cdk destroy --all` from the project root).
3. Delete the project from Sprout (sidebar context menu).

## Things to flag in PR review

- Bootstrap script must regenerate workflow YAMLs cleanly via `bun .projenrc.ts`.
  If `git diff` is non-empty after, the template-snapshot CI guard will fail.
- The `gh` shim used in tests captures `gh auth status` + `gh repo create` +
  `gh pr create` calls. Any new gh invocations need the shim updated.
- The "Publish to prod" button title shows the `prodDisabledReason` when set —
  test by uninstalling `gh` and re-launching.
