# User-testing Sprout

A script + observation guide for running Sprout sessions with real users. Tuned for the audience the product is designed for: **non-engineers** who've never used an "AI app builder" before.

If you're a tester who hasn't built or installed Sprout before, read [USER_GUIDE.md](./USER_GUIDE.md) first — that's the page the user is effectively trying to discover.

---

## What you're testing

Three big questions, in order:

1. **Can a non-engineer get from install to a working app idea without help?** (Onboarding + first-prompt)
2. **Is the AI's behavior legible?** (Action cards, tool descriptions, save points, the preview)
3. **Does Share preview to sandbox actually feel like "I can send this to someone right now?"** (The publish flow)

You're *not* testing whether the AI can build any specific app — that's an LLM-quality question, not a Sprout question. Bias the session toward "did the UX get out of the way."

---

## Pre-session setup

### Tester laptop

- A Mac the user has never used Sprout on. (If you only have your own, sign out of Auth0 + wipe `~/Library/Application Support/Electron/state.json` first.)
- The latest signed `.dmg` (see [PACKAGING.md](./PACKAGING.md)).
- A working internet connection.
- At least one of: Claude Code installed (`~/.claude` exists), `ANTHROPIC_API_KEY` in env, or Copilot CLI installed. Otherwise the AI dropdown will only show "Demo" — fine for UX testing but the AI won't actually build anything.

### Recording

- Get screen + audio consent before starting.
- macOS built-in screen recorder is enough (⌘⇧5). For multi-window sessions, OBS catches both the app window and the system browser (used during Auth0 sign-in).

### What to have ready

- One real iPhone or another device — useful for the "open the share URL on your phone" moment if you reach it.
- A second Mac (or an Electron window in dev mode on the same Mac with `~/Library/Application Support/Electron/state.json` wiped) — for the "invite a teammate" test, if you reach it.
- A fresh GitHub account or a sandbox AWS account — only if you plan to test "Promote to prod" (most sessions skip this).

---

## Session script

Target length: **45–60 minutes**. If the user runs into a wall in the first 5 minutes, stop and debrief — there's no point continuing.

The script is in three acts. Read each prompt to the user as written; don't paraphrase the early ones, since the framing affects what gets observed. Pause after each act to ask the post-act questions.

### Act 1 — Install + first project (~15 min)

**You say:**

> "Sprout is a Mac app for building small web apps by talking to it. I'm going to give you a `.dmg` file and I want you to install it and use it to make whatever you want. I'll be quiet unless you ask me a direct question. If something is confusing, say so out loud — that's the most useful thing you can do for me."

Hand over the laptop. Watch.

