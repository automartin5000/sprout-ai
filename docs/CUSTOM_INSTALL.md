# Custom-install guide

How to run Sprout in an environment where the **default deploy stack doesn't fit**: your AWS region/account model is different, you can't use GitHub Actions, you have an in-house CDK or projen library, your security team blocks public S3 buckets, etc.

Sprout is designed for this. The default `Share preview to sandbox` and `Promote to prod` paths are just two implementations of a **plugin contract**. Drop a different plugin onto the user's machine and the buttons mean different things — without changing Sprout itself.

This guide covers:

- Where Sprout looks for plugins
- The CI/CD plugin contract (you author one of these per deploy target)
- The sandbox runtime contract (if you also want to run an internal multi-tenant runtime instead of the public one)
- Picking which provider is active when multiple are installed
- Worked example: swapping in an internal Jenkins + corp CDK setup

If you only need to change a *single* visible thing (e.g. the AWS region, the Auth0 tenant), see [CONTRIBUTING.md](./CONTRIBUTING.md) — those are env vars on the standard build, not new plugins.

---

## Where Sprout looks for plugins

Three roots, scanned in order. Later roots override earlier ones by plugin name.

| Order | Path | Purpose |
|---|---|---|
| 1 | `<Sprout.app>/Contents/Resources/plugins/` | Plugins bundled into the `.dmg` (defaults — `sprout`, `sprout-cicd-github`) |
| 2 | `~/Library/Application Support/Electron/plugins/` | User-installed plugins |
| 3 | `<projectRoot>/.sprout/plugins/` | Per-project overrides (rare; mostly for dev) |

To add a plugin to a user's machine:

```bash
mkdir -p ~/Library/Application\ Support/Electron/plugins/
cp -R /path/to/my-plugin ~/Library/Application\ Support/Electron/plugins/
```

Restart Sprout. The plugin loader scans on launch.

A plugin is any directory containing `.claude-plugin/plugin.json`. The `plugin.json` declares what kind of plugin it is — a starter (provides skills), a CI/CD provider, or both.

---

## The CI/CD plugin contract

This is the one you'll author most often. It owns what happens when the user clicks **Promote to prod**: which templates get copied into the user's project, which bootstrap script runs, and how Sprout creates the remote git repository + opens a PR.

### Minimum layout

```
my-cicd-plugin/
├── .claude-plugin/plugin.json   # name + cicd manifest
├── settings.json                 # bash allowlist (optional, for plugin-specific tools)
├── scripts/
│   └── bootstrap.sh              # runs in user's project after templates copy
└── templates/                    # copied verbatim into user's project
    ├── infra/                    # CDK app for their deployed product
    │   ├── bin/app.ts
    │   └── lib/sprout-app-stack.ts
    ├── pipeline-config           # whatever your CI needs: Jenkinsfile, .github/workflows/, etc.
    ├── .projenrc.ts              # if you use projen — corp or open-source
    ├── cdk.json
    └── package.json.patch        # JSON-patch shape: additive deps + scripts only
```

### `plugin.json` shape

```json
{
  "name": "sprout-cicd-myprovider",
  "description": "Sprout deploy provider — <one-line>",
  "version": "0.1.0",
  "cicd": {
    "label": "My Provider (corp)",
    "templatesDir": "templates",
    "bootstrapScript": "scripts/bootstrap.sh",
    "remoteKind": "github" | "jenkins"
  }
}
```

`remoteKind` is the only switch Sprout's main process branches on:

- `"github"` — Sprout calls `gh repo create <name> --private --source=. --remote=origin --push` and `gh pr create` for the PR.
- `"jenkins"` — Sprout does **not** call `gh`. Your bootstrap script is expected to configure `origin` against your git server; Sprout will then `git push -u origin sprout/cicd` and skip the PR-creation step. The user opens the PR in your git server's UI.

If neither value fits your setup (Gerrit, GitLab CE, internal homegrown), you'll need to widen the type union in `app/main/plugins/types.ts` and add a branch in `app/main/deploy/prod-client.ts`. Both edits are small. PRs welcome.

### `bootstrap.sh` responsibilities

Runs in the user's project root (cwd already set) after `templates/` has been copied + `package.json.patch` applied. Exit non-zero to surface the error in Sprout's progress modal.

Typical work:

