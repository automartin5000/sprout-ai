# User Guide

Day-one walkthrough of Sprout. Written for someone who's never opened the app.

---

## Install

### Pre-built .dmg

1. Download the appropriate .dmg for your Mac:
   - `sprout-<version>-arm64.dmg` for Apple Silicon (M1/M2/M3/M4)
   - `sprout-<version>-x64.dmg` for Intel Macs
2. Open the .dmg, drag **Sprout** to Applications.
3. First launch will be quarantined by Gatekeeper. Right-click → Open → Open. (Future launches don't prompt.)

If you're building from source instead, see [PACKAGING.md](./PACKAGING.md).

### What gets installed

Sprout bundles its own Node, git, AWS CLI, and Podman binaries. You don't need any of them pre-installed on your machine. The app installs to `/Applications/Sprout.app`. User state lives in:

- `~/Library/Application Support/Electron/state.json` — onboarding state, current project pointer
- `~/Library/Application Support/Electron/plugins/` — user-installed plugins (drop a `sprout-cicd-*` directory here to add a CI/CD provider)
- `~/sprout-projects/` — your project files (you can change this in onboarding)
- `~/.sprout/config.json` — optional config; mostly used to pick a CI/CD provider when more than one is installed

---

## First-run flow

### 1. Welcome

You'll see a welcome screen with two buttons:

- **Sign in** — opens your browser for Auth0 device-flow login. Use this if you want to "Share preview to sandbox" (which needs identity).
- **Use as guest** — skip login. Everything works locally, but Share preview and Promote to prod are disabled until you sign in.

### 2. Projects folder

Pick the directory Sprout will keep your project worktrees in. The default (`~/sprout-projects`) is fine. Each project lives in its own subfolder with its own git repo.

### 3. Project list

Empty on first run. Click **+ New project** to create one, or paste a **project code** from a teammate to join their project (the code arrives via the Share button — see below).

### 4. New project

- **Name** — display name. Becomes a slug for the folder.
- **AI** — Copilot or Claude. Sprout auto-picks based on what's installed; you can override per-project later.
- **Starter** — which scaffolding template the AI uses for the first turn. The default is `sprout:new-app` (a Vite + React + Hono server template).

Click Create. The chat opens immediately; nothing is built yet.

---

## The main UI

After a project is open, the window is laid out as:

```
┌─────────────────────────────────────────────────────────────┐
│  ⌃⌥⌘  ← Back to projects    Sprout — myapp ●    AI Share   │  ← topbar
├─────────────────────────────────────────────────────────────┤
│                            │  Desktop  Phone  myapp · live │
│   Chat                     ├───────────────────────────────┤
│   (left)                   │                               │
│                            │   Preview                     │
│                            │   (right)                     │
│                            │                               │
│   ...                      │                               │
│                            ├───────────────────────────────┤
│   [Describe what to build] │  History · save-points strip  │
└─────────────────────────────────────────────────────────────┘
```

### Top bar

| Element | What it does |
|---|---|
| Traffic lights | Standard macOS window controls (close / minimize / zoom) — real, not emulated |
| **← Back to projects** | Closes the current project's dev server and shows the project list. Shortcut: ⌘[ |
| **Sprout — <project> ●** | Centered titlebar. The green dot lights up when the preview is live. |
| **AI: <dropdown>** | Switch between Claude and Copilot per-project. Choice persists. |
| **Share preview to sandbox** | (Blue button) Deploys the current build to `https://apps.example.com/<projectId>/` for a teammate to open. |
| **Promote to prod** | (Terracotta button) Forks the project to a real GitHub repo with a CI/CD pipeline. Opens a PR. |
| **Invite** | Mints a project code teammates can paste in their Sprout to join. |
| Avatar | You. |

### Chat (left pane)

- **Composer** (bottom) — type a request, ⌘↵ to send (↵ also works). ⇧↵ for newline. The icon buttons (paperclip / image / mic) are reserved for future use.
- **Messages** — your turns are right-aligned terracotta bubbles. Sprout's turns are flat cream cards.
- **Action cards** — under each Sprout turn, the agent's tool calls render as a checklist (file edits, shell commands). Click steps to see context.
- **Save-point cards** — at the end of a successful turn, a card links to a git checkpoint. Click the card to roll back (more on this below).

### Preview (right pane)

The preview is a real `WebContentsView` overlaid on the right pane. It loads `http://localhost:<port>` where `<port>` is whatever the project's dev server picked.

- **Desktop / Phone tabs** — Phone constrains the preview to 390px wide with a subtle phone-frame border. Useful for previewing mobile layouts. Same dev server, smaller viewport.
- **Status pill** — `<project> · live · auto-saved`. Pulses while the dev server is starting.
- **History** — placeholder for a future "browse all save points" modal. Live save-point access is via the bottom strip.

### Save points (bottom strip)

Every chat turn ends with a git commit. The strip shows the most recent save points newest-on-the-right. Each card has:

- A procedural mini-snapshot (richer for newer saves)
- The first line of the user's prompt
- A relative timestamp

**Clicking a save point rolls back the project to that state non-destructively.** Sprout:

1. Snapshots whatever's currently in the working tree (so unsaved edits aren't lost)
2. Replaces the working tree with the target's content
3. Commits the rollback as a new save point labeled "rolled back to: …"

