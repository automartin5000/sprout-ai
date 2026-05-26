# Test Coverage Audit — Phase 4 close-out

Run after the Phase 4 work + e2e shakedown. The e2e found **two real bugs**
(both since fixed) that the unit tests had missed; this audit documents what's
covered, what isn't, and the deliberate trade-offs.

## Coverage at a glance

| Layer | Files | Tests | New in audit |
|---|---|---|---|
| Shared contracts | `smoke.test.ts` | 3 | — |
| Plain-English regression | `no-jargon.test.ts` | 1 | — |
| Bundle smoke | `main-bundle-loads.test.ts` | 2 | — |
| Scaffold + dev server + DDB round trip | `scaffold-e2e.test.ts` | 8 | — |
| Owner publish (V3) | `share-publish.test.ts` | 4 | **+4** |
| Share-code publish (V3) | `share-publish.test.ts` | 5 | — |
| CI/CD plugin contract | `cicd-plugin.test.ts` | 11 | — |
| Template copy + JSON patch | `template-copy.test.ts` | 5 | — |
| Prod deploy orchestrator | `prod-deploy.test.ts` | 3 | **+1** (Jenkins) |
| Edge router | `edge-router.test.ts` | 12 | **+12** (new file) |
| Harness registry conditional | `harness-registry.test.ts` | 4 | **+4** (new file) |
| **Total** | **11 files** | **68** | **+21** |

`pj build` green, all 68 tests pass.

## Bugs the e2e caught (now fixed + regression-tested)

### Bug 1 — `gh repo create --push` only pushes the current branch
The orchestrator created the repo while on `sprout/cicd`, so the remote got
just that branch. `gh pr create` then failed with `createPullRequest: can't
be blank` (no `main` to PR against).

- **Fix**: `gh-cli.ts:ghRepoCreate` now drops `--push`. The orchestrator
  pushes `main` first, then `sprout/cicd`, then opens the PR with explicit
  `--base main --head sprout/cicd`.
- **Regression test**: `prod-deploy.test.ts` shim now wires a real bare repo
  as `origin` so `git push origin main` is exercised (not just mocked).

### Bug 2 — Edge router had no DDB read permission + `__SPROUT_TABLE_NAME__` was never substituted
Two compounding issues:

1. `sprout-stack.ts` created `EdgeFunction` but never called
   `this.table.grantReadData(edgeRouter)`.
2. `build-runtime.ts` bundled `runtime/edge-router.ts` but never substituted
   the `__SPROUT_TABLE_NAME__` placeholder marker.

Result: the deployed edge function got `ResourceNotFoundException` on every
DDB lookup, fail-opened (forward all traffic to runtime), and the runtime
Function URL's `AWS_IAM` auth returned 403. A missing project should have
returned a Sprout-branded 404 at the edge.

- **Fixes**:
  - `sprout-stack.ts`: added `this.table.grantReadData(this.edgeRouter)`
    right after edge creation.
  - `build-runtime.ts`: esbuild `define` inlines
    `process.env.SPROUT_EDGE_TABLE_NAME` with the actual
    `sprout-${DEPLOY_ENV}` table name at build time.
- **Regression test**: `edge-router.test.ts` has a new `built edge-router
  bundle` describe block that asserts the bundle doesn't contain the
  placeholder marker AND does contain a real `sprout-<env>` table name.

### Bug 3 — `APPS_BASE_URL` never wired into the API Lambda
`publishedUrl()` in `lambda/api/routes/publish.ts` reads `APPS_BASE_URL` to
construct per-project URLs, but the CDK stack never set it on the API
Lambda's env. Without a custom hosted zone, every publish response would
return `https://apps.sprout.local/<id>/` — unreachable.

- **Fix**: `sprout-stack.ts` calls `apiLambda.addEnvironment('APPS_BASE_URL',
  ...)` after the distribution is created, pointing at the CloudFront default
  domain (or the custom apex if `hostedZone` is configured).
- **Regression**: no unit test yet — flagged in "Gaps still open" below.

## What IS well-covered

