# RUNBOOK — "Publish to prod" via Jenkins (work install)

This runbook is for the work-machine engineer implementing the Jenkins flavour
of Sprout's prod-deploy path. Sprout's main process itself doesn't know about
Jenkins — all the Jenkins-specific behavior lives in a plugin called
`sprout-cicd-jenkins` that the corp setup installs into the user's
`~/Library/Application Support/Electron/plugins/` directory.

The Sprout side already implements:

- Plugin discovery for any directory matching the `LoadedPlugin` shape
- The `cicd:` manifest contract (`app/main/plugins/types.ts`)
- The `ProdDeployClient` orchestrator that drives copy → bootstrap → git → push → PR
- The deploy modal UI

Your job is to package the work-specific templates + bootstrap as a plugin
that satisfies the contract.

## Contract

Your plugin must contain (at minimum):

```
sprout-cicd-jenkins/
├── .claude-plugin/plugin.json     # cicd manifest, see below
├── settings.json                   # bash allowlist
├── scripts/
│   └── bootstrap-prod.sh           # runs in user's project after templates copy
└── templates/                      # copied verbatim into the user's project
    ├── Jenkinsfile                 # corp Jenkins pipeline definition
    ├── .projenrc.ts                # uses corp-internal projen + cdk libraries
    ├── projen-config/              # any helper modules for projen
    ├── infra/                      # CDK app for the user's deployed product
    │   ├── bin/app.ts
    │   └── lib/sprout-app-stack.ts
    ├── cdk.json
    └── package.json.patch          # additive deps + scripts (JSON-patch shape)
```

### plugin.json

```json
{
  "name": "sprout-cicd-jenkins",
  "description": "Sprout deploy provider — work install. Jenkins pipeline + corp projen/cdk libs.",
  "version": "0.1.0",
  "cicd": {
    "label": "Jenkins (work)",
    "templatesDir": "templates",
    "bootstrapScript": "scripts/bootstrap-prod.sh",
    "remoteKind": "jenkins"
  }
}
```

The `remoteKind: 'jenkins'` value changes Sprout's behavior in two specific
ways (see `app/main/deploy/prod-client.ts:deployToProd`):

1. **Creating the remote**: Sprout does NOT call `gh repo create`. Your
   bootstrap script must set up `origin` for the corp git server (likely
   `git@gitlab.corp.example.com:teams/<projectName>.git` or similar). Sprout
   will then `git push -u origin sprout/cicd`.
2. **Opening a PR**: Sprout skips `gh pr create`. The user opens the PR via
   the corp git server UI.

### bootstrap-prod.sh

Runs in the user's project root with cwd already set. Responsibilities:

1. Install the corp-internal projen + cdk libraries (`@corp/projen`,
   `@corp/cdk-lib`, etc.)
2. Run `bun projen` / `npm run projen` once to regenerate workflow files
3. Configure the corp git remote: `git remote add origin <corp-url>`
4. Print a "next steps" block telling the user what they still need to do
   manually (Jenkins job credentials, Vault secrets, etc.)

Failures should write to stderr and exit non-zero so Sprout's deploy modal
shows the right error.

## Install on a work machine

1. `mkdir -p ~/Library/Application\ Support/Electron/plugins/`
2. `cp -r path/to/sprout-cicd-jenkins/ ~/Library/Application\ Support/Electron/plugins/`
3. Write `~/.sprout/config.json`:
   ```json
   { "activeCicdProvider": "sprout-cicd-jenkins" }
   ```
   (Step 3 is only needed if `sprout-cicd-github` is ALSO present and Sprout
   can't auto-pick. On a work install you might delete the bundled GitHub
   plugin from the staged dir entirely; that's also acceptable — Sprout's
   resolver returns `'active'` whenever there's exactly one provider.)

## Smoke test (work machine)

1. Launch Sprout. Create a fresh project from `sprout:new-app`.
2. In chat, ask the AI to build something small. Wait for the preview.
3. Top bar should show **Publish to prod** with the title "Push to your own
   Git repo and deploy to AWS via CI/CD" (no `gh`-related warnings).
4. Click. Modal walks through preflight → scaffolding → bootstrapping →
   committing → creating-repo (no-op for Jenkins) → pushing → opening-pr
   (no-op for Jenkins) → done.
5. Modal lands on "Review the PR" with a placeholder message ("your team
   review tool handles this"). The user opens the corp git server UI to
   review.

## What if the contract is wrong?

Sprout-side tests cover the plumbing assuming `remoteKind: 'github' | 'jenkins'`
are the only two values. If you need a third (e.g. Gerrit), file an issue —
the type union in `app/main/plugins/types.ts` needs widening AND the orchestrator
needs a new branch.

If `ProdDeployClient`'s phase sequence doesn't fit Jenkins (e.g. you need an
extra "registering job" step), the events type in `app/main/ipc.ts:ProdDeployProgressEvent`
needs the new variant — and the modal in `app/renderer/deploy/DeployProdModal.tsx`
needs the new `PhaseRow`.

Both changes are small and don't require Sprout-side template files. PR
welcome.
