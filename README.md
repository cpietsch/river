# river

A chat that lives on a canvas, with an agent that lives in the canvas with you.

## The idea

Linear chat is a tape. You scroll, you lose the thread, the model forgets, tangents become dead ends. Most of what makes a real conversation valuable — *we tried that, we backed out, we found something interesting over here, this was the turning point* — has nowhere to go.

river puts the conversation on an infinite tldraw canvas. Every user message and every model response is a card. You can branch from any card. You can run several parallel streams side by side. You can flag, link, and edit. The graph of your thinking becomes a thing you can see, navigate, and build on.

The agent isn't behind a streaming text box. It's a **cartographer of the canvas** — its job is to keep the workspace legible and useful as it grows, not just to answer the latest prompt. It can create cards, rewrite them in place, mark turning points, draw lateral connections between cards in different branches, suggest unexplored directions, and present pick-from pills when it asks you to choose. When the conversation calls for five separate intros, you get five cards. When you ask it to soften card #3, it edits #3 in place. When you're scattered, it can spot two threads in different branches that touch the same idea and draw a dashed line between them. The bar it asks itself before any cartographer move: *would the user, looking at the canvas a week from now, be glad I took this action?*

It also has memory. Each canvas is a *project* — one persistent Anthropic Managed Agent session, alive across reloads, days, multiple browsers. The agent has a writable memory store at `/mnt/memory/` it uses across all your canvases (preferences, recurring topics, durable conclusions). It comes back knowing you. Occasionally, with auto-wake on, it does a quiet cartographer pass between your sessions.

## How it works (walkthrough)

You start typing on the active card at the bottom of the screen. Hit send.

The agent's reply streams onto its own card directly above. While it's working, the card surfaces what it's doing in real time — *searching the web · cooling fan tradeoffs*, *reading a file*, *creating a card on the canvas* — instead of just sitting there with a cursor.

When the reply lands, you have moves:

- **Type into the next card** — a fresh user input slot has spawned automatically below the response. The conversation continues straight down.
- **Branch from any earlier card** — every card has a small `+` button just below its bottom edge. Tap it (or right-click → Branch). A new user input card sprouts as a sibling, and you continue from that point in a parallel direction. The original branch is preserved. The agent's perspective pills above the input refresh to match the card you branched from.
- **Start a new stream** — right-click empty canvas → *New stream here*. A fresh root user input materializes at the click position, parallel to whatever's already on the board. The canvas can hold any number of independent streams; each one is a separate root with its own subtree.
- **Tap an inline phrase chip** — assistant cards have invisible chips on extracted noun phrases (compromise NLP, browser-side). Tap one to mark it; on your next send, those chips ride forward as additional context. Tap a *blue selected ×* counter pill in the input to clear them.
- **Toggle one of the perspective pills** above the input — three Haiku-backed micro-agents (assumption / skeptic / expander) each surface ~2 angles per turn (lavender / amber / teal). Toggle any to weight the next turn against that lens.

The agent participates with the same surface:

- **Branch suggestions.** When it spots an unexplored angle, a small proposal card appears top-right. *Branch ↗* to spawn the new branch + run the agent's prompt on it; *dismiss* to drop it.
- **Flagged cards.** Pivotal moments get a red FLAGGED badge with the agent's one-line reason on hover.
- **Picker pills.** When it asks you to choose from a discrete set, blue-outlined pills appear under its card. Tap one — that becomes your next message, no retyping.
- **Generated cards.** Multi-item answers (5 project intros, 3 options to compare) come as multiple cards under the response, each its own artifact you can edit, branch, or link from independently. Batched in one tool round-trip when more than one is needed.
- **In-place edits.** Tell it "punch up the second one" and the *second card* rewrites — not a new card with the rewrite.
- **Lateral links.** Dashed light-violet arrows showing connections the parent → child tree can't express. *This contradicts that*. *This answers a question raised three branches ago*. The structure of your thinking made visible.

## The toolbar

A single dropdown in the top-left: **Projects.** A list of your canvases. The active one shows its auto-derived name (first user turn, truncated) and a `↻` to reset its agent session — keeps the cards, drops the agent's working memory + container, useful for picking up agent updates. Below: archived projects, click to resume (turns + agent session preserved exactly), double-click to rename, ✕ to delete (also deletes the session server-side). At the very bottom, a small monospace footer: agent version · model · session id (click the id to copy).

Everything else lives on the canvas itself.

## What's actually here

Working today (smoke-tested):

- Persistent per-project Managed Agent sessions on Opus 4.7
- Eight agent custom tools that operate on the canvas: `create_card`, `create_cards`, `edit_card`, `flag_card`, `create_branch`, `link_cards`, `present_options`, plus the read tools `get_graph_summary` and `get_card`
- Full agent toolset (web search, file ops, bash) — used sparingly per a tightened system prompt
- Cartographer-framed system prompt: every turn is also a chance to flag, link, edit, or surface an unexplored angle
- Branching, lateral links, multi-root parallel streams on a single canvas, projects archive/resume/delete
- Auto-discard of orphaned empty branch inputs when you start a new branch or stream
- Live tool-call activity surfaced inline on the streaming card
- Optional autonomous wake (cron loop, off by default) — quiet cartographer passes between sessions
- JSONL session telemetry (`./logs/YYYY-MM-DD.jsonl`) covering server tool use, custom tool calls, token usage, every client-side action
- Persisted UI state (turns, links, branch proposals) survives reloads via the server (single source of truth)
- Skinny per-turn kickoff (branch path of card ids only) so the persistent session doesn't blow context

Prototype-only:

- `(window as any).__editor__` is a dev handle on tldraw's editor
- The cloudflare tunnel URL changes; mobile has its own quirks
- Container `/workspace/` is writable but not yet surfaced in the UI

## Design principles

Two memories saved on the dev account that shape every UI decision:

> **Reduce visual complexity.** Invisible default states, discoverability via hover, no upfront decoration on dense interactive surfaces.

> **Familiar surface, deep structure** ("wolf im Schafspelz"). New mechanics ride on top of a UI the user already knows; complexity reveals on invocation, never upfront.

Concretely: chips are invisible until selected. Cards have no chrome until you hover them. The branch `+` sits just outside each card's bottom edge, faded at rest. The agent's tools don't announce themselves with badges or onboarding tours — you ask a question that needs a list, you get a list of cards. The graph nature of the canvas only becomes visible when you actually branch.

## Two-process app

- `npm run dev` — Vite (web) + Express API (`:4000`). Vite proxies `/api/*` and `/ws/*` to Express.
- `npm run setup-agent` — applies `scripts/agent.yml` to the Managed Agent (creates if needed). Re-run after editing the YAML; each run bumps the agent to a new version (sessions reference latest by default). New canvases provision their own agent from this template; existing canvases keep the version they were created with.
- `.env` needs `ANTHROPIC_API_KEY`. `setup-agent` populates `AGENT_ID`, `ENV_ID`, `MEMORY_STORE_ID`. Optional: `MAIN_MODEL` (overrides the YAML model), `MIST_MODEL` (default `claude-haiku-4-5-20251001`).
- **Auto-wake** (background autonomous turns) is OFF by default. Enable with `WAKE_INTERVAL_SEC=N` (e.g. `3600` for hourly). Tunables: `WAKE_MIN_QUIET_SEC` (skip projects with activity in the last N seconds; default 300) and `WAKE_MAX_AGE_HOURS` (skip projects untouched longer than N hours; default 24).

The brain is Opus 4.7 on Anthropic's Managed Agents platform; the perspective pills + card titles use Haiku for speed. See `CLAUDE.md` for the architecture proper.
