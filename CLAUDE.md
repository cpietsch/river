# river

Canvas-based chat prototype: a tldraw infinite canvas where each user/assistant turn is a card, branches are arrows, and the brain is a Managed Agent that lives across the whole canvas (one persistent session per project, one provisioned agent per project). The agent is positioned as a **cartographer** of the canvas — it answers turns AND tends the workspace: creating, flagging, linking, and editing cards over time. Multiple parallel root streams can coexist on a single canvas. Two-process app — Vite (web) + Express (single source of truth + Anthropic proxy).

## Run

- `npm run dev` — concurrently starts Vite and the Express API on `:4000`. Vite proxies `/api/*` and `/ws/*` to the API.
- `npm run typecheck` — `tsc --noEmit`. Run before committing.
- `npm run build` — typecheck then production Vite build.
- `npm run setup-agent` — applies `scripts/agent.yml` to a Managed Agent (creates if needed; archived agent IDs are auto-replaced). Re-run after editing the YAML; each run bumps the *template* agent to a new version. New canvases provision their own agent from this template at create time; existing canvases keep the version they were created with.
- `.env` must have `ANTHROPIC_API_KEY`, `AGENT_ID`, `ENV_ID`, `MEMORY_STORE_ID` (the last three populated by `setup-agent`). Optional: `MAIN_MODEL` (default `claude-opus-4-7` — the brain), `MIST_MODEL` (default `claude-haiku-4-5-20251001` — pill agents + labels), `PORT` (default 4000), `WAKE_INTERVAL_SEC` (off by default — enable to run autonomous wake passes).

## Layout

### Source of truth: the server

The Express server (`server.js` + a SQLite-backed `db.js`) is the canonical store for projects, turns, links, and branch proposals. The client reads from `/api/projects/:id/state` on mount / project switch, then receives live updates via WebSocket (`/ws/:projectId`). Multiple tabs / browsers stay in sync this way.

- `src/graph/store.ts` — Zustand store (`useConversation`). Holds the active canvas's data in memory:
  - `activeProjectId: string | null` — the only field persisted to localStorage (key `river-active`)
  - `projects: Project[]` — list metadata
  - `turns: Record<TurnId, Turn>`, `links: Link[]`, `proposals: BranchProposal[]` — populated from the server on switch
  - `projectSessionId: string | null` — active canvas's Managed Agent session id
  - `activity: {turnId, text} | null` — transient: what the agent is currently doing during a stream
  - Mutators: `createTurn`, `setContent`, `setStreaming`, `setEmphasis`, `setChipSpans`, `setPredictions`, `togglePrediction`, `setLabel`, `setAgentFlag`, `toggleChipSelected`, `clearChipsSelected`, `removeSubtree`, `setProjectSessionId`, `setActivity`, `setActiveProjectId`, `loadActiveCanvas`, `clearActiveCanvas`, `upsertTurnFromRemote`, `addLink`, `removeLink`, `addProposal`, `removeProposal`
  - Selectors: `getTurn`, `getChildren`, `getAncestors`, `getDescendants`
  - Helper: `deriveProjectName(turns)` — auto-derives a canvas title from the first user turn
- `src/graph/types.ts` — `Turn`, `TurnMeta` (chipSpans, predictions, predictionsToggled, chipsSelected, label, agentFlagReason, options), `Link`, `BranchProposal`.
- `src/graph/sync.ts` — `syncStoreToTldraw(editor)`: idempotent diff that ensures tldraw shapes mirror store turns + parent edges + lateral links. Creates missing card shapes, updates drifted props, deletes orphans.
- `src/graph/useTldrawSync.ts` — React hook that subscribes the syncer to the store. Surfaces `onStructuralChange` so App can run `relayoutAll` on turn create/remove or parent change.
- `src/graph/extractSpans.ts` — local NLP-based span extractor (compromise + regex backstops). Identifies noun phrases, named entities, hyphenated compounds, acronyms, numeric quantities, and ADJ+NOUN compounds. Runs synchronously in-browser, sub-millisecond per response.
- `src/graph/markdown.ts` — `stripMarkdown` (strips `**bold**` / `*italic*` markers, returns plain text + ranges) and `parseBlocks` (splits text into paragraph + table blocks).