- **Share-code publish contract (V3)**: 5 tests pinning the response shape
  via `PublishStartV3ResponseSchema.parse()`. Catches the original Phase-3
  bug that this audit started with.
- **Owner publish + complete contract**: 4 new tests covering happy path +
  404 + 403 cases.
- **Edge router routing logic**: 12 tests covering header-stripping, Crockford
  validation, static-asset rewrites, prefix stripping, DDB fail-open, and
  caching.
- **Plugin loader + provider resolution**: 11 tests, including the actual
  bundled `sprout-cicd-github` plugin's discovery on disk.
- **Prod deploy orchestrator**: end-to-end test with a real `gh` shim AND a
  bare git remote, plus the Jenkins variant assertion that gh isn't called.
- **Harness conditional registration**: 4 tests guarding against the original
  "Copilot SDK not available" regression and the auto-fallback path.
- **Template substitution + JSON-patch**: 5 tests covering binary passthrough,
  unknown-var preservation, and additive merge of scripts + devDependencies.

## Gaps still open (P1 — not blocking)

These are noted for future phases, not flagged as immediate blockers:

1. **`APPS_BASE_URL` wiring in the CDK stack** — Bug 3 above. Would catch
   regressions by snapshotting the synthesized API Lambda env block. Best
   done as a CDK assertion test (`Template.fromStack(...).hasResourceProperties(...)`).
2. **Runtime Lambda handler** (`runtime/handler.ts`) — caches by version,
   loads bundles from S3, falls back to placeholder. No tests. The
   `scaffold-e2e.test.ts` dynalite round trip exercises only the user-code
   path, not the runtime's project-loading path.
3. **`PublishClient` desktop orchestration** — `app/main/publish/client.ts`'s
   build → tar → upload → complete flow. Indirectly exercised in the e2e
   scripts but not unit-tested.
4. **OnboardingStateStore** — same shape as `SproutConfigStore` which IS
   tested. Trivially low-risk gap; mirror the existing test.
5. **`ApiClient` auth headers** — `app/main/cloud/api-client.ts` token-provider
   wiring. No test. The `anonymous: true` branch is exercised by share-publish.
6. **`buildDeployStatus` in services.ts** — composes provider resolution +
   `gh` availability into a renderer payload. Logic is simple but uncovered.
7. **Renderer `App.tsx` top-bar conditionals** — "Publish to prod" visibility
   + disabled-reason tooltip. UI-side; would need RTL or playwright.
8. **CDK `Template` snapshot tests** — useful for catching IAM grant
   regressions like Bug 2 *without* needing a real deploy. Worth a dedicated
   Phase 5 task.

## What we explicitly chose NOT to cover

- **Auth0 JWT verification path** in the deployed authed endpoints. Mocked
  via `MOCK_AUTH=1` in tests; real verification is owned by API Gateway's
  `HttpJwtAuthorizer` and isn't our code to test.
- **`@github/copilot-sdk` integration**. The SDK is fictional + not bundled;
  the conditional registration is the contract, and that IS covered.
- **CloudFront distribution behavior** (cache headers, OAC signing). Out of
  scope — AWS-managed.
- **The Jenkins variant's actual plugin** — the `sprout-cicd-jenkins-example/`
  is a layout reference, not a runtime artifact. The work-machine engineer
  owns its tests separately per `docs/runbooks/cicd-jenkins.md`.

## E2E scripts (manual run, not part of `pj test`)

These hit real AWS / GitHub and have side effects (creating + deleting
resources). Run manually after a deploy or before a release.

- `scripts/e2e-share-preview.ts` — exercises healthcheck + edge-router 404
  paths against `Sprout-dev`. Reads stack outputs from
  `sprout-dev-outputs.json` (written by `bunx cdk deploy --outputs-file`).
- `scripts/e2e-publish-to-prod.ts` — runs `ProdDeployClient` against a real
  GitHub account (uses ambient `gh auth`). Creates a real `sprout-e2e-<ts>`
  repo, verifies branches/PR/workflows, then best-effort deletes the repo
  (needs `gh auth refresh -h github.com -s delete_repo` once for cleanup
  to work).
