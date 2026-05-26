# AGENTS.md

**The contract between Sprout and the AI agent that scaffolds + edits the user's code.**

This file is the source of truth for anyone debugging "why did the AI do that" or extending Sprout with a new starter, a new tool, or a new harness backend. It exists at the repo root because Anthropic's `@anthropic-ai/claude-agent-sdk` and similar conventions look for `AGENTS.md` as a project-level AI-context file.

Three sections:

1. **The hard contract** — what Sprout promises the AI, and what the AI must do in return.
2. **How it's implemented** — system prompt, harness adapter pattern, skills/plugins.
3. **How to extend** — adding a new starter, a new tool, or a new harness backend.

---

## 1. The hard contract

### What Sprout gives the AI on every turn

| Provided by Sprout | Where |
|---|---|
| Working directory = the user's project root | `workingDirectory` on `createSession()` |
| `CLAUDE_PLUGIN_ROOT` env var pointing at the active plugin's root | Process env when invoked from a skill |
| `SPROUT_PLUGIN_ROOT` env var (alias for the above) | Same |
| A system prompt describing the audience (non-technical user) and tool-call hygiene | `systemPrompt` on `startSession()` |
| Access to the loaded plugin's skills + agents as context | Skills are concatenated into the system prompt as additional context |
| The same five `SPROUT_*` env vars in BOTH sandbox + standalone-prod runtime modes | Runtime Lambda's env block |

### What the AI must do

1. **Never ask the user a technical question.** Pick reasonable defaults. The user is told *what was picked*, not asked *what they want*.
2. **Use plain English in every visible tool description.** The user sees every tool call live in a timeline. Avoid the words `git`, `shell`, `bash`, `scaffold`, `vite`, `tsx`, `compile`, etc. The system prompt has an enumerated list of bad vs good descriptions.
3. **Work inside `cwd` only.** No `ls` / `find` / `grep` against `/`, `/tmp`, `$HOME`. Project-scoped only.
4. **Use `npm` for everything.** Not Bun, not pnpm, not yarn. The user has a sandboxed environment; Bun is bundled into Sprout but project subprocesses see only npm + node.
5. **Always leave the workspace buildable.** Run `npm run build` before declaring done.
6. **DDB key prefix is `PROJECT#${SPROUT_PROJECT_ID}#`.** Tenancy in the shared sandbox depends on it; the same code runs in standalone prod without changes because both modes set the same env var.
7. **Reference only UI affordances that exist.** "Chat box", "preview pane", "Publish to cloud", "Share". Not "Refresh", "Run", "Reload", "Restart" — those don't exist in Sprout's UI.

### What Sprout doesn't expect (deliberately)

- The AI doesn't deploy anything. Sprout's Publish button does that.
- The AI doesn't manage git itself. Sprout commits a checkpoint after every successful turn.
- The AI doesn't restart the dev server. Sprout watches for file changes and restarts as needed.
- The AI doesn't have AWS credentials. The user doesn't have AWS credentials either, in sandbox mode.

---

## 2. How it's implemented

### The harness adapter interface

Sprout's main process speaks to AI SDKs through a thin adapter layer at `app/main/harness/`:

```ts
interface HarnessAdapter {
  readonly id: 'copilot' | 'claude' | 'mock';
  startSession(opts: SessionOpts): Promise<HarnessSession>;
}
interface HarnessSession {
  send(message: string): AsyncIterable<HarnessEvent>;
  approvePermission(id, decision): void;
  interrupt(): void;
  dispose(): Promise<void>;
}
```