1. `bun install` (or `npm install` if your stack isn't on Bun).
2. Whatever code-generation your stack needs — `bun projen` for a projen-based template, `npx synth` for raw CDK, nothing for plain GitHub Actions.
3. Optionally configure the git remote: `git remote add origin <your-git-url>` (required for `remoteKind: "jenkins"`).
4. Print a friendly "next steps" block. Sprout displays this in the done modal.

### Templates: variable substitution

Sprout uses a tiny mustache pass — `{{varname}}` placeholders in template files are replaced before the files land in the user's project. Two variables are always available:

| Variable | Value |
|---|---|
| `{{projectName}}` | Sprout's friendly project name, slugified (e.g. `pick-a-game`) |
| `{{projectId}}` | The 8-char Crockford project ID. **Use this for any backend resource that needs to match the sandbox runtime's data**, since AI-generated code keys DDB rows on `PROJECT#<projectId>#…`. |

These are passed via `ProdDeployClient`. If you need additional variables, extend `ProdDeployOptions` in `app/main/deploy/prod-client.ts` and thread them through `template-copy.ts`.

### Env-var contract (load-bearing)

Your `templates/infra/lib/sprout-app-stack.ts` must set these five Lambda environment variables. AI-generated code reads them directly; if any name is wrong or missing, the user's app silently breaks on first request.

```ts
serverFn.addEnvironment('SPROUT_MODE', 'prod');
serverFn.addEnvironment('SPROUT_PROJECT_ID', '{{projectId}}');
serverFn.addEnvironment('SPROUT_DATA_TABLE', table.tableName);
serverFn.addEnvironment('SPROUT_ASSETS_BUCKET', assetsBucket.bucketName);
serverFn.addEnvironment('SPROUT_UPLOADS_BUCKET', uploadsBucket.bucketName);
```

The sandbox runtime sets exactly the same five vars per-request, so AI-generated code is portable between the two. See [the SKILL.md env-var table](../plugins/sprout/skills/new-app/SKILL.md) for the canonical reference.

### Tests

Wherever practical, write a test against the bundled `sprout-cicd-github` plugin's shape — `tests/deploy/template-copy.test.ts` covers `{{projectName}}` substitution against a fixture project. Mirror that shape for your own provider's tests.

---

## Picking the active provider

If only one CI/CD plugin is installed (the bundled `sprout-cicd-github` removed, your plugin added), Sprout uses it automatically. No config needed.

If multiple are installed (e.g. you keep `sprout-cicd-github` for personal apps and add your corp plugin for work apps), the user's first "Promote to prod" click opens a picker; the choice is persisted to `~/.sprout/config.json`:

```json
{ "activeCicdProvider": "sprout-cicd-myprovider" }
```

For pre-provisioned installs (corp setup scripts), drop that file in place ahead of first launch and the picker is skipped.

For dev/test overrides, set `SPROUT_CICD_PROVIDER=<pluginName>` as an environment variable before launching Sprout.

Resolution order:

1. `SPROUT_CICD_PROVIDER` env var → wins absolutely
2. `~/.sprout/config.json` `activeCicdProvider` → wins over auto-pick
3. Exactly one provider installed → auto-pick
4. Multiple providers, no config → picker UI
5. Zero providers → **Promote to prod** button is disabled with tooltip "No deploy plugin installed"

---

## Worked example: internal Jenkins setup

Suppose you work somewhere with:

- Internal Jenkins server at `jenkins.internal.example`
- A house projen library `@internal/projen-stack` that knows how to emit Jenkinsfiles
- A house CDK library `@internal/cdk-constructs` that wraps every `Function`, `Bucket`, `Table` with VPC/SG/encryption/tagging policies your security team requires
- Git server at `git.internal.example` (no GitHub)

Sprout doesn't need to know about any of this. You author one plugin:

```
sprout-cicd-internal/
├── .claude-plugin/plugin.json
├── scripts/bootstrap.sh
└── templates/
    ├── Jenkinsfile
    ├── .projenrc.ts            # extends @internal/projen-stack
    ├── infra/lib/sprout-app-stack.ts  # uses @internal/cdk-constructs
    └── package.json.patch
```

**`plugin.json`:**

```json
{
  "name": "sprout-cicd-internal",
  "description": "Sprout deploy — corp Jenkins + internal CDK/projen libraries",
  "version": "0.1.0",
  "cicd": {
    "label": "Corp deploy",
    "templatesDir": "templates",
    "bootstrapScript": "scripts/bootstrap.sh",
    "remoteKind": "jenkins"
  }
}
```

**`scripts/bootstrap.sh`:**

```bash
#!/usr/bin/env bash
set -euo pipefail

echo ">>> Installing internal projen + CDK libraries"
bun add -d @internal/projen-stack
bun add @internal/cdk-constructs

echo ">>> Regenerating Jenkinsfile via projen"
bun projen

echo ">>> Configuring git remote"
git remote add origin "git@git.internal.example:teams/{{projectName}}.git" || true

cat <<'NEXT'

  Done. Your project's been scaffolded for a Jenkins pipeline.

  Next steps (manual, sorry — these aren't yet automatable):
    1. Open Jenkins → Folders → Sprout-apps → New Item → your project name (uses Multibranch Pipeline scaffold).
    2. Open Vault and add credentials at secret/sprout/{{projectName}}/* — see your team's secret runbook.
    3. Open a merge request from sprout/cicd; first deploy runs after merge.

NEXT
```

**`templates/.projenrc.ts`** uses your house library:

```ts
import { InternalCdkApp } from '@internal/projen-stack';

const project = new InternalCdkApp({
  name: '{{projectName}}',
  cdkVersion: '2.190.0',
  // ...
});

project.synth();
```

**`templates/infra/lib/sprout-app-stack.ts`** declares Lambda + S3 + DDB using your wrappers, **and sets the five SPROUT_* env vars** (this part is non-negotiable — the user's app code depends on those names):

```ts
import { InternalLambda, InternalBucket, InternalTable } from '@internal/cdk-constructs';

export class SproutAppStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const table = new InternalTable(this, 'AppTable', { /* corp wrapper */ });
    const assetsBucket = new InternalBucket(this, 'AssetsBucket', { /* corp wrapper */ });
    const uploadsBucket = new InternalBucket(this, 'UploadsBucket', { /* corp wrapper */ });

    const serverFn = new InternalLambda(this, 'ServerFn', {
      runtime: Runtime.NODEJS_22_X,
      // VPC / subnets / SGs added automatically by @internal/cdk-constructs
      environment: {
        SPROUT_MODE: 'prod',
        SPROUT_PROJECT_ID: '{{projectId}}',
        SPROUT_DATA_TABLE: table.tableName,
        SPROUT_ASSETS_BUCKET: assetsBucket.bucketName,
        SPROUT_UPLOADS_BUCKET: uploadsBucket.bucketName,
      },
    });

    table.grantReadWriteData(serverFn);
    assetsBucket.grantReadWrite(serverFn);
    uploadsBucket.grantReadWrite(serverFn);
  }
}
```

**`templates/package.json.patch`** adds the deps + scripts the user's project needs but doesn't ship by default:

```json
{
  "scripts": {
    "deploy": "cdk deploy --all"
  },
  "devDependencies": {
    "@internal/projen-stack": "^1.0.0",
    "@internal/cdk-constructs": "^1.0.0",
    "projen": "^0.95.0"
  }
}
```

Sprout's `template-copy.ts` applies this as a JSON-patch (RFC 6902-ish: it's actually a merge, additive only — it can't *remove* keys from the user's existing package.json).

**Install on a user's machine:**

```bash
# Drop the plugin in
mkdir -p ~/Library/Application\ Support/Electron/plugins/
cp -R ./sprout-cicd-internal ~/Library/Application\ Support/Electron/plugins/

# Optional: remove the bundled github plugin so the corp one is auto-picked
rm -rf /Applications/Sprout.app/Contents/Resources/plugins/sprout-cicd-github

# OR keep both and write the config
mkdir -p ~/.sprout
echo '{ "activeCicdProvider": "sprout-cicd-internal" }' > ~/.sprout/config.json
```

Launch Sprout. **Promote to prod** now drives your internal pipeline.

A skeleton you can fork lives in [`plugins/sprout-cicd-jenkins-example/`](../plugins/sprout-cicd-jenkins-example/) — reference layout only, not auto-loaded.

---

## Sandbox-runtime customization (advanced)

If you also can't use the default public sandbox runtime (i.e. you can't reach `apps.example.com` from your network, or you want all sandbox data inside your AWS account), you need to deploy your own copy of `SproutStack` and point Sprout at it.