**Things to observe (don't say any of this aloud):**

- Does the user double-click the `.dmg` and intuit "drag to Applications"? If not, where do they stall?
- The first launch will show Gatekeeper's "right-click → Open" prompt. Does the user discover this? (This is a known friction point we want to retire by notarizing.)
- The Welcome screen has **Sign in** and **Use as guest**. Which do they pick? Do they understand the difference?
- The projects-folder picker comes next. Do they accept the default (`~/sprout-projects`) or change it?
- They land on an empty project list. Do they click **+ New project**? Do they understand what the "Have a code?" field is for?
- In the new-project modal: do they read the AI / Starter dropdowns, or just click Create? (Either is fine — but flag if they think they have to pick something obscure.)
- They land in the chat. **What do they type first?**

**Common stalls in Act 1:**

- Gatekeeper bypass — many users have never right-clicked an app icon.
- "What's a Starter?" — the modal currently doesn't explain. Note their reaction.
- The first chat prompt — some users type one word ("hello"), some write a paragraph, some sit silent. All informative.

**Post-act questions** (after the first AI response lands and the preview appears):

- "What surprised you about the last 10 minutes?"
- "Did you understand what the AI was doing while it was working?"
- "What would you do next?"

### Act 2 — Iterate on the project (~20 min)

**You say:**

> "Make the app feel more like *yours*. Change the colors, add a feature you'd actually want, change a button's behavior — whatever. Talk to it like you'd talk to a colleague."

This is the longest act. The goal is to see how the user reacts when the AI:

- Streams text into the chat
- Shows action cards (Sprout's "Edit file", "Run command", "Make a save point")
- Hits an error and needs to retry
- Takes longer than expected (30s+)
- Produces something the user doesn't like

**Things to observe:**

- Do they read the action cards, or scroll past them? (Cards are the major affordance for "what's happening" — if no one reads them, we have a problem.)
- When the preview reloads, do they notice automatically, or do they tap/click around looking for "Refresh"?
- Do they discover save points (the strip at the bottom of the preview)? If so, do they understand "clicking one rolls back"?
- Do they hit Phone-mode? If so, does it make sense?
- Do they type a *technical* request ("change the database schema"), an *outcome* request ("make it remember my settings"), or something in between? The system prompt is tuned for outcome requests — note where the user's wording differs.

**If they get stuck:**

- 30 seconds of silence is fine. Beyond a minute, ask "What are you thinking?"
- If they ask "what should I try?", redirect: "what would *you* want to change about this app?" Don't lead them.
- If the AI produces broken code and the preview goes blank — observe. Do they reload, retry, click a save point, or give up? (We've tuned the retry behavior for this — if they have to do anything but wait, that's a regression to flag.)

**Post-act questions:**

- "Were there moments where you felt unsure what was happening?"
- "Were there moments where the app felt 'magical'?" (We want to know what worked — design follow-up depends on this.)
- "If you had to explain this app to a friend, what would you say?"

### Act 3 — Share with someone else (~10 min)

**You say:**

> "Pretend a friend or coworker is going to look at what you built. Get the app in front of them."

Things they might do:

- Click **Share preview to sandbox** — the intended path. Note whether they understand the URL is now public-ish.
- Click **Invite** — the project-code path. Useful if your friend wants to edit, not just look. The user has to physically *give* the code to someone — note how they react to the manual step.
- Hand the laptop over physically — a valid answer; nothing to do here.
- Click **Promote to prod** — only if curious; usually skip this in a UX session since it requires GitHub + AWS setup.

**Observe:**

- Did they understand "to sandbox" vs "to prod"? (We renamed the buttons explicitly to make this clearer; this is the validation moment.)
- Does the publish modal feel honest about how long it'll take?
- Once the URL is live: do they open it themselves? Take a screenshot? AirDrop it to their phone?

**Post-act questions:**

- "Would you actually share that URL with someone?"
- "Did the share flow feel like sending a link, or like 'deploying'?"
- "How would you delete or hide that URL later?" (We don't have a clean answer to this yet — note their model.)

---

## Debrief (~5–10 min)

A few open-ended questions, in this order:

1. "If you had to teach someone else to use this in two minutes, what would you say?"
2. "Was anything frustrating?"
3. "Was there anything you wanted to do but couldn't figure out how?"
4. "Did anything feel like it was written for engineers and not for you?" — the **jargon regression check**. If they hit any specific word, write it down verbatim.
5. "Would you use this again? For what?"

Then: thank them, send the recording link to yourself, and write up notes immediately while it's fresh.

---

## What to write up

For each session, capture three things:

### 1. Outcomes (binary)

- Did they finish onboarding? (Y/N)
- Did they get a working app preview within the first 15 min? (Y/N)
- Did they successfully publish a Share preview URL? (Y/N)
- Did they explicitly say something positive about the AI's responses? (Y/N)
- Did they explicitly say something negative about Sprout's UX? (Y/N)

### 2. Quotes

Verbatim. Especially: any jargon they didn't understand, any moment they were stuck, any moment they said "oh, cool" out loud.

### 3. Friction points, ranked

The top three places the session slowed down. Format:

```
1. [Where in the app] — [what happened] — [what they did to recover, or why they gave up]
```

Don't fix anything during the writeup. Just record.

---

## Known things you'll see, and what they mean

Pre-flagging so testers don't waste time reporting these as bugs:

| Observation | Status |
|---|---|
| User sees Gatekeeper "can't verify developer" prompt | Known. Fixed once we notarize. Workaround: right-click → Open. |
| User typed a long prompt and got a short response | LLM behavior, not a Sprout bug. Note it but don't repro-debug. |
| Preview takes 10+ seconds to update | Mostly the dev server's restart cycle. The retry backoff is `[2.5s, 3.5s, 5s, 8s, 12s]` — if they're seeing >15s, file. |
| "Share preview to sandbox" is disabled | They're in guest mode; the button greys out with a tooltip "Sign in to share." |
| "Promote to prod" is disabled | Likely no CI/CD plugin available, or `gh` isn't installed. Verify before the session. |
| User clicked a save point and lost their newer changes | This used to be a bug; the current behavior is non-destructive (newer changes become a "rolled back to:" save point). If you see actual data loss, file with `.git/logs/HEAD` attached. |

---

## A few session-running tips

- **Stay quiet.** Even if they're struggling. Five seconds of silence feels longer to you than to them.
- **Don't defend the product.** If they say "this is weird," your answer is "tell me more," not "well, it's because…"
- **Don't lead.** "Did you notice the save points?" is a leading question. "What did you do in the last minute?" isn't.
- **Test on the user's own intent.** If they don't want to build "a habit tracker", don't make them. Their actual idea exposes more.
- **Stop early if it's not working.** A bad session past the 20-minute mark is teaching you the same thing as a bad session at the 5-minute mark. Better to debrief and move on.

---

## After the session

Within 24 hours:

1. Watch the recording at 1.5× while reading your notes. Add anything you missed live.
2. Pull three friction points into the team's tracker (GitHub issues, Linear, whatever).
3. If anything was *severe* (data loss, crash, locked out), file it as `severity: high` and link the recording timestamp.

Plain text writeups beat slide decks. The team reads them faster.