### App + UI

- `src/App.tsx` — owns the editor ref, transient UI state (activeId, input, busy, ctxMenu, projectsOpen, proposals, agentInfo), and ALL graph mutations. Read paths use store selectors. Layout (`relayoutAll` tidy-tree, `repositionChain` after height changes) walks the graph store. Wires the `CardActionsContext` provider. Hosts the `ProjectsMenu`, `ProposalsPanel`, `RiverCtxMenu` overlay components. Subscribes to the project's WebSocket on mount/switch.
- `src/CardShape.tsx` — custom tldraw `ShapeUtil` for `card`. Renders user/assistant cards with serif body. The active empty user card short-circuits to `<ActiveInputCard>` (the chat input). Markdown emphasis + chip spans rendered via `renderContentBlocks` → `renderWithChipSpans`. Inline chips toggle in-place. Each card has a small `BranchPlusButton` rendered just outside its bottom edge — taps call `branchFrom(shape.id)`. While streaming, shows the agent's live `activity` line inline (e.g. *"searching the web · cooling fan tradeoffs"*). Cards flagged by the agent show a red **FLAGGED** badge top-right with the reason on hover. Heights are measured via `ResizeObserver` on the content element so late font loads / viewport changes re-flow correctly.
- `src/CardActions.tsx` — React Context interface bridging App to deeply-nested card UI.
- `src/api.ts` — fetch wrappers: `streamGenerate` (SSE), `fetchAgentPredictions`, `fetchLabels`, `fetchInfo`, `fetchProjects`, `fetchProjectState`, `upsertTurnRemote`, `deleteSubtreeRemote`, `addLinkRemote`, `removeLinkRemote`, `removeProposalRemote`, `patchProjectRemote`, `wakeProject`, `deleteSession`, `logEvent`. Types: `ChatMessage`, `ChipSpan`, `AgentPrediction`, `AgentId`, `BranchProposal`, `CardFlag`, `CardCreation`, `LabelCard`, `GraphSnapshot`, `AgentInfo`.
- `src/tldraw-augment.d.ts` — extends tldraw's global shape map.
- `server.js` — Express. Active endpoints:
  - `POST /api/generate` — main turn through the **Managed Agent** session (skinny kickoff on reuse, full kickoff when minting a new session)
  - `POST /api/agents` — assumption / skeptic / expander pill agents in parallel (Haiku, raw Messages — must be sub-second; spinning up sessions per pill would tank latency)
  - `POST /api/labels` — batch-titles cards (Haiku, raw Messages, single round-trip)
  - `GET /api/memory` — dumps the agent's persistent memory store as `{path: content}` JSON (uses a throwaway session to read `/mnt/memory/<store>/`). The toolbar UI that called this was removed; the endpoint stays for ad-hoc inspection.
  - `GET /api/info` — agent template metadata for the projects-menu footer
  - `GET /api/projects`, `POST /api/projects`, `GET /api/projects/:id/state`, `PATCH /api/projects/:id`, `DELETE /api/projects/:id` — project CRUD
  - `POST /api/projects/:id/turns`, `DELETE /api/projects/:id/turns/:turnId` — turn upsert / subtree delete (mirrors client-driven mutations)
  - `POST /api/projects/:id/links`, `DELETE /api/projects/:id/links/:linkId` — lateral link CRUD
  - `POST /api/projects/:id/proposals`, `DELETE /api/projects/:id/proposals/:proposalId` — branch proposal CRUD
  - `POST /api/projects/:id/wake` — manual autonomous wake (also runnable via cron loop with `WAKE_INTERVAL_SEC`)
  - `DELETE /api/session/:id` — best-effort cleanup of a Managed Agent session (called on project ✕ and on ↻ reset session)
  - `POST /api/log` — client telemetry (events with `client.*` prefix only) → JSONL
  - `WS /ws/:projectId` — per-project broadcast (turn_upsert, subtree_deleted, link_added, link_deleted, proposal_added, proposal_removed, activity, etc.)
  - `GET /api/health`
