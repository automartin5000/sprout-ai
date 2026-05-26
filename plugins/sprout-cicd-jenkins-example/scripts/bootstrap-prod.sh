#!/usr/bin/env bash
#
# Placeholder bootstrap-prod.sh for the Jenkins variant. Replace with corp-
# specific behavior when packaging the actual sprout-cicd-jenkins plugin.
#
# Responsibilities (see RUNBOOK-CICD-JENKINS.md):
#
#   1. Install corp projen + cdk libs (e.g. @corp/projen-aws, @corp/cdk-lib).
#   2. Run `bun .projenrc.ts` (or corp equivalent) once.
#   3. Configure the corp git remote (e.g. `git remote add origin
#      git@gitlab.corp.example.com:teams/<projectName>.git`).
#   4. Print a next-steps block: Jenkins job credentials, Vault secrets,
#      and any other manual config the user still has to do.
#
# Failure modes: write to stderr, exit non-zero. Sprout's deploy modal
# surfaces the error verbatim.

set -euo pipefail

echo "This is a placeholder bootstrap. Replace with the corp implementation." >&2
exit 1
