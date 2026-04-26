# river-2

Canvas-based chat prototype: a React Flow canvas where each user/assistant turn is a card, parent→child edges connect them, and the brain is a Managed Agent that lives across the whole canvas (one persistent session per project). The agent can write into the canvas itself — proposing branches, flagging important cards, and materializing structured outputs as new cards. Inline phrase-chips inside assistant cards let the user mark spans to ride forward as context. Two-process app — Vite (web) + Express (API proxy to Anthropic).

## Run

- `npm run dev` — concurrently starts Vite and the Express API on `:4000`. Vite proxies `/api/*` to the API.
- `npm run typecheck` — `tsc --noEmit`. Run before committing.
- `npm run build` — typecheck then production Vite build.
- `npm run setup-agent` — provisions/updates the Managed Agent + environment + memory store. Re-run after editing `scripts/setup-agent.js` (system prompt, tool list); each run bumps the agent to a new version.
- `.env` must have `ANTHROPIC_API_KEY`, `AGENT_ID`, `ENV_ID`, `MEMORY_STORE_ID` (the last three populated by `setup-agent`). Optional: `MAIN_MODEL` (default `claude-opus-4-7` — the brain), `MIST_MODEL` (default `claude-haiku-4-5-20251001` — pill agents + labels), `PORT` (default 4000).

## Layout

### Source of truth: the conversation graph

- `src/graph/store.ts` — Zustand store (`useConversation`) with persist middleware (localStorage key `river-2-graph`). Holds:
  - `turns: Record<TurnId, Turn>` — active canvas's turns
  - `projectSessionId: string | null` — active canvas's Managed Agent session id
  - `archive: ArchivedProject[]` — prior canvases (turns + sessionId snapshots) the user has stashed via `+ new canvas`
  - `activity: {turnId, text} | null` — transient: what the agent is currently doing during a stream
  - Mutators: `createTurn`, `setContent`, `setStreaming`, `setEmphasis`, `setChipSpans`, `setPredictions`, `togglePrediction`, `setLabel`, `setAgentFlag`, `toggleChipSelected`, `clearChipsSelected`, `removeSubtree`, `reset`, `setProjectSessionId`, `setActivity`, `archiveAndReset`, `resumeArchived`, `deleteArchived`, `renameArchived`
  - Selectors: `getTurn`, `getChildren`, `getAncestors`, `getDescendants`
  - Helper: `deriveProjectName(turns)` — auto-derives a canvas title from the first user turn
- `src/graph/types.ts` — `Turn`, `TurnMeta` (chipSpans, predictions, predictionsToggled, chipsSelected, label, agentFlagReason), `ConversationGraph`. `TurnId` is a plain `string` (kept the legacy `shape:xxx` prefix so persisted canvases from the tldraw era still load).
- `src/graph/layout.ts` — dagre tidy-tree (`buildFlow(turns, links, heights)`) returning the `{nodes, edges}` arrays React Flow consumes. Uses last-measured per-card heights when available, falling back to `CARD_HEIGHT_HINT`. Exports `CARD_WIDTH` (responsive cap, mirrors the legacy constant).
- `src/graph/extractSpans.ts` — local NLP-based span extractor (compromise + regex backstops). Identifies noun phrases, named entities, hyphenated compounds, acronyms, numeric quantities, and ADJ+NOUN compounds. Runs synchronously in-browser, sub-millisecond per response.
- `src/graph/markdown.ts` — `stripMarkdown` (strips `**bold**` / `*italic*` markers, returns plain text + ranges) and `parseBlocks` (splits text into paragraph + table blocks).

### App + UI