This is a bigger lift than the CI/CD plugin — there's no plugin contract for it yet. The minimum:

1. Deploy `infra/lib/sprout-stack.ts` to your AWS account (`DEPLOY_ENV=corp pj deploy`).
2. Configure the corp Auth0 tenant (or whichever IdP your security team allows). See [docs/runbooks/auth0-e2e.md](./runbooks/auth0-e2e.md) for the tenant-setup steps; substitute your tenant's URL + API audience.
3. Build a custom `.dmg` with your stack's `apps.<env>` URL hardcoded. The two values to change:
   - `shared/environments.ts` — add a new `corp` env keyed off `DEPLOY_ENV`
   - `app/main/auth/auth0-native.ts` — the Auth0 tenant URL + audience defaults

That's the route if your security team accepts CloudFront + Lambda + DDB + S3 inside your account. If they don't accept Lambda at all (some banks), Sprout's architecture isn't the right fit — you'd be rewriting the runtime.

For most teams the CI/CD plugin alone is enough. The sandbox runtime exists for fast iteration ("show this to a teammate"); the real artifact every team wants is the Promote-to-prod result.

---

## What this guide deliberately doesn't cover

- **Air-gapped installs** — Sprout currently assumes outbound HTTPS for Auth0 login, the AI model (Anthropic or Copilot), and npm registries during scaffold. Air-gapped is possible but requires a corp npm mirror + an internal model proxy; non-trivial.
- **Custom Auth0 replacements (Okta, Ping, etc.)** — the JWT authorizer in `infra/lib/sprout-stack.ts` accepts any OIDC issuer. Swap the issuer URL + audience in the stack's `HttpJwtAuthorizer`. The desktop's PKCE flow assumes Auth0's loopback-redirect URL shape (`http://127.0.0.1/callback`); other IdPs may need a different callback path.
- **Per-user encryption keys** — Sprout stores refresh tokens in macOS `safeStorage` (which is keyed to the user's login keychain). If your security team requires hardware-keyed encryption, that's a per-user setup outside Sprout.

If any of these are blocking you, file an issue — the answer is usually "yes, but it's three days of work and a maintainer needs to scope it with you."
