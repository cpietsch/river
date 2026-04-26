# river — hackathon submission plan

**Deadline:** 8:00 PM ET, ~12 hours from now.
**Required:** 3-min demo video (YouTube / Loom / Drive) + public GitHub repo + submission form.

## Pitch (one sentence)

river is a chat that lives on an infinite canvas, with an Opus-4.7 Managed Agent positioned as a **cartographer of the workspace** — it answers turns AND maintains the canvas across days, flagging turning points, drawing lateral links, editing earlier cards, and quietly tidying between sessions via autonomous wake.

## Why we win each criterion

### Impact (30%) — *real-world potential*

The problem is universal: **linear chat is a tape**. Every working session burns context, every fork is destructive, every turning point gets buried. The shape of a thinking session is a graph, not a thread, and people who use chat models heavily for actual work hit this wall every day.

river isn't a UI gimmick — it's a different relationship with the model. The agent has hands inside the workspace; persistent memory; structure that accumulates instead of evaporates. Who benefits: anyone using chat for research, design, planning, writing — i.e. most of the people most invested in heavy LLM use.

The "canvas as a maintained thinking environment" framing generalizes. The hard part — wiring custom tools through Managed Agents into a living UI — is now a working substrate that can host more specialized cartographer for any vertical (research analyst, ops planner, writer's room).

### Demo (25%) — *working, impressive, holds up live*

It's a working app. Multi-canvas. Persistent across reloads, days, devices. Agent actively flags / links / edits / branches / creates multiple cards in a single tool round-trip. Optional autonomous wake means the canvas evolves between sessions. The demo will show all of this in 3 minutes (script below).

### Opus 4.7 Use (25%) — *creative, surfaced capabilities*

Opus 4.7 is the brain. We use it through Managed Agents (a non-trivial integration), with **eight custom tools** that let the model directly mutate the canvas: `create_card`, `create_cards` (batched), `edit_card`, `link_cards`, `flag_card`, `create_branch`, `present_options`, plus read tools `get_graph_summary` / `get_card`.

Beyond the integration: we **reframe the agent's role** in its system prompt — not "respondent" but "cartographer of a thinking canvas." Every turn is also a chance to maintain the workspace. The bar in the prompt: *would the user, looking at the canvas a week from now, be glad you took this action?* This is a behavioral capability surface most integrations don't reach for.

The model also runs **autonomously between sessions** (autonomous wake) — a separate kickoff prompt tells it: no user is here, take ONE useful cartographer action or write a single sentence saying nothing was worth doing. Opus 4.7 quietly tidies the canvas while you're away. This is a use of the model's judgment, not its raw output.

### Depth & Execution (20%) — *wrestled with, real craft*

What's actually wired:
- **Managed Agents per project** with skinny per-turn kickoff (otherwise persistent sessions blow context quadratically — a non-obvious gotcha solved with a path-of-card-ids prompt).
- **Server as canonical store** with WebSocket-driven live sync to support multiple tabs / devices.
- **SSE streaming** of `agent.tool_use` and `agent.custom_tool_use` events into a live activity indicator on the streaming card — the user sees *"searching the web · cooling fan tradeoffs"* instead of an opaque pause.
- **Multi-root canvas layout** — tidy-tree per subtree, anchored at each root's current position; new streams placed where the user right-clicks.
- **Persistent memory store** mounted at `/mnt/memory/` — the agent reads/writes notes across canvases.
- **Auto-discard of orphan empty inputs** when starting a new branch / stream.
- **Fresh predictions on branch** — when branching off an older card, re-run the perspective-pill agents with the chain ending at that card so the pills are tailored, not frozen at original stream time.
- **Local NLP chip extraction** running sub-millisecond per response in the browser — assistant cards have invisible chips on noun phrases the user can tap to ride forward as context.
- **Layout is graph-driven, not arrow-driven** — positions derived from parent→child relationships in the store; tldraw is a view.

Three docs in the repo: `README.md` (experience), `WRITEUP.md` (essay), `CLAUDE.md` (architecture proper). This wasn't a quick hack.

## Prize fit

- **Best Use of Claude Managed Agents** — this is *the* central technical bet. Per-project agent provisioning, per-project sessions, persistent memory store, eight custom tools, container state evolving across days. A reference example.
- **"Keep Thinking" Prize** — autonomous wake literally has the model keep thinking on the canvas between user sessions. The wake kickoff is a deliberate cartographer prompt, not an idle ping.
- **Most Creative Opus 4.7 Exploration** — Opus with hands inside the workspace + a cartographer role + autonomous wake + 8 custom tools. The agent doesn't just respond; it maintains.

## 3-minute demo script

Total budget: 180 seconds. Practice once before recording.

**0:00 – 0:15 — open with the problem (15s)**
> "Most chat with a model lives in a single thread. You scroll, you lose the thread, the model forgets, every fork is destructive. river puts the conversation on a canvas, and the agent has hands inside it."

Visual: title card or quick scroll of a long ChatGPT-style transcript.

**0:15 – 1:00 — basic flow (45s)**
- Type a real research-feeling question. Send.
- Show the activity indicator (*"searching the web · …"*) — proof the model has tools.
- Response streams into a card. Tap an inline chip mid-card to mark a phrase.
- Hit `+` below the assistant card to branch.
- Type a follow-up that pivots. Show the perspective pills above the input refreshed for *this* card.

**1:00 – 1:45 — agent as cartographer (45s)**
- Ask something that produces a multi-card output ("give me 4 framings of this problem"). Show the four cards materialize.
- Show a flag appearing automatically on the most pivotal card (red FLAGGED badge with reason on hover).
- Ask the agent to refine card #3. Show it edit *in place* — not a new card.
- Show a lateral dashed link the agent draws between two cards in different branches.

**1:45 – 2:20 — multi-root canvas (35s)**
- Right-click empty canvas → *New stream here*. New input materializes at the click location.
- Show two parallel root streams visible at once. Zoom out so they're both on screen.
- Mention: "These are independent threads on the same canvas — different investigations, same workspace."

**2:20 – 2:50 — persistent memory + autonomous wake (30s)**
- Reset (or just point to) the agent's `/mnt/memory/` directory — show the durable notes the agent has written about the user across sessions.
- (If pre-recorded:) show a card the agent flagged or a link it drew during an autonomous wake while the user was away.

**2:50 – 3:00 — close (10s)**
> "A maintained thinking environment, not a pile of historical turns. Built on Opus 4.7 + Managed Agents."

Show the repo URL.

## 12-hour execution plan

### T-12 → T-9 (now → 11 PM your local) — pre-flight
- [ ] **Smoke test full demo flow end-to-end** on a fresh canvas. Time it. Find anything that breaks under demo conditions.
- [ ] **Pre-seed a "demo canvas"** with a credible 8-12 turn conversation that includes a flag, a lateral link, an `edit_card` artifact, and a multi-card response. Park it at a known project id so you can resume cleanly during the demo.
- [ ] **Run one autonomous wake** on the demo canvas so you can show the result during the wake segment.
- [ ] Verify the GitHub repo is **public** (event requirement). Push a clean tip with the README / WRITEUP / CLAUDE.md / HACKATHON.md.
- [ ] Quick `npm run typecheck` + `npm run build`. Fix anything that breaks.

### T-9 → T-6 (11 PM → 2 AM) — record
- [ ] Set up screen recording at 1080p+ with a quiet mic. Loom or OBS.
- [ ] Record the demo following the script. Allow 2-3 takes; pick the best.
- [ ] Keep cuts minimal. Live-feel beats polished-feel for "holds up live."
- [ ] Upload to YouTube *unlisted* or Loom (not Drive — Drive permissions trip up reviewers).
- [ ] Save the URL.

### T-6 → T-3 (2 AM → 5 AM) — submission text + repo polish
- [ ] Write the submission form copy (see template below).
- [ ] If the form asks for problem-statement fit, name the relevant one and explicitly tie river's mechanics to it.
- [ ] Add a `## Demo` section to README with the video link + a single screenshot.
- [ ] Make sure `.env` is gitignored and no API keys are in commit history (`git log -p -- .env` should be empty).
- [ ] Tag a release: `git tag -a hackathon-v1 -m "submission tag"`, push tag.

### T-3 → T-1 (5 AM → 7 AM) — buffer + final QA
- [ ] Re-watch the demo video on a different device. Audio level OK? Anything cut off?
- [ ] Re-clone the repo into a temp directory and run `npm install && npm run dev` to confirm a stranger can run it. Document any missing setup step in the README.
- [ ] Verify all three docs render correctly on GitHub (no broken links, no leaked secrets).

### T-1 → T-0 (7 AM → 8 AM ET) — submit
- [ ] Submit the form. Don't wait. **Many forms close at the deadline second.**
- [ ] Confirm submission was received (look for confirmation email / page).
- [ ] Post in any relevant Slack / Discord that you submitted.

## Submission form copy template

> **Project name:** river
>
> **One-liner:** A chat that lives on an infinite canvas, with an Opus-4.7 Managed Agent that tends the workspace across days — flagging turning points, drawing lateral links, editing earlier cards, and quietly tidying between sessions.
>
> **What it does:** [paste two paragraphs from WRITEUP.md "What river is" section]
>
> **What's most novel about how it uses Opus 4.7:** Opus 4.7 has *hands inside the workspace* via eight custom tools (`create_card`, `create_cards`, `edit_card`, `link_cards`, `flag_card`, `create_branch`, `present_options`, plus reads). It's framed in its system prompt as a cartographer — every turn is also a chance to maintain the canvas. With autonomous wake enabled, Opus runs without a user present to take quiet cartographer actions between sessions. We exercise the model's judgment, not just its raw output.
>
> **Why Managed Agents:** Per-project agent provisioning, persistent sessions evolving across days, mounted memory store at `/mnt/memory/` shared across canvases, container state across reloads, skinny per-turn kickoff so persistent sessions don't suffer quadratic context blowup. The platform's stateful primitives are load-bearing — we couldn't do this with raw Messages.
>
> **Repo:** https://github.com/[…]/river
> **Demo video:** [URL]

## Risks / what could break

- **Streaming UX:** `agent.message` events arrive in chunks, not token-by-token. There's a visible pause while the agent thinks. The activity indicator was added to make this feel deliberate. Practice the demo so dead air doesn't read as lag.
- **Autonomous wake side effects:** make sure `WAKE_INTERVAL_SEC` is unset during the demo so a wake doesn't fire mid-recording. Pre-record the "wake result" segment separately.
- **API key exposure:** `.env` should be `.gitignore`d. Double-check before pushing public.
- **First-run latency:** a fresh project on a fresh session takes a few seconds longer because the platform spins up a container. The demo canvas should be pre-warmed.
- **Mobile demo:** don't try mobile in the video. Stay on desktop where the polish is.

## Doc inventory

- `README.md` — experience-led intro
- `WRITEUP.md` — essay framing for the judges who read further
- `CLAUDE.md` — architecture deep-dive
- `HACKATHON.md` — this file (submission plan + pitch)
