# Packaging Sprout

How to build, codesign, and notarize the Mac `.dmg` for distribution.

This is the publishing-side companion to [USER_GUIDE.md](./USER_GUIDE.md). If you just want to run Sprout in development, see [CONTRIBUTING.md](./CONTRIBUTING.md) — `pj app:dev` is enough.

---

## What gets packaged

Sprout ships as a self-contained Mac application bundle (`.app` → `.dmg`). The bundle includes:

| Layer | Contents | Source |
|---|---|---|
| Electron main + preload | Compiled JS (esbuild) | `app/main`, `app/preload` → `dist-electron/` |
| Renderer | Vite production build | `app/renderer` → `dist-renderer/` |
| Bundled binaries | Node, git, AWS CLI v2, Podman (per-arch) | `app/resources/bin/{arm64\|x64}/` |
| Bundled plugins | `sprout` (starters/skills), `sprout-cicd-github` | `app/resources/plugins/` |
| Entitlements | Hardened-runtime entitlements | `build/entitlements.mac.plist` |

Two DMGs are produced per release — `arm64` (Apple Silicon) and `x64` (Intel) — because AWS CLI v2 isn't a universal binary. Universal-binary builds are possible (electron-builder supports them) but produce a ~600MB DMG; per-arch is half the size.

---

## One-time prerequisites

### Machine setup

