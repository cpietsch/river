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

- `src/App.tsx` — owns the editor ref, transient UI state (active input, busy, ctxMenu, precache toggle), and ALL graph mutations. Read paths use store selectors. Layout (`relayoutAll` tidy-tree, `repositionChain` after height changes) walks the graph store, not arrow bindings. Wires the `CardActionsContext` provider.
- `src/CardShape.tsx` — custom tldraw `ShapeUtil` for `card`. Renders user/assistant cards with serif body. The active empty user card short-circuits to `<ActiveInputCard>` (the chat input). Markdown emphasis + chip spans are rendered via `renderContentBlocks` → `renderWithChipSpans`. Inline chips toggle in-place (no branching).
- `src/CardActions.tsx` — React Context interface bridging App to deeply-nested card UI.
- `src/api.ts` — fetch wrappers: `streamGenerate` (SSE), `fetchAgentPredictions`. Types: `ChipSpan`, `AgentPrediction`, `AgentId`.
- `src/tldraw-augment.d.ts` — extends tldraw's global shape map.
- `server.js` — Express. Endpoints: `POST /api/generate` runs the main turn through a **Managed Agent** session (per-turn, history embedded in the kickoff message), `POST /api/mist` returns continuation suggestions (Haiku), `POST /api/agents` runs the assumption/skeptic/expander pill agents in parallel and returns flat AgentPrediction[] tagged by agent. `MAIN_SYSTEM_BASE` allows light markdown (`**bold**`, `*italic*`, paragraph breaks `\n\n`, comparison tables). Per-pill-agent prompts in `AGENTS` constant.
- `scripts/setup-agent.js` — one-time provisioning script. Creates the river-2 environment + brain agent (model + system prompt + agent_toolset_20260401: web_search, web_fetch, bash, read/write/edit/glob/grep) and prints `AGENT_ID` / `ENV_ID` to add to `.env`. Re-runs are idempotent — existing IDs in `.env` are verified, not re-created. Run via `npm run setup-agent`.

## Concepts that are not obvious from the code

**The brain is a Managed Agent, not a raw Messages call.** `/api/generate` creates a Managed Agent session per turn (`anthropic.beta.sessions.create`), opens an SSE stream **before** sending the kickoff, sends one `user.message` event whose text embeds the priorities, carried assumptions, prior history, and current question, then forwards `agent.message` text deltas as the existing `data: {type: 'delta', text: ...}` SSE the client expects. Sessions are deleted after the response. The agent has access to the full agent toolset (web_search, web_fetch, bash, read/write/edit/glob/grep) — it decides per turn whether to use any. Per-turn sessions (vs per-branch long-lived) keeps the conversation tree the source of truth on the client. Agent + environment are persistent objects created once via `npm run setup-agent`; their IDs live in `.env` as `AGENT_ID` / `ENV_ID`.

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
- `precache` toggle in the toolbar — when on, every turn fires background main-model calls for each chip / presumption so subsequent clicks render instantly. Off by default (costs ~6 extra Sonnet calls per turn).
- `rerun` toolbar button — re-streams every assistant in the graph using the regenerated history; useful for testing prompt changes.
- `npx tsx src/graph/extractSpans.test.ts` — runs the local extractor on five sample topics (tech, cooking, history, philosophy, biology) and prints the spans. Useful when tuning coverage.
- `scratch/` — mobile screenshots from prior iterations; not used at runtime.