- `src/App.tsx` — owns the React Flow instance ref, transient UI state (active input, busy, ctxMenu, projectsOpen, mapOpen, memoryOpen, proposals[], measured per-card heights), and ALL graph mutations. Read paths use store selectors. The `nodes` / `edges` arrays handed to `<ReactFlow>` are recomputed via `buildFlow(turns, links, heights)` whenever the store or measurements change. Wraps everything in `<ReactFlowProvider>` so child code can use `useReactFlow`. Hosts the `ProjectsMenu`, `MapMenu`, `MemoryPanel`, `ProposalsPanel`, `RiverCtxMenu` overlay components.
- `src/CardShape.tsx` — exports `CardNode`, the React Flow custom node registered as `nodeTypes.card`. Renders user/assistant cards with serif body. The active empty user card short-circuits to `<ActiveInputCard>` (the chat input). Markdown emphasis + chip spans rendered via `renderContentBlocks` → `renderWithChipSpans`. Inline chips toggle in-place. While streaming, shows the agent's live `activity` line inline (e.g. *"searching the web · cooling fan tradeoffs"*). Cards flagged by the agent show a red **FLAGGED** badge top-right with the reason on hover. Heights are measured via `ResizeObserver` on the content element and pushed back into App's `heights` state so dagre's next pass sizes columns correctly (also catches late font loads).
- `src/CardActions.tsx` — React Context interface bridging App to deeply-nested card UI.
- `src/api.ts` — fetch wrappers: `streamGenerate` (SSE), `fetchAgentPredictions`, `fetchLabels`, `fetchMemory`, `deleteSession`, `logEvent`. Types: `ChatMessage`, `ChipSpan`, `AgentPrediction`, `AgentId`, `BranchProposal`, `CardFlag`, `CardCreation`, `LabelCard`, `GraphSnapshot`.
- `server.js` — Express. Active endpoints:
  - `POST /api/generate` — main turn through the **Managed Agent** session (skinny kickoff on reuse, full kickoff when minting a new session)
  - `POST /api/agents` — assumption / skeptic / expander pill agents in parallel (Haiku, raw Messages — must be sub-second; spinning up sessions per pill would tank latency)
  - `POST /api/labels` — batch-titles cards (Haiku, raw Messages, single round-trip; powers the map mini-map's hover label)
  - `GET /api/memory` — dumps the agent's persistent memory store as `{path: content}` JSON (uses a throwaway session to read `/mnt/memory/<store>/`)
  - `DELETE /api/session/:id` — best-effort cleanup of a Managed Agent session (called on archive ✕ and on ↻ reset session)
  - `POST /api/log` — client telemetry (events with `client.*` prefix only) → JSONL
  - `GET /api/health`
- `scripts/setup-agent.js` — provisions/updates the Managed Agent + environment + memory store. System prompt + tool list + model live here (default `claude-opus-4-7`). Custom tools registered: `get_graph_summary`, `get_card`, `create_branch`, `flag_card`, `create_card`. Re-runs are idempotent — existing IDs in `.env` get a new agent version (immutable; sessions reference latest by default). Override the model per-run with `MAIN_MODEL=… npm run setup-agent`.

## Concepts that are not obvious from the code

**The brain is a Managed Agent with one session per project.** A "project" = one canvas. The active project's session id lives at the top of the conversation store (`projectSessionId`) and persists alongside `turns`. `/api/generate` accepts `sessionId`, `pathIds`, and `responseCardId` in the request body:
- If the client passes a sessionId, the server reuses it and sends a **skinny kickoff** (`buildSkinnyKickoff`: branch path of card ids + this turn's priority constraints / chip context + the new question — ~30-100 tokens; the session's event log already has all priors).
- If no sessionId, the server mints a fresh session and sends the **full kickoff** (`buildFullKickoff`: priors rendered as text, since the new session has no event history) and emits `data:{type:"session", sessionId}` as the first SSE event so the client can persist the new id.
- The skinny path is critical for performance — without it, persistent sessions would see quadratic context blowup as each turn re-embedded the full prior history that the session log already contained.
- The kickoff also includes `BRANCH PATH` (real card ids the agent can pass to `create_branch` / `flag_card` / `create_card`) and `YOUR RESPONSE CARD: shape:xxx` (the assistant card the prose is streaming into; the natural parent for `create_card`).
- If the client's session id is stale (deleted out-of-band), the server catches the send error, mints a fresh session, swaps to the full kickoff, and retries once. No pre-flight `sessions.retrieve()` round-trip — sessions don't expire on their own.

Sessions are NOT deleted on completion; the canvas's event log + container state evolve over the project's lifetime (memory store stays attached, `/mnt/memory/river-2-memory/` survives). Agent + environment are persistent objects created once via `npm run setup-agent`; their IDs live in `.env` as `AGENT_ID` / `ENV_ID`. The agent has access to the full agent toolset (web_search, web_fetch, bash, read/write/edit/glob/grep) and the custom `get_graph_summary` / `get_card` / `create_branch` / `flag_card` / `create_card` tools.

**Multi-project: archive list + projects menu.** "+ new canvas" pushes the active state (turns + sessionId) onto `archive[]` instead of deleting — sessions hold their event log indefinitely so resuming an archived project picks up exactly where it left off. The toolbar's first button toggles a `ProjectsMenu` dropdown showing the active canvas's auto-derived name, `+ new canvas` at top, the active row with a `↻` reset-session button, and one row per archived project with click-to-resume, double-click-to-rename, and an inline ✕ that confirms then calls `deleteSession(sessionId)` server-side. After a swap, React Flow re-renders from the new `nodes` / `edges` arrays computed by `buildFlow` over the swapped-in turns — no manual canvas wipe needed. Auto-deletion is gone — every session lives until the user explicitly hits ✕. The `↻` reset-session button drops the current canvas's session (cards stay; agent's intra-session memory + container reset; next turn mints a fresh session, useful for picking up new agent versions or shedding pre-skinny kickoff bloat).