- macOS 14 or later (codesigning + notarization require Apple's modern toolchain)
- Xcode Command Line Tools: `xcode-select --install`
- Bun 1.0+: `curl -fsSL https://bun.sh/install | bash`
- Node 22+ (only used as the projen runtime; the *bundled* Node inside the DMG is downloaded by the build script)
- ~10 GB free disk space (bundled binaries × 2 archs + electron-builder caches)

### Apple Developer account (only if you're distributing externally)

For internal builds you can skip codesigning entirely — `.dmg` files install fine; users right-click → Open the first time to bypass Gatekeeper. The trade is: every user has to do that, and the bundled executables can't pass hardened-runtime checks on stricter MDM-managed Macs.

For external distribution you need:

1. An Apple Developer Program membership ($99/yr).
2. A **Developer ID Application** certificate installed in your login keychain. Create via Xcode → Settings → Accounts → Manage Certificates → "+".
3. An **app-specific password** for `notarytool`. Create at appleid.apple.com → Security → App-Specific Passwords.

Set these as env vars at build time:

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # NOT your iCloud password
export APPLE_TEAM_ID="ABC123DEF4"                           # 10 chars, from developer.apple.com
export CSC_NAME="Developer ID Application: Your Name (ABC123DEF4)"
```

Add these to your shell profile or a `.env` file that you `source` before running the build. **Never commit them.**

---

## Build steps

### 1. Stage extra resources

```bash
pj app:stage-resources
```

This runs:

- `scripts/download-binaries.ts` — fetches Node, git, AWS CLI v2, and Podman per-arch into `app/resources/bin/{arm64,x64}/`. ~600 MB download, cached locally.
- `scripts/stage-sprout-plugin.ts` — copies `plugins/sprout/` into `app/resources/plugins/sprout/` so it's bundled.

Idempotent. Re-running skips already-downloaded archives.

### 2. Build the renderer + main process

```bash
pj app:build
```

This produces:

- `dist-renderer/` — Vite output (HTML + hashed JS/CSS).
- `dist-electron/main/index.js` — esbuild-bundled Electron main process.
- `dist-electron/preload/index.cjs` — esbuild-bundled preload bridge.

### 3. Package the DMGs

```bash
pj app:package
```

Wraps `electron-builder --mac --config electron-builder.yml`. Output lands in `release/`:

```
release/
├── sprout-0.1.0-arm64.dmg
├── sprout-0.1.0.dmg              ← the x64 build, ugly naming but it's what electron-builder produces
├── sprout-0.1.0-arm64-mac.zip    ← auto-update artifact (ignore if you're not running auto-update)
├── sprout-0.1.0-mac.zip
├── builder-debug.yml
└── builder-effective-config.yaml
```

**First-time gotchas** (each of these has bitten me — saving you the search):

- *"Cannot find module '@anthropic-ai/claude-agent-sdk'"* during electron-builder's "rebuild" step → run `bun install` once before packaging. electron-builder reads `package.json` for what to bundle but expects `node_modules/` to actually be populated.
- *"Code signing required"* but no certificate found → set `CSC_NAME` exactly as it appears in Keychain Access (`security find-identity -p codesigning -v` lists yours). The string includes parentheses and team ID.
- *Empty `app/resources/bin/x64/`* → you skipped step 1. Run `pj app:stage-resources` first.

### 4. Codesign + notarize (if distributing)

`electron-builder` handles codesigning automatically when `CSC_NAME` is set. Notarization is **off by default** in `electron-builder.yml`:

```yaml
mac:
  notarize: false  # enable per-release via env once team ID is configured
```

To enable for a release:

```bash
NOTARIZE=true pj app:package
```

(You need to extend `electron-builder.yml` to read `process.env.NOTARIZE` — that's not wired yet; for now flip the `false` to `true` manually before a release build and revert after.)

Notarization can take 5–30 min. Apple's servers stamp the DMG after they've scanned it. The build logs print a `RequestUUID`; you can poll with:

```bash
xcrun notarytool history --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD"
```

Once stapled, Gatekeeper accepts the DMG on any Mac without the right-click bypass.

---

## What to test before shipping a release

Run on a clean Mac (or at least a fresh user account) — *your* dev machine has every dependency installed and won't catch missing-binary regressions.

1. **Install** — open the DMG, drag to Applications. Eject.
2. **First launch** — right-click → Open → Open (Gatekeeper prompt). Confirm Welcome screen renders.
3. **Onboarding** — sign in (or guest), pick projects folder, create a project from the `sprout:new-app` starter.
4. **Chat** — send a simple prompt ("make the background blue"). Confirm action cards animate and the preview reloads.
5. **Bundled tools** — open Activity Monitor, find Sprout's helper renderer, confirm the spawned `node`/`git`/`aws` are coming from `/Applications/Sprout.app/Contents/Resources/bin/`, not the user's PATH. (If the system Node is being used, the path-shim broke — check `app/main/path-shim.ts` ran before any other import.)
6. **Share preview to sandbox** — should round-trip to the deployed sandbox stack. If you don't have a deployed sandbox stack, see [docs/runbooks/auth0-e2e.md](./runbooks/auth0-e2e.md).
7. **Promote to prod** — only if you have `gh` installed and an AWS account; the modal should walk through preflight → scaffolding → done.
8. **Quit + relaunch** — the project list shows your project; opening it restores the chat history and brings the preview back live.

Items 5 and 7 are the most likely to regress between releases. Item 5 specifically catches the entire class of "build worked but the bundled binary failed to sign" bugs.

---

## Distribution

For internal use:

- Upload `release/sprout-<version>-arm64.dmg` and `sprout-<version>.dmg` (x64) to whatever you use for internal distribution (S3 bucket, GitHub release, internal artifact server).
- Provide a one-line install: `Download → drag to Applications → right-click first launch`.

For external use (notarized):

- Same uploads, but mention Gatekeeper accepts the apps without the right-click step.
- Set up auto-update later if you care (electron-builder produces the `.zip` + `latest-mac.yml` for it; not currently wired in Sprout's main process).

---

## Auto-update (not wired yet)

`electron-builder` produces the artifacts auto-update needs (`*-mac.zip`, `latest-mac.yml`) but the main process doesn't currently call `autoUpdater`. When the time comes:

1. Host the `release/` contents at a stable URL.
2. In `app/main/index.ts`, after `app.whenReady()`, call `autoUpdater.setFeedURL(...)` + `autoUpdater.checkForUpdates()`.
3. Re-sign + re-notarize every release; auto-update validates signatures.

Not in scope for the first user-testing rounds.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Error: spawn /Applications/Sprout.app/.../bin/node ENOENT` | Stage step skipped, or wrong arch DMG installed on the machine | Re-run `pj app:stage-resources`; double-check user installed the matching arch DMG (`uname -m` → `arm64` or `x86_64`) |
| `Bundle format is ambiguous (could be app or a versioned framework)` during signing | Stale `release/` contents | `rm -rf release/` and re-run `pj app:package` |
| Notarization fails with "Hardened Runtime is not enabled" | A bundled executable inside `bin/` lost its hardened-runtime flag | electron-builder usually re-signs everything; if you've manually replaced a binary, run `codesign --force --options runtime --sign "$CSC_NAME" path/to/binary` |
| `notarytool` says "Invalid app password" | App-specific password, not your iCloud password | Generate at appleid.apple.com → Security → App-Specific Passwords |
| User on a brand-new Mac sees `"sprout" can't be opened because Apple cannot check it for malicious software` | DMG isn't notarized OR notarization stapling didn't run | Either notarize (see step 4) or instruct the user to right-click → Open the first time |
| Build succeeds but DMG is 1.5 GB | Both arches packaged into one DMG by mistake | Confirm `electron-builder.yml`'s `mac.target.arch` lists arm64 + x64 as separate targets, not a single universal entry |