- `scripts/setup-agent.js` — provisions/updates the template Managed Agent + environment + memory store. Reads `scripts/agent.yml` (system prompt, tool list, model). Custom tools: `get_graph_summary`, `get_card`, `create_card`, `create_cards`, `edit_card`, `link_cards`, `flag_card`, `create_branch`, `present_options`. Re-runs are idempotent — existing IDs in `.env` get a new agent version (immutable). Override the model per-run with `MAIN_MODEL=… npm run setup-agent`.

## Concepts that are not obvious from the code

**Cartographer agent, not just respondent.** `scripts/agent.yml`'s system prompt frames the agent's role as "cartographer of a thinking canvas" — its job is to keep the workspace legible and useful as it grows. Every turn is also an opportunity to maintain the canvas: flag a turning point, draw a lateral link the parent → child tree can't express, refine an earlier card that aged badly, surface an unexplored angle as a draft branch. The cadence target is ~0–2 cartographer moves per turn, taken only when genuinely earned. The bar in the prompt: *would the user, looking at the canvas a week from now, be glad you took the action?*

**The brain is a Managed Agent with one session per project.** A "project" = one canvas. Each project gets its own provisioned agent at create time (immutable, versioned), and its own session id stored on the project row server-side. `/api/generate` accepts `sessionId`, `pathIds`, and `responseCardId` in the request body:
- If a session id exists, the server reuses it and sends a **skinny kickoff** (`buildSkinnyKickoff`: branch path of card ids + this turn's priority constraints / chip context + the new question — ~30-100 tokens; the session's event log already has all priors).
- If not, the server mints a fresh session and sends the **full kickoff** (`buildFullKickoff`: priors rendered as text) and emits `data:{type:"session", sessionId}` as the first SSE event so the client can persist it.
- The skinny path is critical for performance — without it, persistent sessions would see quadratic context blowup as each turn re-embedded the full prior history that the session log already contained.
- The kickoff also includes `BRANCH PATH` (real card ids the agent can pass to mutating customs) and `YOUR RESPONSE CARD: shape:xxx` (the assistant card the prose is streaming into; the natural parent for `create_card` / `create_cards`).
- If the client's session id is stale (deleted out-of-band), the server catches the send error, mints a fresh session, swaps to the full kickoff, and retries once. No pre-flight `sessions.retrieve()` round-trip.

