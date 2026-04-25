# river-2

Canvas-based chat prototype: a tldraw infinite canvas where each user/assistant turn is a card, branches are arrows, and assistant cards have inline phrase-chips you can mark to ride forward as context. Multi-agent perspective layer surfaces three takes (assumption / skeptic / expander) above the next user input. Two-process app — Vite (web) + Express (API proxy to Anthropic).

## Run

- `npm run dev` — concurrently starts Vite on the default port and the Express API on `:4000`. Vite proxies `/api/*` to the API.
- `npm run typecheck` — `tsc --noEmit`. Run before committing.
- `npm run build` — typecheck then production Vite build.
- `.env` must have `ANTHROPIC_API_KEY`. Optional: `MAIN_MODEL` (default `claude-sonnet-4-6`), `MIST_MODEL` (default `claude-haiku-4-5-20251001`), `PORT` (default 4000).

## Layout

### Source of truth: the conversation graph

- `src/graph/store.ts` — Zustand store (`useConversation`) with persist middleware (localStorage key `river-2-graph`). Holds `Turn` records keyed by `TurnId` (a `TLShapeId`). Mutators: `createTurn`, `setContent`, `setStreaming`, `setEmphasis`, `setChipSpans`, `setPredictions`, `togglePrediction`, `toggleChipSelected`, `clearChipsSelected`, `removeSubtree`, `reset`. Selectors: `getTurn`, `getChildren`, `getAncestors`, `getDescendants`.
- `src/graph/types.ts` — `Turn`, `TurnMeta` (chipSpans, predictions, predictionsToggled, chipsSelected), `ConversationGraph`.
- `src/graph/sync.ts` — `syncStoreToTldraw(editor)`: idempotent diff that ensures tldraw shapes mirror store turns + parent edges. Creates missing card shapes, updates drifted props, deletes orphans.
- `src/graph/useTldrawSync.ts` — React hook that subscribes the syncer to the store. Surfaces `onStructuralChange` so App can run `relayoutAll` on turn create/remove.
- `src/graph/extractSpans.ts` — local NLP-based span extractor (compromise + regex backstops). Identifies noun phrases, named entities, hyphenated compounds, acronyms, numeric quantities, and ADJ+NOUN compounds. Replaces an earlier Haiku post-process — runs synchronously in-browser, sub-millisecond per response.
- `src/graph/markdown.ts` — `stripMarkdown` (strips `**bold**` / `*italic*` markers, returns plain text + ranges) and `parseBlocks` (splits text into paragraph + table blocks).

### App + UI

