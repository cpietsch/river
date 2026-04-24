# river-2

Canvas-based chat prototype: a tldraw infinite canvas where each user/assistant turn is a card, branches are arrows, and a parallel "reflection layer" surfaces hidden assumptions next to each assistant turn. Two-process app — Vite (web) + Express (API proxy to Anthropic).

## Run

- `npm run dev` — concurrently starts Vite on the default port and the Express API on `:4000`. Vite proxies `/api/*` to the API.
- `npm run typecheck` — `tsc --noEmit`. Run before committing.
- `npm run build` — typecheck then production Vite build.
- `.env` must have `ANTHROPIC_API_KEY`. Optional: `MAIN_MODEL` (default `claude-sonnet-4-6`), `MIST_MODEL` (default `claude-haiku-4-5-20251001`), `PORT` (default 4000).

## Layout

- `src/App.tsx` — owns the editor, the conversation graph, autolayout (`relayoutAll` tidy-tree, `repositionChain` after card-height changes), reflection spawning, and the `CardActionsContext` provider.
- `src/CardShape.tsx` — custom tldraw `ShapeUtil` for `card`. Renders three roles (`user` / `assistant` / `presumption`) across two layers (`action` / `reflection`). The active empty user card renders as `<ActiveInputCard>` (the chat input itself). Pill chips inside assistant text are produced by `renderWithBranchChips` which scans for `[[term]]`.
- `src/CardActions.tsx` — React Context interface bridging App state to deeply-nested card UI without prop drilling.
- `src/api.ts` — fetch wrappers: `streamGenerate` (SSE), `fetchMist`, `fetchReflections`.
- `src/tldraw-augment.d.ts` — extends tldraw's global shape map with the `card` shape props.
- `server.js` — Express. Three endpoints: `POST /api/generate` streams the main turn (Sonnet), `POST /api/mist` returns continuation suggestions (Haiku), `POST /api/reflect` returns 3 presumptions (Haiku). Prompts live at the top.

## Concepts that are not obvious from the code

**Conversation history walks arrow bindings, not X-position.** `historyFor(leafId)` follows incoming arrow bindings upward. Branches leave the parent's column, so a positional heuristic would lose the parent assistant — the arrow graph is authoritative.

**Active card IS the chat input.** When a user card has empty content and `activeId === id`, `CardBody` short-circuits to `<ActiveInputCard>`. There is no separate input bar except the `tap "+ new" to start` hint shown when nothing is active.

**Side-flows must not steal the active input.** `runTurnFrom` captures `isFromActive = userCardId === activeId`. Only the main flow clears the input, creates a follow-up empty user card, and shifts `activeId`. Pill clicks (`branchAbout`) and reflection promotion (`promoteReflection`) call `runTurnFrom` from a non-active card — they must leave the user's main input untouched, otherwise the original empty user card loses active status and renders the empty-content fallback (`'thinking…'`) permanently.

**Visual emphasis is prompt weight.** Cards with `emphasis >= 2` (toggled by the heart icon) have their content collected by `gatherEmphasized` and prepended to the system prompt as `PRIORITY CONSTRAINTS` for the next generate call.

**Reflection layer.** Each assistant turn gets 3 presumption cards spawned to its right via `spawnPresumptions`, connected by dashed light-violet arrows (`connectReflection`). Arrows are tagged `meta: { kind: 'reflection' }`. The X-ray toggle (`reflectionsVisible`) hides the reflection layer; `syncReflectionArrows` flips arrow opacity. **Locked tldraw arrows silently reject `updateShape({opacity})`** — the helper does unlock → update → relock. The toggle effect runs once on mount before the editor exists, so `handleMount` also calls `syncReflectionArrows` directly after `editorRef.current = editor`.

**Hand tool, not select tool.** The editor is locked to the `hand` tool with a store listener that snaps it back if anything changes it. Drag = pan camera, never moves shapes. This makes cards effectively immovable without needing `isLocked` on every card (which would force unlock/relock around every autolayout `updateShape`).

**`canCull = () => false` on cards.** Without this, cards offscreen unmount their HTML container, `useLayoutEffect` reads `scrollHeight === 0`, and the height collapses to a sliver. The measurement code zero-guards anyway as defense in depth.

**Camera animation.** `editor.user.updateUserPreferences({ animationSpeed: 1 })` overrides OS reduce-motion so programmatic camera moves stay smooth. Reduced-motion users would otherwise see canvas jumps.

**Persistence.** `persistenceKey="river-2-reflection"`. Bump this when the card schema changes — adding `layer`, `emphasis`, or new role values requires it.

**Orphan-arrow sweep on mount.** Crash-recovered sessions can carry arrows whose bindings reach deleted shapes. `handleMount` walks all arrows and deletes ones with missing bind targets.

## Conventions

- Custom context menu — `components.ContextMenu = null` disables tldraw's, then we render `<RiverCtxMenu>` from a `contextmenu` handler on the outer `<div>`.
- All tldraw arrows are created with `isLocked: true` so users can't drag endpoints.
- `relayoutAll` filters out reflection-layer cards entirely; reflection layout is owned by `spawnPresumptions`.
- `repositionChain` skips reflection children for the same reason.
- Branch chips, icon buttons, and the active-input textarea/send button all `e.stopPropagation()` on `pointerDown` and `click` so tldraw never sees them.
- `touch-action: none` on `html, body, #root` (in `index.html`) — without it, React's passive synthetic touch listeners log warnings on every mobile tap from tldraw's internal `preventDefault`.

## Prototype-only knobs

- `START_SEED = 'LUCKFOX PicoKVM Base vs NanoKVM'` — pre-fills the input on a fresh session for fast iteration.
- `(window as any).__editor__` — dev handle exposed in `handleMount`. Remove before shipping.
- `scratch/` — mobile screenshots from prior iterations; not used at runtime.
