# river-2

A chat that lives on a canvas, with an agent that lives in the canvas with you.

## The idea

Linear chat is a tape. You scroll, you lose the thread, the model forgets, tangents become dead ends. Most of what makes a real conversation valuable — *we tried that, we backed out, we found something interesting over here, this was the turning point* — has nowhere to go.

river-2 puts the conversation on an infinite tldraw canvas. Every user message and every model response is a card. You can branch from any card. You can flag, link, and re-arrange them. The graph of your thinking becomes a thing you can see, navigate, and build on.

The agent isn't behind a streaming text box. It has hands inside the canvas — it can create cards, rewrite them, mark turning points, draw lateral connections between cards in different branches, suggest unexplored directions, and present pick-from pills when it asks you to choose. When the conversation calls for five separate intros, you get five cards. When you ask it to soften card #3, it edits #3 in place. When you're scattered, it can spot two threads in different branches that touch the same idea and draw a dashed line between them.

It also has memory. Each canvas is a *project* — one persistent Anthropic Managed Agent session, alive across reloads, days, multiple browsers. The agent has a writable memory store at `/mnt/memory/` it uses across all your canvases (preferences, recurring topics, durable conclusions). It comes back knowing you.

## How it works (walkthrough)

You start typing on the active card at the bottom of the screen. Hit send.

The agent's reply streams onto its own card directly above. While it's working, the card surfaces what it's doing in real time — *searching the web · cooling fan tradeoffs*, *reading a file*, *creating a card on the canvas* — instead of just sitting there with a cursor.

When the reply lands, you have moves:

- **Type into the next card** — a fresh user input slot has spawned automatically below the response. The conversation continues straight down.
- **Branch** from any earlier card — long-press → Branch (or right-click). A new user input card sprouts as a sibling, and you continue from that point in a parallel direction. The original branch is preserved.
- **Tap an inline phrase chip** — assistant cards have invisible chips on extracted noun phrases (compromise NLP, browser-side). Tap one to mark it; on your next send, those chips ride forward as additional context. Tap a *blue selected ×* counter pill in the input to clear them.
- **Toggle one of the perspective pills** above the input — three Haiku-backed micro-agents (assumption / skeptic / expander) each surface ~2 angles per turn (lavender / amber / teal). Toggle any to weight the next turn against that lens.

The agent participates with the same surface:

- **Branch suggestions.** When it spots an unexplored angle, a small proposal card appears top-right. *Branch ↗* to spawn the new branch + run the agent's prompt on it; *dismiss* to drop it.
- **Flagged cards.** Pivotal moments get a red FLAGGED badge with the agent's one-line reason on hover.
- **Picker pills.** When it asks you to choose from a discrete set, blue-outlined pills appear under its card. Tap one — that becomes your next message, no retyping.
- **Generated cards.** Multi-item answers (5 project intros, 3 options to compare) come as multiple cards under the response, each its own artifact you can edit, branch, or link from independently.
- **In-place edits.** Tell it "punch up the second one" and the *second card* rewrites — not a new card with the rewrite.
- **Lateral links.** Dashed light-violet arrows showing connections the parent → child tree can't express. *This contradicts that*. *This answers a question raised three branches ago*. The structure of your thinking made visible.

## Three navigation surfaces

A toolbar in the top-left has three buttons; each opens a small dropdown.

**Projects.** A list of your canvases. The active one shows its auto-derived name (first user turn, truncated) and a `↻` to reset its agent session — keeps the cards, drops the agent's working memory + container, useful for picking up agent updates. Below: archived projects, click to resume (turns + agent session preserved exactly), double-click to rename, ✕ to delete (also deletes the session server-side). At the very bottom, a small monospace footer: agent version · model · session id (click the id to copy).

**Map.** A live spatial mini-map of the canvas — every card a small rect at its scaled position, parent → child arrows between them. Click a rect to pan there; hover for the card's auto-generated label. Long conversations stay scannable in 320px of height.

**Memory.** What the agent has written to its persistent memory store. A modal with one expandable file per topic — preferences, project notes, durable conclusions. The user can see what the agent remembers about them, the way you'd see a colleague's notebook.

## What's actually here

Working today (smoke-tested):

- Persistent per-project Managed Agent sessions on Opus 4.7
- Six agent custom tools that operate on the canvas: `create_card`, `edit_card`, `flag_card`, `create_branch`, `link_cards`, `present_options`
- Two read tools: `get_graph_summary`, `get_card`
- Full agent toolset (web search, file ops, bash) — used sparingly per a tightened system prompt
- Branching, lateral links, projects archive/resume/delete
- Spatial mini-map, memory inspector, projects menu with version+session footer
- Live tool-call activity surfaced inline on the streaming card
- JSONL session telemetry (`./logs/YYYY-MM-DD.jsonl`) covering server tool use, custom tool calls, token usage, every client-side action
- Persisted UI state (turns, links, branch proposals, archive list) survives reloads
- Skinny per-turn kickoff (branch path of card ids only) so the persistent session doesn't blow context

Prototype-only:

- `START_SEED` pre-fills the input on a fresh canvas for fast iteration
- `(window as any).__editor__` is a dev handle on tldraw's editor
- The cloudflare tunnel URL changes; mobile has its own quirks
- Container `/workspace/` is writable but not yet surfaced in the UI

## Design principles

Two memories saved on the dev account that shape every UI decision:

> **Reduce visual complexity.** Invisible default states, discoverability via hover, no upfront decoration on dense interactive surfaces.

> **Familiar surface, deep structure** ("wolf im Schafspelz"). New mechanics ride on top of a UI the user already knows; complexity reveals on invocation, never upfront.

Concretely: chips are invisible until selected. Cards have no chrome until you hover them. The agent's tools don't announce themselves with badges or onboarding tours — you ask a question that needs a list, you get a list of cards. The graph nature of the canvas only becomes visible when you actually branch.

## Two-process app

- `npm run dev` — Vite (web) + Express API (`:4000`). Vite proxies `/api/*` to Express.
- `npm run setup-agent` — one-time provisioning of the Managed Agent + environment + memory store. Re-run after editing the system prompt or tool list; each run bumps the agent to a new version (sessions reference latest by default).
- `.env` needs `ANTHROPIC_API_KEY`. `setup-agent` populates `AGENT_ID`, `ENV_ID`, `MEMORY_STORE_ID`. Optional: `MAIN_MODEL` (default `claude-opus-4-7`), `MIST_MODEL` (default `claude-haiku-4-5-20251001`).

The brain is Opus 4.7 on Anthropic's Managed Agents platform; the perspective pills + card titles + memory inspection use Haiku for speed. See `CLAUDE.md` for the architecture proper.