Every prior save point stays reachable from the timeline. `git log` from HEAD continues to show the full history.

---

## Sharing your work

### Share preview to sandbox

The fast path. Click the blue **Share preview to sandbox** button. A modal shows:

- *Building your app* (~2 sec) — `npm run build` locally
- *Packaging files* (~1 sec) — tar the static dir + zip the server bundle
- *Uploading* (~1–3 sec) — presigned PUTs to S3
- *Going live* (~1 sec) — DDB version bump + cache invalidation

When done, you get a URL like `https://apps.example.com/ABCDEFGH/`. Copy it and send to a teammate. Every Share preview from this project re-publishes to the same URL — the version pointer just moves.

**Your teammate** can paste that URL or use the **Invite** button's code (see below) to open the project in their own Sprout — they get write access via the share token, can publish updates against the same URL.

### Invite (project code)

Click **Invite** in the top bar. Sprout mints an 8-character code (Crockford base32). Send the code to a teammate. They paste it in their Sprout's "Have a code?" field on the project list screen, and the project clones to their machine. They can edit + share-preview just like you.

### Promote to prod

The big path. Click the terracotta **Promote to prod** button. Sprout:

1. **Preflight** — checks `gh` is installed (GitHub path) and you have no existing `.github/workflows/` directory.
2. **Scaffolding** — copies the CI/CD plugin's templates into your project (`.github/workflows/*`, `infra/`, `cdk.json`, `.projenrc.ts`).
3. **Bootstrapping** — runs `npm install` for the projen + CDK deps, then `bun projen` to materialize the workflow YAMLs.
4. **Committing** — initializes git if needed, commits on a `sprout/cicd` branch.
5. **Creating-repo** — `gh repo create <name> --private --source=. --remote=origin --push`.
6. **Pushing** — pushes `main` (so the new repo has a default branch), then `sprout/cicd`.
7. **Opening a PR** — `gh pr create` with a body explaining what changed.
8. **Done** — modal shows the PR URL + a reminder that the first deploy takes 10–15 min for CloudFront to propagate.

After merging the PR, every future commit to `main` triggers a real deploy to your AWS account. Every open PR gets an ephemeral preview environment.

**Important caveats:**
- You need a working `gh` CLI (`brew install gh && gh auth login`).
- You need an AWS account with a one-time OIDC IAM role + a hosted zone for the app's domain. See the PR body for the full one-time setup checklist.
- **Sandbox data does NOT migrate.** A new prod environment starts with empty DDB and empty S3. Your existing sandbox URL keeps working independently.

---

## Switching AIs

The **AI** dropdown in the top bar swaps the harness for the current project. Options depend on what's installed on your machine:

- **Copilot** — visible if `@github/copilot-sdk` is installed (which Sprout's `bun install` brings in) AND the `copilot` CLI binary is on PATH (install via `brew install --cask copilot-cli` or from cli.github.com).
- **Claude** — visible if `~/.claude` exists (Claude Code installed) OR `ANTHROPIC_API_KEY` is set in your environment.
- **Demo** — always available; uses canned responses for UI exploration.

The choice persists per-project. If a project was created with an AI that's no longer available, Sprout silently migrates it to the registry's default on next open.

---

## Tips

- **Speak to it like a person.** "Make the background a sunset" is fine. You don't need to know what `App.tsx` is.
- **Save points are cheap.** Take risks — if the AI breaks something, click an older save point. Your work isn't lost (the rollback itself becomes a new save point).
- **Refresh the preview by clicking it.** Vite hot-reloads automatically, but a manual click is the universal "did this take?"
- **Phone-mode is real.** The dev server is the same; just the WebContentsView gets narrowed. Layout media queries fire correctly.
- **Crash recovery is automatic.** If Sprout crashes mid-turn, reopening the project restores the last save point. You won't lose more than the in-flight turn.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Preview pane stays empty after agent says "Done" | Agent didn't actually scaffold, OR dev server failed to start | Send another message — the post-turn dev-server retry fires again. If still empty after a second turn, click **← Back to projects** then re-open the project (forces a fresh `startDevServer`). |
| AI dropdown only shows "Demo" | No harness credentials | Set `ANTHROPIC_API_KEY` (Claude) OR install `copilot` CLI (Copilot). Both can coexist. |
| "Share preview to sandbox" disabled | You're in guest mode | Click your avatar → Sign in via Auth0. |
| "Promote to prod" disabled with "no deploy plugin" | Sprout doesn't know how to deploy on this machine | Drop a `sprout-cicd-<provider>` directory into `~/Library/Application Support/Electron/plugins/`. Restart Sprout. |
| Save point click destroys recent work | (Should never happen — Sprout snapshots before rolling back) | If you see this, file a bug with the project's `.git/logs/HEAD` attached. |
| App fails to start, hardened-runtime error | Bundled binaries lost their codesign | Re-download the .dmg. |