- `src/App.tsx` — owns the editor ref, transient UI state (active input, busy, ctxMenu, mapText), and ALL graph mutations. Read paths use store selectors. Layout (`relayoutAll` tidy-tree, `repositionChain` after height changes) walks the graph store, not arrow bindings. Wires the `CardActionsContext` provider.
- `src/CardShape.tsx` — custom tldraw `ShapeUtil` for `card`. Renders user/assistant cards with serif body. The active empty user card short-circuits to `<ActiveInputCard>` (the chat input). Markdown emphasis + chip spans are rendered via `renderContentBlocks` → `renderWithChipSpans`. Inline chips toggle in-place (no branching).
- `src/CardActions.tsx` — React Context interface bridging App to deeply-nested card UI.
- `src/api.ts` — fetch wrappers: `streamGenerate` (SSE), `fetchAgentPredictions`. Types: `ChipSpan`, `AgentPrediction`, `AgentId`.
- `src/tldraw-augment.d.ts` — extends tldraw's global shape map.
- `server.js` — Express. Endpoints: `POST /api/generate` runs the main turn through a **Managed Agent** session (per-turn, history embedded in the kickoff message), `POST /api/summarize` runs through the **same brain agent** (`buildSummarizeKickoff` mode-shifts via the user.message; reuses the existing `get_graph_summary` / `get_card` custom tools; skips the memory store), `POST /api/mist` returns continuation suggestions (Haiku, raw Messages — must be sub-second), `POST /api/agents` runs the assumption/skeptic/expander pill agents in parallel and returns flat AgentPrediction[] tagged by agent (Haiku, raw Messages — three parallel session-creates per turn would tank latency for stateless one-shots), `POST /api/labels` batch-titles cards (Haiku, raw Messages, single round-trip; powers the map menu's tree view). `MAIN_SYSTEM_BASE` allows light markdown (`**bold**`, `*italic*`, paragraph breaks `\n\n`, comparison tables). Per-pill-agent prompts in `AGENTS` constant.
- `scripts/setup-agent.js` — one-time provisioning script. Creates the river-2 environment + brain agent (model + system prompt + agent_toolset_20260401: web_search, web_fetch, bash, read/write/edit/glob/grep) and prints `AGENT_ID` / `ENV_ID` to add to `.env`. Re-runs are idempotent — existing IDs in `.env` are verified, not re-created. Run via `npm run setup-agent`.

## Concepts that are not obvious from the code

**The brain is a Managed Agent with one session per project.** A "project" = one canvas. The active project's session id lives at the top of the conversation store (`projectSessionId`) and persists alongside `turns`. `/api/generate` accepts `sessionId` in the request body: if the client passes one and it still exists, the server reuses it; otherwise it mints a fresh session and emits a `data: {type: "session", sessionId}` SSE event so the client can persist the new id. Each turn sends one `user.message` event into the project's session — the text still embeds the linear path-to-leaf as branch framing so siblings don't bleed across in the agent's view. Sessions are NOT deleted on completion; the canvas's event log + container state evolve over the project's lifetime (memory store stays attached, `/mnt/memory/river-2-memory/` survives). Agent + environment are persistent objects created once via `npm run setup-agent`; their IDs live in `.env` as `AGENT_ID` / `ENV_ID`. The agent has access to the full agent toolset (web_search, web_fetch, bash, read/write/edit/glob/grep) and the custom `get_graph_summary` / `get_card` tools.

**Multi-project: archive list + projects menu.** "+ new canvas" pushes the active state (turns + sessionId) onto `archive[]` instead of deleting — sessions hold their event log indefinitely so resuming an archived project picks up exactly where it left off. The toolbar's first button toggles a `ProjectsMenu` dropdown showing the active canvas's auto-derived name (first user turn, truncated), `+ new canvas` at top, and one row per archived project with click-to-resume, double-click-to-rename, and an inline ✕ that confirms then calls `deleteSession(sessionId)` server-side. `repaintCanvas()` wipes tldraw shapes after a swap so the syncer rebuilds from the new turn set. Auto-deletion is gone — every session lives until the user explicitly hits ✕.

**Streaming caveat.** `agent.message` events arrive with full content blocks, not token-by-token like the raw Messages API stream. The user sees a pause while the agent thinks (and possibly searches), then the response appears in chunks. This is the documented Managed Agents wire shape, not a regression — we trade smooth token streaming for grounded answers + tool access.

**The store is canonical, tldraw is a view.** Every mutation goes through `useConversation`; the syncer hook applies diffs to tldraw shapes/arrows. Read paths (`historyFor`, `getParentId`, `gatherEmphasized`, `relayoutAll`) walk the graph. tldraw's persistence (IndexedDB) and the store's persistence (localStorage) reconcile on mount via the syncer.

**Inline chips are derived from prose, locally.** Sonnet writes plain prose with light markdown — no `[[X]]` markup. After each stream completes, `extractSpans(stripMarkdown(buffer).plain)` returns an array of `{phrase, question}` spans, written to `assistant.meta.chipSpans`. The renderer walks the unified set of (chip + bold + italic) ranges and emits nested `<strong>` / `<em>` / `<BranchChip>`. Per-sentence streaming extraction: when the buffer crosses a `. ! ?` followed by whitespace, re-run the extractor — chips appear progressively.

**Marker / highlight UX.** Tapping a chip toggles its selected state in `assistant.meta.chipsSelected[]`. Single-occurrence wrap (only the first match per phrase becomes a chip), but selection is per-card. Visually: unselected chips are *invisible* (identical to surrounding text), selected fills blue with a 2px box-shadow ring (no padding shift, so line wrapping is unaffected). Hover previews the selection at low opacity.

**Send pipeline merges sources.** When the user submits:
- typed text → user message; toggled agent pills + selected chips → `userContext` system-prompt augmentation.
- empty text + selections → selections become the user message; `userContext` is skipped to avoid duplication.
- After successful submit, `chipsSelected` clears on the source cards (selections don't quietly carry into every subsequent turn).

**Three agents, one pipeline.** `assumption` (lavender), `skeptic` (amber), `expander` (teal) each return ~2 predictions per turn; rendered as a single pill row above the next input. Toggling any of them adds to `predictionsToggled` on the parent assistant. Same toggle/send mechanics as in-text chips.

**Counter pill summarizes in-text selections.** When `chipSelectionCount > 0` (sum across active chain ancestors), a blue **N selected ×** pill appears in the input row. Tapping clears every chip selection across the chain.

**Layout is graph-driven, not arrow-driven.** `relayoutAll` reads `parent → children` from the store, computes a tidy-tree column layout, and writes `(x, y)` back to tldraw shapes. `repositionChain` walks store children when a card's measured height changes.

**Hand tool, not select tool.** The editor is locked to the `hand` tool with a store listener that snaps it back. Drag = pan, never moves shapes. Cards are immovable without per-card `isLocked` (which would force unlock/relock around every autolayout `updateShape`).

**Mobile taps on inline elements use `pointerDown` (not `click`).** tldraw's hand tool captures the pointer at touchstart, and the synthesized click on touchend often never fires. The `tap()` helper in `CardShape.tsx` triggers actions on `pointerdown` directly with `stopPropagation`. Applied to chips, agent pills, icon buttons, and the send button.

**`canCull = () => false` on cards.** Offscreen cards would unmount their HTML container; `useLayoutEffect` would read `scrollHeight === 0` and the height would collapse to a sliver.

**Camera animation override.** `editor.user.updateUserPreferences({ animationSpeed: 1 })` overrides OS reduce-motion so programmatic camera moves stay smooth.

**Persistence keys.** zustand: `river-2-graph` (localStorage, conversation graph). tldraw: `persistenceKey="river-2-graph"` (IndexedDB, shape positions). Bump both when the schema changes meaningfully.

**Branch proposals (`create_branch` custom tool).** The agent can call `create_branch(parent_id, prompt, rationale?)` to suggest an unexplored direction. Server-side, the handler in `/api/generate` validates the parent_id, forwards `data:{type:"branch_proposal", proposalId, parentId, prompt, rationale}` as an SSE event to the client, and immediately responds to the agent with `{ok:true, status:"shown to user"}` so the session keeps moving (the agent never blocks waiting for accept/dismiss). Client-side, `streamGenerate.onProposal` pushes a `BranchProposal` into the App's `proposals[]` ephemeral state. `ProposalsPanel` (top-right floating) renders each one with parent-card title + suggested prompt + rationale + dismiss/branch buttons. Accept = `createBranchUserTurn(parent_id) + runTurnFrom(newId, prompt)`; dismiss = drop from list. Proposals are NOT persisted (clear on canvas switch / + new). System prompt nudges the agent toward 0–2 proposals per turn, only for genuinely unexplored angles.

**Map menu (tree view).** The `map` toolbar button toggles a dropdown menu (`MapMenu` in `App.tsx`) anchored to the button. The menu renders the conversation graph as an indented tree — one row per card with a 3-6 word title (cached on `Turn.meta.label`, generated by `/api/labels`). User cards get a blue dot, assistant cards a faint dark dot. Click a row to pan the camera to that card. The tree comes from `buildTree()` walking the graph store; placeholder/streaming cards skip but their children promote up so the tree never has gaps. Background label refresh runs on mount and after every `runTurnFrom`, so the menu opens instantly with cached labels (falls back to a content preview when missing). ESC or click-outside closes. The earlier `/api/summarize` streaming-prose surface remains wired but is no longer surfaced in the UI.

**JSONL session logs.** `server.js` appends every server-side and client-side event to `./logs/YYYY-MM-DD.jsonl` (one line per event: `{ts, type, ...data}`). Server emits `generate.{start,session_created,tool_use,custom_tool_use,end,error}` and `agents.{complete,error}`. Client posts `client.{chip_toggle,prediction_toggle,emphasis_toggle,branch,delete,start_new,send}` via `POST /api/log`. Type prefix `client.` is enforced server-side. `logs/` is gitignored.

## Design principles (saved as memories)

- **Reduce visual complexity** — invisible default states, discoverability via hover, no upfront decoration on dense interactive surfaces.
- **Familiar surface, deep structure** ("wolf im Schafspelz") — new mechanics ride on top of a UI the user already knows; complexity reveals on invocation, never upfront.

## Conventions

- All tldraw arrows are created with `isLocked: true` so users can't drag endpoints.
- The custom context menu disables tldraw's via `components.ContextMenu = null`. `<RiverCtxMenu>` opens from a `contextmenu` handler on the outer `<div>`. Cards offer New conversation / Branch / Copy text / Delete.
- Inline elements inside cards (chips, agent pills, icon buttons, textarea, send button) all use `tap()` / `tapPointerDown()` from `CardShape.tsx` — `stopPropagation` on `pointerdown`, action fires immediately.
- `touch-action: none` on `html, body, #root` (in `index.html`) silences tldraw's preventDefault warnings; `.tl-html-container button/textarea/[role=button]` reverts to `manipulation` so taps still work.
- Body fonts: Source Serif 4 (loaded from Google Fonts in `index.html`) for assistant/user card content. UI chrome (toolbar, pills, input) keeps `system-ui` sans.

## Prototype-only knobs

- `START_SEED = 'LUCKFOX PicoKVM Base vs NanoKVM'` — pre-fills the input on a fresh session for fast iteration.
- `(window as any).__editor__` — dev handle exposed in `handleMount`. Remove before shipping.
- `npx tsx src/graph/extractSpans.test.ts` — runs the local extractor on five sample topics (tech, cooking, history, philosophy, biology) and prints the spans. Useful when tuning coverage.
- `scratch/` — mobile screenshots from prior iterations; not used at runtime.