Sessions are NOT deleted on completion; the canvas's event log + container state evolve over the project's lifetime. The memory store stays attached, `/mnt/memory/river-memory/` survives across sessions and across canvases. The `↻` reset button on the active project drops the session (cards stay; agent's intra-session memory + container reset; next turn mints a fresh session).

**Multi-project: projects menu.** The toolbar's first button (the only toolbar button now — map and memory icons were removed) toggles a `ProjectsMenu` dropdown showing the active canvas's auto-derived name, `+ new canvas` at top, the active row with a `↻` reset-session button, and one row per archived project with click-to-resume, double-click-to-rename, and an inline ✕ that confirms then calls `deleteSession(sessionId)` server-side. `repaintCanvas()` wipes tldraw shapes after a swap so the syncer rebuilds from the new turn set.

**Multi-root canvas.** A single canvas can hold multiple parallel conversation trees. Every turn with `parentId === null` is a root. `relayoutAll` finds all roots, anchors each tree at its root's current `(x, y)`, and runs the tidy-tree pass per subtree — trees never crowd each other because each one keeps its anchor. The user creates new roots via right-click → *New stream here* (`startNewStream(pageX, pageY)` in App.tsx); the new root materializes at the click position, becomes active, and its subtree flows below.

**Auto-discard of orphaned empty branches.** When the user clicks `+` on another card to start a new branch — or right-clicks → *New stream here* — any currently-active *empty* user card is removed (client + server) before the new one is created. Without this, a sequence of `+` clicks would leave a trail of dangling empty user turns. Logic lives in `branchFrom` and `startNewStream` in `App.tsx`.

**Streaming caveat.** `agent.message` events arrive with full content blocks, not token-by-token like the raw Messages API stream. The user sees a pause while the agent thinks (and possibly searches), then the response appears in chunks. This is the documented Managed Agents wire shape, not a regression — we trade smooth token streaming for grounded answers + tool access.

**Live activity indicator during long tool calls.** Server emits `data:{type:"activity", text:"…"}` on every `agent.tool_use` and `agent.custom_tool_use` with a plain-language description (e.g. *"searching the web · cooling fan tradeoffs"*, *"creating a card on the canvas"*). Client stores it in `activity: {turnId, text}` scoped to the streaming assistant turn. CardShape reads it and renders an inline pulsing-dot status line where the cursor would otherwise sit. Cleared by the next text delta and on stream end.

**Agent-driven canvas mutations.** Six custom tools let the brain *act on* the canvas, not just stream text into it:
- **`create_branch(parent_id, prompt, rationale?)`** — proposes an unexplored direction. Server validates parent_id, forwards `data:{type:"branch_proposal", proposalId, parentId, prompt, rationale}` as SSE, ACKs the agent immediately so it never blocks. Client pushes onto `proposals[]`; the top-right `ProposalsPanel` renders each with parent-card title + suggested prompt + dismiss/branch buttons. Accept = `createBranchUserTurn(parent_id) + runTurnFrom(newId, prompt)`.
- **`flag_card(card_id, reason)`** — marks a card as a turning point. Server forwards `data:{type:"card_flagged", cardId, reason}`; client calls `setAgentFlag(id, reason)` which sets emphasis=2 AND records the reason on `meta.agentFlagReason`. Card renders with a red FLAGGED badge top-right; reason on hover.
- **`create_card(parent_id, content, role?)`** — materializes ONE card. Server generates the new TurnId, forwards `data:{type:"card_created", id, parentId, role, content}`, ACKs the agent with the id so it can chain (flag the card it just made, parent further cards under it).
- **`create_cards([{parent_id, content, role?}, ...])`** — materializes MULTIPLE cards in a single tool round-trip. Strongly preferred over N sequential `create_card` calls. Returns an array of ids in the same order. Used when the user's request naturally produces multiple distinct outputs (5 project intros, 3 options, item-by-item rewrites); the streaming prose becomes a brief header card.
- **`edit_card(card_id, content)`** — rewrites an existing assistant card in place. Used when the user gives feedback on a specific card ("punch up the third one", "soften that opening"). Chip spans regenerate on the next stream tick. User cards are off-limits.
- **`link_cards(from_id, to_id, kind)`** — draws a lateral dashed arrow between two cards in the graph beyond the parent → child tree. `kind` is a short verb label ("answers", "contradicts", "elaborates", "supersedes").
- **`present_options(card_id, options[])`** — attaches tappable pill-options to a card so the user can pick from a discrete set without retyping. Each pill becomes the user's next message verbatim when tapped.

**Autonomous wake.** With `WAKE_INTERVAL_SEC` set, a cron loop in `server.js` walks projects on the configured interval and runs `runWakeForProject(projectId)` on any that are quiet and recent enough (gated by `WAKE_MIN_QUIET_SEC` and `WAKE_MAX_AGE_HOURS`). The wake kickoff (`buildAutonomousKickoff`) tells the agent: no user is present, take ONE useful cartographer action (flag / link / edit / small elaboration card) or write a single sentence saying nothing was worth doing. `create_branch` and `present_options` are disabled in wake mode (no user to react). Manual wakes are also exposed via `POST /api/projects/:id/wake`.

**The store is canonical inside a tab; the server is canonical across tabs.** Inside a tab, every mutation goes through `useConversation` → tldraw via the syncer hook. Across tabs, the server holds the truth: client mutations also fire the corresponding `/api/projects/:id/*` endpoint, and incoming WebSocket events apply to the local store. Read paths (`historyFor`, `pathIdsFor`, `getParentId`, `gatherEmphasized`, `relayoutAll`) walk the graph store.

**Inline chips are derived from prose, locally.** Sonnet/Opus writes plain prose with light markdown — no `[[X]]` markup. After each stream completes, `extractSpans(stripMarkdown(buffer).plain)` returns an array of `{phrase, question}` spans, written to `assistant.meta.chipSpans`. The renderer walks the unified set of (chip + bold + italic) ranges and emits nested `<strong>` / `<em>` / `<BranchChip>`. Per-sentence streaming extraction: when the buffer crosses a `. ! ?` followed by whitespace, re-run the extractor — chips appear progressively.

**Marker / highlight UX.** Tapping a chip toggles its selected state in `assistant.meta.chipsSelected[]`. Single-occurrence wrap (only the first match per phrase becomes a chip), but selection is per-card. Visually: unselected chips are *invisible* (identical to surrounding text), selected fills blue with a 2px box-shadow ring (no padding shift, so line wrapping is unaffected). Hover previews the selection at low opacity.

**Send pipeline merges sources.** When the user submits:
- typed text → user message; toggled agent pills + selected chips → `userContext` system-prompt augmentation.
- empty text + selections → selections become the user message; `userContext` is skipped to avoid duplication.
- After successful submit, `chipsSelected` clears on the source cards (selections don't quietly carry into every subsequent turn).

**Fresh predictions on branch.** When `branchFrom` opens a new branch off card X, it re-runs `/api/agents` with the chain ending at X and replaces X's stored predictions. Without this, branching off an older card would surface the predictions that were generated when that card originally streamed — frozen at a prior conversation state. The active input subscribes to the parent's predictions and re-renders when fresh ones land.

**Three pill agents, one pipeline.** `assumption` (lavender), `skeptic` (amber), `expander` (teal) each return ~2 predictions per turn via `/api/agents` (Haiku, parallel, raw Messages — stateless). Rendered as a single pill row above the next input. Toggling any of them adds to `predictionsToggled` on the parent assistant. Same toggle/send mechanics as in-text chips.

**Counter pill summarizes in-text selections.** When `chipSelectionCount > 0` (sum across active chain ancestors), a blue **N selected ×** pill appears in the input row. Tapping clears every chip selection across the chain.

**Layout is graph-driven, not arrow-driven.** `relayoutAll` reads `parent → children` from the store, finds all roots, computes a tidy-tree column layout per subtree anchored at each root's current `(x, y)`, and writes positions back to tldraw shapes. `repositionChain` walks store children when a card's measured height changes. `CARD_GAP_Y` (vertical breathing room between parent and child) is currently 64px; `CARD_GAP_X` is 80px.

**Card heights via ResizeObserver.** Cards measure their own height via a `ResizeObserver` on the content element. This catches initial mount, content edits, viewport changes, AND late font loads (Source Serif 4 arrives async via Google Fonts; without this the first measurement runs in the system-ui fallback and never re-fires when the serif lands taller — cards rendered clipped on reload).

**Hand tool, not select tool.** The editor is locked to the `hand` tool with a store listener that snaps it back. Drag = pan, never moves shapes. Cards are immovable without per-card `isLocked` (which would force unlock/relock around every autolayout `updateShape`).

**Mobile taps on inline elements use `pointerDown` (not `click`).** tldraw's hand tool captures the pointer at touchstart, and the synthesized click on touchend often never fires. The `tap()` helper in `CardShape.tsx` triggers actions on `pointerdown` directly with `stopPropagation`. Applied to chips, agent pills, icon buttons, the branch `+`, and the send button.

**`canCull = () => false` on cards.** Offscreen cards would unmount their HTML container; the height measurement would read `scrollHeight === 0` and the card would collapse to a sliver.

**Camera animation override.** `editor.user.updateUserPreferences({ animationSpeed: 1 })` overrides OS reduce-motion so programmatic camera moves stay smooth.

**Persistence keys.** zustand: `river-active` (localStorage) — only `activeProjectId`. Server SQLite is canonical for everything else (projects, turns, links, proposals, sessions). tldraw: `persistenceKey="river-graph"` (IndexedDB, shape positions). Bump localStorage key when the persisted shape changes.

**JSONL session logs.** `server.js` appends every server-side and client-side event to `./logs/YYYY-MM-DD.jsonl` (one line per event: `{ts, type, ...data}`). Server emits `generate.{start,session_created,session_lost,tool_use,custom_tool_use,end,error}`, `agents.{complete,error}`, `labels.{start,complete,error,parse_error}`, `memory.{complete,error,parse_error}`, `wake.{start,tool_use,custom_tool_use,end,error}`, `agent.{provisioned,provision_failed}`, `session.{deleted,delete_failed}`. Client posts via `POST /api/log`: `client.{chip_toggle, prediction_toggle, emphasis_toggle, branch, new_stream, delete, start_new, send, switch_project, delete_project, reset_session, branch_proposal_received, proposal_accept, proposal_dismiss, card_flagged, card_created, card_edited, card_linked, card_options, option_picked, wake_start, wake_end, ws_subscribed, ws_error}`. Type prefix `client.` is enforced server-side. `logs/` is gitignored.

## Design principles (saved as memories)

- **Reduce visual complexity** — invisible default states, discoverability via hover, no upfront decoration on dense interactive surfaces.
- **Familiar surface, deep structure** ("wolf im Schafspelz") — new mechanics ride on top of a UI the user already knows; complexity reveals on invocation, never upfront.

## Conventions

- All tldraw arrows are created with `isLocked: true` so users can't drag endpoints.
- The custom context menu disables tldraw's via `components.ContextMenu = null`. `<RiverCtxMenu>` opens from a `contextmenu` handler on the outer `<div>`. On empty canvas it offers *New stream here* / *New canvas*; on a card it adds *Branch* / *Copy text* / *Delete*.
- The branch `+` button on each card lives just outside the bottom edge (`bottom: -16px`, centered on the parent → child arrow column). Card overflow is `visible` so the button can render outside the shape's bounds.
- Inline elements inside cards (chips, agent pills, icon buttons, branch `+`, textarea, send button) all use `tap()` / `tapPointerDown()` from `CardShape.tsx` — `stopPropagation` on `pointerdown`, action fires immediately.
- `touch-action: none` on `html, body, #root` (in `index.html`) silences tldraw's preventDefault warnings; `.tl-html-container button/textarea/[role=button]` reverts to `manipulation` so taps still work.
- Body fonts: Source Serif 4 (loaded from Google Fonts in `index.html`) for assistant/user card content. UI chrome (toolbar, pills, input) keeps `system-ui` sans.

## Prototype-only knobs

- `START_SEED` in `App.tsx` — pre-fills the input on a fresh canvas for fast iteration.
- `(window as any).__editor__` — dev handle exposed in `handleMount`. Remove before shipping.
- `npx tsx src/graph/extractSpans.test.ts` — runs the local extractor on five sample topics (tech, cooking, history, philosophy, biology) and prints the spans. Useful when tuning coverage.
- `scratch/` — mobile screenshots from prior iterations; not used at runtime.
- `/tmp/river2-test-*.mjs` — handy ad-hoc smoke tests for the agent's custom tools (branch / flag / create_card / link / edit). Not committed; recreate as needed.