**Streaming caveat.** `agent.message` events arrive with full content blocks, not token-by-token like the raw Messages API stream. The user sees a pause while the agent thinks (and possibly searches), then the response appears in chunks. This is the documented Managed Agents wire shape, not a regression — we trade smooth token streaming for grounded answers + tool access.

**Live activity indicator during long tool calls.** Server emits `data:{type:"activity", text:"…"}` on every `agent.tool_use` and `agent.custom_tool_use` with a plain-language description (e.g. *"searching the web · cooling fan tradeoffs"*, *"creating a card on the canvas"*). Client stores it in `activity: {turnId, text}` scoped to the streaming assistant turn. CardShape reads it and renders an inline pulsing-dot status line where the cursor would otherwise sit. Cleared by the next text delta and on stream end. Makes 5-15s `web_search` waits feel deliberate instead of opaque.

**Agent-driven canvas mutations.** Three custom tools let the brain *act on* the canvas, not just stream text into it:
- **`create_branch(parent_id, prompt, rationale?)`** — proposes an unexplored direction. Server validates parent_id, forwards `data:{type:"branch_proposal", proposalId, parentId, prompt, rationale}` as SSE, ACKs the agent immediately so it never blocks. Client pushes onto ephemeral `proposals[]`; the top-right `ProposalsPanel` renders each with parent-card title + suggested prompt + dismiss/branch buttons. Accept = `createBranchUserTurn(parent_id) + runTurnFrom(newId, prompt)`. Cleared on canvas switch / + new.
- **`flag_card(card_id, reason)`** — marks a card as a turning point. Server forwards `data:{type:"card_flagged", cardId, reason}`; client calls `setAgentFlag(id, reason)` which sets emphasis=2 AND records the reason on `meta.agentFlagReason`. Card renders with a red FLAGGED badge top-right; reason on hover.
- **`create_card(parent_id, content, role?)`** — materializes a real card. Server generates the new TurnId, forwards `data:{type:"card_created", id, parentId, role, content}`, ACKs the agent with the id so it can chain (flag the card it just made, parent further cards under it). Client calls `createTurn({id, parentId, role, content})` at exactly the server-provided id so subsequent agent tool calls in this stream that reference it line up. The in-flight graph snapshot is optimistically extended server-side. Used when the user's request naturally produces multiple distinct outputs (5 project intros, 3 options, item-by-item rewrites); the streaming prose becomes a brief header card.

