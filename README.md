# Sprout

**Build apps from ideas — a Mac desktop tool where you describe what you want and an AI agent scaffolds, edits, and ships it.**

Sprout is a self-hosted, Mac-native AI app builder. The UI is designed for non-engineers; the engine underneath is a swappable AI harness (Claude or GitHub Copilot) that owns the codebase via git checkpoints and runs a live preview as it goes.

Two deploy paths, picked per project:

- **Share preview to sandbox** — multi-tenant infra hosted by Sprout. Sub-10-second deploys to a shared URL. Good for "let me show this to a teammate."
- **Promote to prod** — fork the app to its own GitHub (or Jenkins) repo with a real CI/CD pipeline + dedicated AWS stack. The user owns it from there.

---

## Quickstart

```bash
# Prerequisites: macOS, Node 22+, bun (or npm)
git clone <repo-url> sprout
cd sprout
bun install
pj app:dev
```

That gets you a development build with the dev hot-reload Vite renderer. For a production .dmg to distribute, see [docs/PACKAGING.md](./docs/PACKAGING.md).

On first launch:

1. Sign in via Auth0 (or skip with "Use as guest" for fully-local mode)
2. Pick a folder to keep your projects in (default: `~/sprout-projects`)
3. Create your first project — pick a starter, then describe what to build

---

## Documentation

| Doc | What it covers |
|---|---|
| [docs/USER_GUIDE.md](./docs/USER_GUIDE.md) | Install, first-run, day-to-day use, every button in the UI |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | System architecture with diagrams. Process model, multi-tenant runtime, deploy paths |
| [AGENTS.md](./AGENTS.md) | AI agent contract — system prompt, harness adapters, skills/plugins, how to extend |
| [docs/PACKAGING.md](./docs/PACKAGING.md) | How to build the .dmg, sign + notarize, distribute |
| [docs/CUSTOM_INSTALL.md](./docs/CUSTOM_INSTALL.md) | Running Sprout with a non-default deploy stack — alternate sandbox infra, custom CI/CD plugins (Jenkins etc.), corporate CDK/projen libraries |
| [docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md) | Dev setup, build/test loop, project layout, where things live |
| [docs/USER_TESTING.md](./docs/USER_TESTING.md) | Script + observation guide for running Sprout sessions with real users |
| [docs/runbooks/](./docs/runbooks/) | Deep-dive runbooks for specific operations (Auth0, e2e, Jenkins) |

## Project status

Working today:
- Electron desktop shell with chat ↔ live-preview split layout
- Claude harness (via `@anthropic-ai/claude-agent-sdk`) and GitHub Copilot harness (via `@github/copilot-sdk`)
- Git-checkpoint timeline with non-destructive rollback
- "Share preview to sandbox" — deploys to `https://apps.<your-domain>/<projectId>/` on a shared AWS stack you've deployed (CloudFront + Lambda + DynamoDB). See [docs/CUSTOM_INSTALL.md](./docs/CUSTOM_INSTALL.md#sandbox-runtime-customization-advanced) for standing it up; out-of-the-box the desktop falls back to local-only mode if no sandbox is configured.
- "Promote to prod" — scaffolds the project into a GitHub repo with a CDK pipeline, opens a PR
- Two-button top bar; mac-native chrome
- Bundled binaries (Node, git, AWS CLI, Podman) so users need no install prerequisites

Known gaps / honest:
- No automated visual regression tests — UI changes are manually smoke-tested
- Code signing + notarization for the .dmg is set up but each new machine needs Apple Developer ID env vars
- The Jenkins CI/CD plugin is a contract Sprout supports but ships only an example shell — the work-machine engineer authors the real plugin (see `docs/runbooks/cicd-jenkins.md`)
- AWS account bootstrap for "Promote to prod" requires manual setup of OIDC IAM roles + GitHub secrets (one-time per AWS account)

---

## License

MIT — see [LICENSE](./LICENSE).
