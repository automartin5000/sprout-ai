# sprout-cicd-jenkins-example

A reference layout for the Jenkins-flavoured Sprout deploy provider. Not loaded
at runtime — the `.claude-plugin/plugin.json` deliberately omits the `cicd:`
block so it doesn't show up as a candidate provider.

**This directory exists purely as documentation**, paired with
[`docs/runbooks/cicd-jenkins.md`](../../docs/runbooks/cicd-jenkins.md).

To turn this into a real Jenkins provider:

1. Copy this directory to a new location outside the Sprout repo (or fork
   Sprout and create `sprout-cicd-jenkins/` as a sibling).
2. Rename `name` in `plugin.json` to `sprout-cicd-jenkins` and add the `cicd:`
   block per the contract.
3. Fill in `templates/Jenkinsfile`, `templates/.projenrc.ts` (using corp
   projen libs), and `templates/infra/`.
4. Implement `scripts/bootstrap-prod.sh` — install corp deps, configure the
   corp git remote, print next-steps.
5. Drop the directory into `~/Library/Application Support/Electron/plugins/`.

Sprout's `app/main/deploy/prod-client.ts` does NOT need any changes — the
`remoteKind: 'jenkins'` field in your manifest tells it to skip `gh repo
create` and `gh pr create`, leaving the corp-git wiring to your bootstrap
script.

## What's NOT in this example

The actual Jenkinsfile + corp projen + cdk libraries are intentionally absent
because they're company-specific. The work-machine engineer pairs this
reference with the corp deploy patterns they already have.