System prompt nudges in `setup-agent.js` set the cadence: 0–2 branch proposals per turn, 0–1 flags per turn, `create_card` only when output truly splits.

**Map menu (spatial mini-map).** The `map` toolbar button toggles a dropdown panel with an SVG mini-map of the canvas. Each card is a rect at its dagre-laid-out position (read from the React Flow `nodes` array + measured `heights`); parent→child lines connect them. Click a rect to pan the camera to that card via `useReactFlow().setCenter(...)`; hover/tap reveals the card's title in a footer (titles cached on `Turn.meta.label`, generated by `/api/labels` Haiku batch). Background label refresh runs on mount and after every `runTurnFrom`. Falls back to a content preview when no label is cached. ESC or click-outside closes.

**Memory inspector.** The `memory` toolbar button opens a modal that lists every file in the agent's persistent memory store at `/mnt/memory/<store>/` with contents. `GET /api/memory` spins up a throwaway session (read-only attachment), asks the agent to dump every file as `{path: content}` JSON, parses, and returns. Slow on demand (~5–25s; a fresh session has to read the store) but trust-building — the user can see the long-term notes the brain has accumulated about them across canvases and sessions.

**The store is canonical, React Flow is a view.** Every mutation goes through `useConversation`. App derives the React Flow `nodes` / `edges` arrays from the store + measured heights via `buildFlow` and hands them straight to `<ReactFlow>` — no separate canvas state to keep in sync. Read paths (`historyFor`, `pathIdsFor`, `getParentId`, `gatherEmphasized`) walk the graph.

**Inline chips are derived from prose, locally.** Sonnet writes plain prose with light markdown — no `[[X]]` markup. After each stream completes, `extractSpans(stripMarkdown(buffer).plain)` returns an array of `{phrase, question}` spans, written to `assistant.meta.chipSpans`. The renderer walks the unified set of (chip + bold + italic) ranges and emits nested `<strong>` / `<em>` / `<BranchChip>`. Per-sentence streaming extraction: when the buffer crosses a `. ! ?` followed by whitespace, re-run the extractor — chips appear progressively.

**Marker / highlight UX.** Tapping a chip toggles its selected state in `assistant.meta.chipsSelected[]`. Single-occurrence wrap (only the first match per phrase becomes a chip), but selection is per-card. Visually: unselected chips are *invisible* (identical to surrounding text), selected fills blue with a 2px box-shadow ring (no padding shift, so line wrapping is unaffected). Hover previews the selection at low opacity.

