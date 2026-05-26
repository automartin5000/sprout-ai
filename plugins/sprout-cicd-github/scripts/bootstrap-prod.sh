#!/usr/bin/env bash
#
# sprout-cicd-github — post-template-copy bootstrap.
#
# Runs in the user's project directory AFTER Sprout has copied templates/* in
# (overlaying onto the user's existing app files). Does three things:
#
#   1. Installs deps the new templates need (projen + cdk + types).
#   2. Runs `bun projen` (or `npx projen`) once to regenerate the workflow
#      YAMLs from .projenrc.ts. After this, hand-editing the YAMLs is a no-op
#      — `projen` overwrites them next build.
#   3. Prints a clear "next steps" block telling the user what manual setup is
#      still required (GitHub secrets, OIDC IAM role) — Sprout can't automate
#      these because they live in the user's AWS account.
#
# Sprout's main process invokes this with the project root as cwd. It captures
# stdout/stderr and surfaces failures to the user via the deploy modal.

set -euo pipefail

echo "▸ Installing CI/CD dependencies (projen, aws-cdk-lib, constructs, projen-config)..."

if command -v bun >/dev/null 2>&1; then
  PKG=bun
  bun install
elif command -v npm >/dev/null 2>&1; then
  PKG=npm
  npm install
else
  echo "✖ Neither bun nor npm is installed. Sprout needs one of them to bootstrap CI/CD." >&2
  exit 1
fi

echo "▸ Running projen to regenerate workflows..."
if [[ "$PKG" == "bun" ]]; then
  bun .projenrc.ts
else
  npx tsx .projenrc.ts
fi

cat <<'NEXT'

✓ CI/CD scaffold installed.

NEXT STEPS (one-time, in your AWS console + GitHub repo settings):

  1. Create an IAM role in your AWS account that GitHub Actions can assume via
     OIDC. Name it `github-actions-deployer`. Trust policy must allow
     `token.actions.githubusercontent.com` for your repo.

  2. Add these GitHub repository secrets (Settings → Secrets and variables →
     Actions):
       NONPROD_AWS_ACCOUNT_ID   — your AWS account id for dev/PR envs
       PROD_AWS_ACCOUNT_ID      — your AWS account id for prod

  3. Bootstrap CDK in your AWS account, region us-east-1, once:
       npx cdk bootstrap aws://<account-id>/us-east-1

After this, every merged PR to `main` will deploy automatically. Every open PR
gets an ephemeral preview environment.

A full setup guide will be linked from the Sprout deploy modal.
NEXT