Every event the renderer sees is normalized to one shape — `HarnessEvent`. See [docs/ARCHITECTURE.md § AI harness pattern](./docs/ARCHITECTURE.md#ai-harness-pattern) for the full type.

Adapters live in:

| File | Wraps | Pick condition |
|---|---|---|
| `app/main/harness/claude-adapter.ts` | `@anthropic-ai/claude-agent-sdk` | `~/.claude` exists OR `ANTHROPIC_API_KEY` set |
| `app/main/harness/copilot-adapter.ts` | `@github/copilot-sdk` (which itself wraps the `copilot` CLI binary via JSON-RPC) | `copilot` binary on PATH |
| `app/main/harness/mock-adapter.ts` | Canned responses | Always available as a fallback |

The adapters normalize:

- **Tool-call event names** — Claude emits `Edit`, `Bash`, `Read`; Copilot emits `str_replace_editor`, `bash`, `read_file`. Both end up as the same friendly action card in the chat. Mapping lives in `app/renderer/chat/ChatPane.tsx`'s `inferActionCard()`.
- **Streaming vs final-message** — Claude streams `text` deltas; Copilot may emit deltas OR drop a complete `assistant.message` at turn end. The Copilot adapter tracks `streamedThisTurn` and emits the *suffix* of the final message as a synthetic delta when streaming never fired.
- **Noise tools** — Copilot's `report_intent` and `report_progress` are filtered out at the adapter level; they're internal-only and would just clutter the user's timeline.

### The system prompt

The full prompt lives at `app/main/services.ts:SPROUT_SYSTEM_PROMPT` (around line 27). Reading it directly is the right way to understand current behavior; here's an annotated summary:

```
You are Sprout's coding agent, helping a non-technical user build a web app.

Hard rules:
- NEVER ask the user technical questions.          ← drives the "make a choice and proceed" behavior
- The user is NOT a developer.                     ← drives plain-English translation
- The user has NO AWS account, NO CLI...           ← stops the AI from launching AWS onboarding flows
- Apps run on Sprout's shared runtime Lambda.      ← teaches the SPROUT_* env-var contract
- Use `npm` for installs and scripts.              ← rules out bun/pnpm/yarn in user code
- When a turn is done, leave the workspace in a buildable state.

Tool-call hygiene — the user SEES every tool call you make in a timeline.
Every `description` field must read like a plain-English status line, not a developer log:
- ❌ "Check git history details"  ✅ "Look at recent save points"
- ❌ "Scaffold Vite React TS template"  ✅ "Set up the starter files"
...
Avoid these words: "git", "shell", "bash", "scaffold", "template", "CLI", "binary", "compile",
"transpile", "tsx", "vite", "pnpm", "bun", "PATH", framework/tool names.

Filesystem rules:
- All work happens inside the user's project directory. Do NOT ls/find/grep outside.

Plugin assets:
- ${CLAUDE_PLUGIN_ROOT} is ALREADY set in your environment.
- Starter template at ${CLAUDE_PLUGIN_ROOT}/templates/hono-react.
- Don't search for it.

How to talk to the user:
- Be brief. Three lines max unless they ask for detail.
- Name choices ("I'll use a simple JSON file"), don't justify them.
- Say what changed and what they can do next.

What the Sprout UI actually offers:
- Chat box, preview pane, Publish to cloud, Share. That's it.
- Do NOT reference Refresh / Run / Reload / Build / Deploy / Restart — those buttons don't exist.
```

The prompt is layered:

1. Sprout-side prompt (`SPROUT_SYSTEM_PROMPT`) — base contract.
2. Skill-provided context — every loaded skill's `SKILL.md` is concatenated when its frontmatter description matches the user's intent. The harness SDK does this matching; Sprout just hands it the loaded skills.
3. User turn — what the user typed in the chat box.

For Claude, the SDK takes our `systemPrompt` and uses it as-is. For Copilot, the SDK takes `systemMessage: { mode: 'append', content: ... }` — `append` matters because Copilot has its own internal system prompt; we don't want to replace it, we want to layer ours on top.

### Skills as AI context

A skill is a markdown file with YAML frontmatter:

```
---
name: new-app
description: Use when the user wants to start a new app/website/project — phrases like "make me a website that…", "build me an app for…"...
---

# Sprout — New App

You are creating a new app for a non-technical user. ...
```

The frontmatter's `description` is the matching key. The AI's harness sees "build me a habit tracker" and decides to activate `new-app`; the body becomes additional system-prompt context for that turn.

The bundled `sprout:new-app` skill at `plugins/sprout/skills/new-app/SKILL.md` is the canonical example. It:

- Tells the AI to scaffold from `${CLAUDE_PLUGIN_ROOT}/templates/hono-react/`.
- Explains the Hono + React + Vite layout.
- Documents the `SPROUT_*` env-var contract for any backend code the AI writes.
- Includes a worked example of correctly-prefixed DDB key reads/writes.

Adding a new skill = creating a new markdown file inside a plugin's `skills/` directory. The loader picks it up automatically on next Sprout launch.

### Agents (long-form prompts)

Agents are markdown files in a plugin's `agents/<name>.md`. Same frontmatter shape, but the AI invokes them as named subagents (e.g. Claude `Task(subagent_type='new-app')`, Copilot equivalent). Useful for multi-step workflows the AI hands off to.

Sprout doesn't currently ship any agents in the `sprout` plugin — the bundled starters all run as skills. The example layout at `plugins/sprout-cicd-jenkins-example/` shows how to declare them.

### Tools the AI can call

The Sprout main process doesn't add custom tools beyond what the harness SDKs ship. Specifically:

- **Claude Agent SDK** provides `Edit`, `Read`, `Bash`, `Glob`, `Grep`, `Write`, `Task` (subagent dispatch), and more. Sprout uses the SDK's defaults.
- **Copilot SDK** provides `str_replace_editor`, `bash`, `read_file`, `list_dir`, `create_file`, etc. Sprout filters out `report_intent` / `report_progress` (noise).

If you want a Sprout-specific tool (e.g. "snapshot the current preview"), the right place to add it is in the adapter's `ToolDef[]` passed to the SDK's session-create call. The renderer-side rendering code in `ChatPane.tsx:inferActionCard()` would also need a case for the new tool name.

### Permission flow

The Claude SDK is the only harness that asks for permission before running a tool by default. Sprout's permission callback:

1. Receives a `permission_request` event with `{ tool, input }`.
2. Filters by the plugin's `settings.json.permissions.allow` list — if the requested command matches an allowed pattern (e.g. `npm run *`), auto-approve.
3. Otherwise, surfaces a modal in the renderer asking the user.

Copilot doesn't expose a permission callback. Its `onPermissionRequest` is set to `sdk.approveAll` (helper from the SDK), trusting the AI to not run destructive things. If you need stricter behavior, you'd need to intercept at the CLI-level (out of scope for the SDK adapter).

---

## 3. How to extend

### Add a new starter skill

A starter is just a skill whose description triggers on phrases like "build me an X". To add one:

1. Create `plugins/sprout/skills/<your-starter-name>/SKILL.md`.
2. Frontmatter `name` matches the directory name; `description` should describe the user phrases that should trigger it.
3. Body: instructions for the AI. Reference `${CLAUDE_PLUGIN_ROOT}/templates/<your-template-dir>/` for files to copy.
4. Add the template files under `plugins/sprout/templates/<your-template-dir>/`.

Restart `pj app:dev` and the loader picks it up.

### Add a new tool (custom Sprout action)

1. Add an entry to the `ToolDef[]` in `app/main/harness/copilot-adapter.ts` and/or `claude-adapter.ts`, depending on which harness you want to support.
2. The `handler` runs in the main process — has full Node access. Be careful what you let the AI invoke.
3. Add a case in `app/renderer/chat/ChatPane.tsx:inferActionCard()` and `toolLabel()` so the tool call shows up as a friendly action card in the timeline.

### Add a new harness backend

Implement `HarnessAdapter` and `HarnessSession` against your SDK of choice. Reference `copilot-adapter.ts` for the most complete example — it shows the stream → event normalization, the streamed-vs-final-message handling, the noise-tool filter, and the systemPrompt-as-append pattern.

Register the adapter in `app/main/harness/registry.ts`:

1. Add a probe function (does the SDK / API key / CLI exist?).
2. Add to the `defaultAdapterId()` precedence order.
3. Add the case to the renderer's AI-picker dropdown in `app/renderer/App.tsx:friendlyAi()`.

The user-facing label is the friendly name. The internal `id` is what gets persisted per-project.

### Change the system prompt

It's a string constant in `app/main/services.ts`. Edit it.

Two cautions:

1. **The prompt is load-bearing for tool-call hygiene.** The bad-vs-good description examples shape what the AI actually writes in tool descriptions. Removing or weakening them produces "Scaffold Vite React TS template" instead of "Set up the starter files".
2. **The npm-only rule prevents subtle bugs.** Even though Sprout bundles Bun, the project subprocesses spawn with a path-shimmed `PATH` that doesn't expose Bun to the user's app. If the AI runs `bun install`, the project breaks. The prompt explicitly enumerates `bun`, `pnpm`, `yarn`, `bunx` as forbidden.

### Add a new env var the AI's code can read

There are five today: `SPROUT_MODE`, `SPROUT_PROJECT_ID`, `SPROUT_DATA_TABLE`, `SPROUT_ASSETS_BUCKET`, `SPROUT_UPLOADS_BUCKET`. Both runtime modes (sandbox + standalone) must set the new var with the right value. To add a sixth:

1. **Sandbox**: `runtime/handler.ts` sets it per-request from the Lambda env block. `infra/lib/sprout-stack.ts` adds the source value to the Lambda's env config.
2. **Standalone**: `plugins/sprout-cicd-github/templates/infra/lib/sprout-app-stack.ts` adds the var to `serverFn`'s `environment` block. If the value differs per project, use a `{{mustache}}` placeholder and wire it through `ProdDeployClient.deployToProd()`'s `variables` map.
3. **Skill documentation**: update `plugins/sprout/skills/new-app/SKILL.md`'s env-var table. This is the AI's source of truth — the system prompt points the AI here for the canonical list.
4. **Tests**: extend `tests/runtime-handler.test.ts` and `tests/deploy/template-copy.test.ts` to cover the new var.

If you forget step 2, the user's promote-to-prod-ed code reads `undefined` from `process.env.SPROUT_NEW_THING` and breaks at runtime. The AI won't catch it because the convention is "same names in both modes" — it has no reason to defend against missing config.

---

## See also

- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — process model, runtime planes, deploy flows
- [docs/CUSTOM_INSTALL.md](./docs/CUSTOM_INSTALL.md) — the CI/CD plugin contract in full detail
- [plugins/sprout/skills/new-app/SKILL.md](./plugins/sprout/skills/new-app/SKILL.md) — the canonical starter skill, worth reading once to internalize the patterns
- [app/main/harness/types.ts](./app/main/harness/types.ts) — the typed contract every adapter implements