**Send pipeline merges sources.** When the user submits:
- typed text → user message; toggled agent pills + selected chips → `userContext` system-prompt augmentation.
- empty text + selections → selections become the user message; `userContext` is skipped to avoid duplication.
- After successful submit, `chipsSelected` clears on the source cards (selections don't quietly carry into every subsequent turn).

**Three pill agents, one pipeline.** `assumption` (lavender), `skeptic` (amber), `expander` (teal) each return ~2 predictions per turn via `/api/agents` (Haiku, parallel, raw Messages — stateless). Rendered as a single pill row above the next input. Toggling any of them adds to `predictionsToggled` on the parent assistant. Same toggle/send mechanics as in-text chips.

**Counter pill summarizes in-text selections.** When `chipSelectionCount > 0` (sum across active chain ancestors), a blue **N selected ×** pill appears in the input row. Tapping clears every chip selection across the chain.

**Layout via dagre.** `buildFlow(turns, links, heights)` in `src/graph/layout.ts` runs a dagre `rankdir: 'TB'` tidy-tree pass over the parent → children relation and returns the React Flow `{nodes, edges}` arrays. Heights come from the per-card `ResizeObserver` feedback loop; missing entries fall back to `CARD_HEIGHT_HINT` until the first measurement lands. Layout is recomputed via `useMemo` on store / heights changes.

**Card heights via ResizeObserver.** Cards measure their own height via a `ResizeObserver` on the content element and call `resizeCard(id, h)` (or `resizeActive(h)` for the active input). The new height goes into App's `heights` state, which flows back into `buildFlow` for the next layout pass. This catches initial mount, content edits, viewport changes, AND late font loads (Source Serif 4 arrives async via Google Fonts; without this the first measurement runs in the system-ui fallback and never re-fires when the serif lands taller — cards would render clipped on reload).

**No drag, no per-node selection.** React Flow is configured with `nodesDraggable={false}` and each node sets `selectable: false`. Drag = pan the canvas; cards are immovable. Card-internal interaction (chips, pills, send) handles its own pointer events.

**Mobile taps on inline elements use `pointerDown` (not `click`).** Holdover from the tldraw era where the hand tool captured the pointer at touchstart so the synthesized click on touchend often never fired. React Flow's pan handler is less aggressive but the `tap()` / `tapPointerDown()` helpers in `CardShape.tsx` keep the same approach: trigger on `pointerdown` with `stopPropagation`, applied to chips, agent pills, icon buttons, and the send button. This also avoids the click delay on touch devices.

**Persistence keys.** Zustand: `river-2-graph` (localStorage, conversation graph + archive + projectSessionId). React Flow has no persistence of its own — node positions are recomputed each render from the store via dagre. Bump the zustand key when the graph schema changes meaningfully.

**JSONL session logs.** `server.js` appends every server-side and client-side event to `./logs/YYYY-MM-DD.jsonl` (one line per event: `{ts, type, ...data}`). Server emits `generate.{start,session_created,session_lost,tool_use,custom_tool_use,end,error}`, `agents.{complete,error}`, `labels.{start,complete,error,parse_error}`, `memory.{complete,error,parse_error}`, `session.{deleted,delete_failed}`. Client posts `client.{chip_toggle,prediction_toggle,emphasis_toggle,branch,delete,start_new,send,open_map,map_jump,resume_project,delete_project,reset_session,open_memory,branch_proposal_received,proposal_accept,proposal_dismiss,card_flagged,card_created}` via `POST /api/log`. Type prefix `client.` is enforced server-side. `logs/` is gitignored.

## Design principles (saved as memories)

- **Reduce visual complexity** — invisible default states, discoverability via hover, no upfront decoration on dense interactive surfaces.
- **Familiar surface, deep structure** ("wolf im Schafspelz") — new mechanics ride on top of a UI the user already knows; complexity reveals on invocation, never upfront.

## Conventions

- React Flow edges have two custom types: `parent` (default tree edge) and `link` (cross-tree references — currently unused). Both are non-interactive — users don't draw or drag connections.
- The custom context menu uses React Flow's `onNodeContextMenu` (right-click on a card) and a fallback `onContextMenu` on the wrapping `<div>` for blank-canvas right-clicks. `<RiverCtxMenu>` reads the turn from the store via the captured `turnId`. Cards offer New conversation / Branch / Copy text / Delete.
- Inline elements inside cards (chips, agent pills, icon buttons, textarea, send button) all use `tap()` / `tapPointerDown()` from `CardShape.tsx` — `stopPropagation` on `pointerdown`, action fires immediately.
- Body fonts: Source Serif 4 (loaded from Google Fonts in `index.html`) for assistant/user card content. UI chrome (toolbar, pills, input) keeps `system-ui` sans.

## Prototype-only knobs

- `START_SEED` in `App.tsx` — pre-fills the input on a fresh canvas for fast iteration.
- `(window as any).__flow__` — dev handle on the React Flow instance, exposed in `onFlowInit`. Remove before shipping.
- `npx tsx src/graph/extractSpans.test.ts` — runs the local extractor on five sample topics (tech, cooking, history, philosophy, biology) and prints the spans. Useful when tuning coverage.
- `scratch/` — mobile screenshots from prior iterations; not used at runtime.
- `/tmp/river2-test-*.mjs` — handy ad-hoc smoke tests for the agent's custom tools (branch / flag / create_card). Not committed; recreate as needed.
