import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Tldraw,
  toRichText,
  EASINGS,
  type Editor,
  type TLShapeId,
  type TLComponents,
} from 'tldraw';
import {
  CardShapeUtil,
  CARD_WIDTH,
  CARD_HEIGHT_MIN,
  type CardShape,
} from './CardShape';
import { CardActionsContext } from './CardActions';
import {
  deleteProjectRemote,
  deleteSession,
  deleteSubtreeRemote,
  fetchAgentPredictions,
  fetchInfo,
  fetchLabels,
  fetchProjects,
  fetchProjectState,
  logEvent,
  patchProjectRemote,
  removeProposalRemote,
  streamGenerate,
  upsertTurnRemote,
  wakeProject,
  type AgentInfo,
  type ChatMessage,
  type AgentPrediction,
  type BranchProposal,
  type GraphSnapshot,
} from './api';
import { useConversation, deriveProjectName } from './graph/store';
import { useTldrawSync } from './graph/useTldrawSync';
import { syncStoreToTldraw, repositionCardLabels } from './graph/sync';
import { extractSpans } from './graph/extractSpans';
import { stripMarkdown } from './graph/markdown';
import type { TurnId } from './graph/types';

const shapeUtils = [CardShapeUtil];


const SMOOTH_CAMERA = {
  animation: { duration: 500, easing: EASINGS.easeOutCubic },
} as const;

const START_SEED = 'LUCKFOX PicoKVM Base vs NanoKVM';

const components: TLComponents = {
  ContextMenu: null,
};

interface CtxMenu {
  x: number;
  y: number;
  // Page-space (tldraw canvas) coords of the right-click — used by
  // startNewStream so a new root materializes where the user clicked.
  pageX: number;
  pageY: number;
  shape: CardShape | null;
}

const EMPTY_PREDICTIONS: AgentPrediction[] = [];
const EMPTY_TOGGLED_LABELS: string[] = [];

export function App() {
  const editorRef = useRef<Editor | null>(null);
  const [activeId, setActiveId] = useState<TurnId | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const inputWrapRef = useRef<HTMLDivElement | null>(null);
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [wakeOpen, setWakeOpen] = useState(false);
  const proposals = useConversation((s) => s.proposals);
  const [agentInfo, setAgentInfo] = useState<AgentInfo | null>(null);
  const labelInFlightRef = useRef(false);

  // Fetch agent + env identifiers once on mount; surfaced in the projects
  // menu footer (version, model, session id). Refreshed on demand if the
  // user resets / archives — for now, mount-only is enough.
  useEffect(() => {
    void fetchInfo().then((info) => {
      if (info) setAgentInfo(info);
    });
  }, []);
  // Pull stable scalar/object refs from the store, then derive everything
  // else with useMemo. zustand's useSyncExternalStore-based selectors
  // require a cached snapshot — calling .filter() / .find() inside the
  // selector returns a new array each call and triggers an infinite
  // render loop.
  const projectsList = useConversation((s) => s.projects);
  const activeProjectIdSelRaw = useConversation((s) => s.activeProjectId);
  const turnsSel = useConversation((s) => s.turns);
  const activeProjectName = useMemo(() => {
    const fromList = projectsList.find((p) => p.id === activeProjectIdSelRaw);
    if (fromList?.name && fromList.name !== 'untitled canvas') return fromList.name;
    return deriveProjectName(turnsSel);
  }, [projectsList, activeProjectIdSelRaw, turnsSel]);
  const otherProjects = useMemo(
    () => projectsList.filter((p) => p.id !== activeProjectIdSelRaw),
    [projectsList, activeProjectIdSelRaw],
  );
  const activeSessionId = useConversation((s) => s.projectSessionId);
  // Pull the wake-intent off the active project row from the projects
  // list. The list is refreshed after every PATCH (`refreshProjects`)
  // and the WS broadcasts `project_wake_intent_changed`, so this stays
  // in sync without dedicated store wiring.
  const activeWakeIntent = useMemo(
    () =>
      projectsList.find((p) => p.id === activeProjectIdSelRaw)?.wakeIntent ?? '',
    [projectsList, activeProjectIdSelRaw],
  );

  // Bridge the store onto tldraw. Whenever the conversation graph changes,
  // syncer reflects it onto the canvas. Structural changes (turn created /
  // removed) trigger relayoutAll so the tidy-tree re-flows.
  const onStructuralChange = useCallback(() => {
    const editor = editorRef.current;
    if (editor) relayoutAll(editor);
  }, []);
  useTldrawSync(editorRef, onStructuralChange);

  const handleMount = useCallback((editor: Editor) => {
    editorRef.current = editor;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__editor__ = editor;
    editor.user.updateUserPreferences({ animationSpeed: 1 });
    editor.setCurrentTool('hand');
    editor.store.listen(
      () => {
        if (editor.getCurrentToolId() !== 'hand') {
          editor.setCurrentTool('hand');
        }
      },
      { source: 'user', scope: 'session' },
    );

    // The graph store is canonical. tldraw shapes that belong to a previous
    // schema (or that orphaned mid-stream) get wiped — the syncer will
    // recreate exactly the shapes the store needs. Two passes because
    // tldraw can leave orphan arrows behind when their bound cards get
    // deleted in the same batch (the bindings disappear but the arrow
    // shapes survive into the next render).
    for (let pass = 0; pass < 2; pass++) {
      const ids = editor.getCurrentPageShapes().map((s) => s.id);
      if (ids.length === 0) break;
      editor.deleteShapes(ids);
    }

    const { turns, createTurn, getTurn } = useConversation.getState();
    const turnList = Object.values(turns);
    // Initial sync: when the store loads with persisted turns (zustand
    // persist hydrates synchronously before this point), the syncer's
    // subscribe-only model never fires — nothing has changed. Without
    // this manual flush, persisted turns sit in the store with no
    // matching tldraw shapes, and the canvas reads as empty.
    if (turnList.length > 0) {
      syncStoreToTldraw(editor);
      relayoutAll(editor);
    }
    if (turnList.length === 0) {
      const id = createTurn({ role: 'user', parentId: null });
      setActiveId(id);
      setInput(START_SEED);
      // Center horizontally on the seed card, leaving room above for tools.
      editor.setCamera(
        { x: CARD_WIDTH / 2, y: 180 + CARD_HEIGHT_MIN / 2, z: 1 },
        { animation: { duration: 0 } },
      );
    } else {
      // Resume on the most recently empty user turn (the active input). If
      // none, fall back to whatever turn comes last.
      const lastEmptyUser = [...turnList]
        .reverse()
        .find((t) => t.role === 'user' && t.content.trim() === '');
      const fallback = turnList[turnList.length - 1];
      const targetId = lastEmptyUser?.id ?? fallback?.id ?? null;
      setActiveId(targetId);
      // Camera to wherever the resume target sits on the canvas.
      if (targetId) {
        const t = getTurn(targetId);
        if (t) {
          const shape = editor.getShape(targetId) as unknown as CardShape | undefined;
          if (shape) {
            editor.centerOnPoint(
              { x: shape.x + CARD_WIDTH / 2, y: shape.y + CARD_HEIGHT_MIN / 2 },
              { animation: { duration: 0 } },
            );
          }
        }
      }
    }
  }, []);

  // ── store-backed read selectors (imperative, called inside callbacks) ──

  const historyFor = useCallback((leafId: TurnId | null): ChatMessage[] => {
    if (!leafId) return [];
    return useConversation
      .getState()
      .getAncestors(leafId)
      .filter((t) => t.content.trim() !== '')
      .map((t) => ({ role: t.role, content: t.content }));
  }, []);

  // Path of card ids from root → leaf for the active branch, used by skinny
  // kickoffs to tell the agent which thread to focus on (without re-sending
  // the full prior text the persistent session already has as events).
  const pathIdsFor = useCallback((leafId: TurnId | null): TurnId[] => {
    if (!leafId) return [];
    return useConversation
      .getState()
      .getAncestors(leafId)
      .filter((t) => t.content.trim() !== '')
      .map((t) => t.id);
  }, []);

  const getParentId = useCallback((childId: TurnId): TurnId | null => {
    return useConversation.getState().getTurn(childId)?.parentId ?? null;
  }, []);

  const gatherEmphasized = useCallback((): string[] => {
    return Object.values(useConversation.getState().turns)
      .filter((t) => (t.emphasis ?? 1) >= 2 && t.content.trim() !== '')
      .map((t) => t.content.trim());
  }, []);

  // Snapshot of the full conversation graph the server passes to the brain's
  // custom tools (get_graph_summary, get_card). Only structural fields —
  // skip streaming turns and chip-span/prediction meta. Empty turns are
  // dropped so half-written cards don't appear in the agent's view.
  const buildGraphSnapshot = useCallback((): GraphSnapshot => {
    const all = useConversation.getState().turns;
    const out: Record<string, GraphSnapshot['turns'][string]> = {};
    for (const t of Object.values(all)) {
      if (t.streaming) continue;
      if (!t.content.trim()) continue;
      out[t.id] = {
        id: t.id,
        role: t.role,
        parentId: t.parentId ?? null,
        content: t.content,
        emphasis: t.emphasis ?? 1,
      };
    }
    return { turns: out };
  }, []);

  // Mobile keyboard offset.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const delta = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty('--kbd-offset', `${delta}px`);
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  // Toggle an inline [[term]] chip's selected state on its source card. The
  // chip stays in-place; on submit, every selected chip across the active
  // chain's ancestors rides forward as userContext (or as the user message
  // when no text is typed).
  const toggleChipSelected = useCallback(
    (cardId: TurnId, term: string) => {
      useConversation.getState().toggleChipSelected(cardId, term.trim());
      logEvent('client.chip_toggle', { cardId, term: term.trim() });
    },
    [],
  );

  // Gather every selected chip across the active chain — `full` for each
  // comes from that source card's chipSpans entry (the contextual question).
  const gatherSelectedChips = useCallback(
    (leafId: TurnId): { full: string; cardId: TurnId; term: string }[] => {
      const ancestors = useConversation.getState().getAncestors(leafId);
      const out: { full: string; cardId: TurnId; term: string }[] = [];
      for (const t of ancestors) {
        const sel = t.meta.chipsSelected ?? [];
        if (sel.length === 0) continue;
        const spans = t.meta.chipSpans ?? [];
        for (const term of sel) {
          const span = spans.find((s) => s.phrase === term);
          const full = (span?.question ?? term).trim();
          if (full) out.push({ full, cardId: t.id, term });
        }
      }
      return out;
    },
    [],
  );

  // Background label fill: walks the graph for cards lacking a label and
  // batch-fetches one Haiku-generated title per card. Single in-flight at a
  // time (labelInFlightRef). The map menu reads from the cache; this keeps
  // it warm so opens are instant.
  const refreshLabels = useCallback(async () => {
    if (labelInFlightRef.current) return;
    const turns = useConversation.getState().turns;
    const cards = Object.values(turns)
      .filter(
        (t) =>
          !t.streaming &&
          !t.meta.label &&
          t.content.trim().length > 0,
      )
      .map((t) => ({ id: t.id, role: t.role, content: t.content }));
    if (cards.length === 0) return;
    labelInFlightRef.current = true;
    try {
      const labels = await fetchLabels(cards);
      const setLabel = useConversation.getState().setLabel;
      for (const [id, label] of Object.entries(labels)) {
        setLabel(id as TurnId, label);
      }
    } finally {
      labelInFlightRef.current = false;
    }
  }, []);

  // Initial fill on mount: any persisted-but-unlabeled cards get titled in
  // the background while the user catches their breath. Also drop any
  // persisted branch proposals + links whose endpoints no longer exist
  // (deleted out from under them while the canvas was closed).
  useEffect(() => {
    void refreshLabels();
    useConversation.getState().pruneStaleProposals();
    useConversation.getState().pruneStaleLinks();
  }, [refreshLabels]);

  // Phase 0c: server-side canvas sync on mount. Two phases:
  //   1. If the server doesn't yet know about this project (and any
  //      archived projects), POST /api/migrate to seed it from the
  //      client's persisted localStorage state.
  //   2. Fetch the active project's canonical state from the server and
  //      merge it into the local store (server wins on overlap; local-
  //      only turns survive). This is how the user sees agent mutations
  //      that happened while they were closed (or in another tab once
  //      Phase 0d adds WebSocket broadcasts).
  // Phase 0d: WebSocket subscription to the active project's channel. The
  // server broadcasts every mutation it persists — agent-emitted (via
  // /api/generate's tool resolvers) and user-emitted (via the per-mutation
  // endpoints). Other tabs / devices / the future background worker push
  // changes through this channel and the local store catches them up.
  // (activeProjectIdSelRaw is already pulled above; reuse for the WS
  // subscription effect.)
  useEffect(() => {
    const projectId = activeProjectIdSelRaw;
    if (!projectId) return;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws/projects/${encodeURIComponent(projectId)}`);
    ws.onmessage = (e) => {
      let msg: { type?: string } & Record<string, unknown>;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      const store = useConversation.getState();
      switch (msg.type) {
        case 'subscribed':
          logEvent('client.ws_subscribed', { projectId });
          return;
        case 'turn_upsert': {
          const t = (msg as { turn?: { id: string; role: 'user' | 'assistant'; content: string; parentId: string | null; emphasis: number; streaming: boolean; meta?: Record<string, unknown> } }).turn;
          if (!t || !t.id) return;
          store.upsertTurnFromRemote({
            id: t.id as TurnId,
            role: t.role,
            content: t.content,
            parentId: (t.parentId ?? null) as TurnId | null,
            emphasis: t.emphasis,
            streaming: t.streaming,
            meta: (t.meta ?? {}) as import('./graph/types').TurnMeta,
          });
          return;
        }
        case 'subtree_deleted': {
          const root = (msg as { rootId?: string }).rootId;
          if (root) store.removeSubtree(root as TurnId);
          return;
        }
        case 'link_added': {
          const l = (msg as { link?: { id: string; fromId: string; toId: string; kind: string } }).link;
          if (!l) return;
          store.addLink({
            id: l.id,
            fromId: l.fromId as TurnId,
            toId: l.toId as TurnId,
            kind: l.kind,
          });
          return;
        }
        case 'link_deleted': {
          const id = (msg as { linkId?: string }).linkId;
          if (id) store.removeLink(id);
          return;
        }
        case 'proposal_added': {
          const p = (msg as { proposal?: { id: string; parentId: string; prompt: string; rationale?: string } }).proposal;
          if (!p) return;
          store.addProposal({
            proposalId: p.id,
            parentId: p.parentId,
            prompt: p.prompt,
            rationale: p.rationale ?? '',
          });
          return;
        }
        case 'proposal_removed': {
          const id = (msg as { proposalId?: string }).proposalId;
          if (id) store.removeProposal(id);
          return;
        }
        case 'project_session_changed': {
          const sid = (msg as { sessionId?: string | null }).sessionId ?? null;
          store.setProjectSessionId(sid);
          return;
        }
        // project_renamed / project_deleted matter for archived rows the
        // user has cached locally; ignore for the active project (they
        // can't be renamed/deleted while you're inside them).
        default:
          return;
      }
    };
    ws.onerror = () => {
      // The CONNECTING-then-cleanup path (React StrictMode double-mount in
      // dev) fires this with no real underlying error. Only log when the
      // socket was actually open — a real error mid-session.
      if (ws.readyState === WebSocket.OPEN) {
        logEvent('client.ws_error', { projectId });
      }
    };
    return () => {
      // If the handshake hasn't completed yet, queue the close for after
      // open so we don't trip the browser's "closed before connection
      // established" warning. Common in dev under React StrictMode.
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.addEventListener(
          'open',
          () => {
            try {
              ws.close();
            } catch (_) {
              // ignore
            }
          },
          { once: true },
        );
      } else if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.close();
        } catch (_) {
          // ignore
        }
      }
    };
  }, [activeProjectIdSelRaw]);

  // Mount-time bootstrap is defined later (after refreshProjects /
  // switchToProject are declared) — see the useEffect below.

  const runTurnFrom = useCallback(
    async (
      userTurnId: TurnId,
      text: string,
      opts: { skipUserContext?: boolean; activate?: boolean } = {},
    ) => {
      const editor = editorRef.current;
      const store = useConversation.getState();
      if (!editor || busy) return;
      // `activate` is the explicit override: callers like acceptProposal
      // want full active-leaf treatment (follow-up input card, camera pan)
      // even though the user's activeId is still pointing somewhere else
      // when this runs. Default falls back to the implicit "user is on
      // this leaf" check used by handleSubmit.
      const isFromActive = opts.activate ?? userTurnId === activeId;

      setBusy(true);
      if (isFromActive) {
        setInput('');
        // Make activeId reflect this turn so renders during/after the
        // stream see consistent state (CardActionsContext reads activeId
        // for the input-card short-circuit, etc).
        if (activeId !== userTurnId) setActiveId(userTurnId);
      }

      // Commit user text + create assistant child via the store. The syncer
      // will materialize them as tldraw shapes; relayoutAll positions them.
      store.setContent(userTurnId, text, { streaming: false });
      const assistantId = store.createTurn({
        role: 'assistant',
        parentId: userTurnId,
        streaming: true,
      });

      try {
        const history = historyFor(userTurnId);
        const emphasized = gatherEmphasized();
        const branchParentId = getParentId(userTurnId);

        // userContext rides forward into the system prompt as "the user is
        // carrying these implicit assumptions". Two sources merge:
        //  - toggled agent pills on the parent assistant
        //  - selected inline chips across the active chain's ancestors
        // Skipped when those same items already form the user message
        // (send-with-empty-input case); otherwise the LLM sees them twice.
        let userContext: string[] = [];
        const selectedChips = isFromActive
          ? gatherSelectedChips(userTurnId)
          : [];
        if (isFromActive && !opts.skipUserContext) {
          if (branchParentId) {
            const parent = store.getTurn(branchParentId);
            const toggled = new Set(parent?.meta.predictionsToggled ?? []);
            const refl = parent?.meta.predictions ?? [];
            userContext = refl
              .filter((p) => toggled.has(p.label.trim()))
              .map((p) => p.full.trim())
              .filter((s) => s.length > 0);
          }
          for (const c of selectedChips) userContext.push(c.full);
        }

        let buffer = '';
        {
          // Re-run the local extractor whenever a sentence ends so chips
          // appear progressively as the response is read, instead of all at
          // once when the stream finishes. extractSpans on a few-hundred-
          // char buffer is sub-millisecond.
          let lastSentenceEnd = 0;
          await streamGenerate(
            text,
            history.slice(0, -1),
            (delta) => {
              buffer += delta;
              // First text chunk after a tool — clear the activity line so
              // the prose takes over the streaming card cleanly. Subsequent
              // tools will set it again, this clears it again. Natural
              // alternation as the agent flips between tools and prose.
              const cur = useConversation.getState().activity;
              if (cur && cur.turnId === assistantId) {
                useConversation.getState().setActivity(null);
              }
              useConversation
                .getState()
                .setContent(assistantId, buffer, { streaming: true });
              const trail = buffer.slice(lastSentenceEnd);
              const m = trail.match(/^[\s\S]*[.!?](?:\s|$)/);
              if (m) {
                lastSentenceEnd += m[0].length;
                const spans = extractSpans(stripMarkdown(buffer.slice(0, lastSentenceEnd)).plain);
                if (spans.length > 0) {
                  useConversation
                    .getState()
                    .setChipSpans(assistantId, spans);
                }
              }
            },
            {
              emphasized,
              userContext,
              graph: buildGraphSnapshot(),
              sessionId: useConversation.getState().projectSessionId,
              projectId: useConversation.getState().activeProjectId,
              pathIds: pathIdsFor(userTurnId),
              responseCardId: assistantId,
              onSessionId: (id) => {
                if (
                  useConversation.getState().projectSessionId !== id
                ) {
                  useConversation.getState().setProjectSessionId(id);
                }
              },
              onActivity: (text) => {
                useConversation
                  .getState()
                  .setActivity({ turnId: assistantId, text });
              },
              onCardFlag: (f) => {
                logEvent('client.card_flagged', {
                  cardId: f.cardId,
                  reason: f.reason,
                });
                useConversation
                  .getState()
                  .setAgentFlag(f.cardId as TurnId, f.reason);
              },
              onCardCreated: (c) => {
                logEvent('client.card_created', {
                  id: c.id,
                  parentId: c.parentId,
                  role: c.role,
                  contentLen: c.content.length,
                });
                // Materialize the agent's card at exactly the server-
                // generated id so subsequent agent tool calls in this
                // stream that reference the id (flag_card, further
                // create_card with this as parent_id) line up.
                useConversation.getState().createTurn({
                  id: c.id as TurnId,
                  role: c.role,
                  parentId: c.parentId as TurnId,
                  content: c.content,
                  meta: c.meta?.label ? { label: c.meta.label } : undefined,
                });
              },
              onCardOptions: (o) => {
                logEvent('client.card_options', {
                  cardId: o.cardId,
                  count: o.options.length,
                });
                useConversation
                  .getState()
                  .setCardOptions(o.cardId as TurnId, o.options);
              },
              onCardEdited: (e) => {
                logEvent('client.card_edited', {
                  cardId: e.cardId,
                  contentLen: e.content.length,
                });
                // Replace content; chip spans on the prior text are now
                // stale, so re-derive against the new prose.
                useConversation
                  .getState()
                  .setContent(e.cardId as TurnId, e.content, {
                    streaming: false,
                  });
                const fresh = extractSpans(stripMarkdown(e.content).plain);
                useConversation
                  .getState()
                  .setChipSpans(e.cardId as TurnId, fresh);
              },
              onCardLinked: (l) => {
                logEvent('client.card_linked', {
                  linkId: l.linkId,
                  fromId: l.fromId,
                  toId: l.toId,
                  kind: l.kind,
                });
                useConversation.getState().addLink({
                  id: l.linkId,
                  fromId: l.fromId as TurnId,
                  toId: l.toId as TurnId,
                  kind: l.kind,
                });
              },
              onProposal: (p) => {
                logEvent('client.branch_proposal_received', {
                  proposalId: p.proposalId,
                  parentId: p.parentId,
                });
                useConversation.getState().addProposal(p);
              },
            },
          );
          useConversation
            .getState()
            .setContent(assistantId, buffer, { streaming: false });
        }

        // Stream succeeded — chip selections fed forward, so clear them on
        // every source card. Pills the user toggled would otherwise quietly
        // ride into every subsequent turn until manually deselected.
        if (isFromActive && selectedChips.length > 0) {
          const seen = new Set<TurnId>();
          for (const c of selectedChips) {
            if (seen.has(c.cardId)) continue;
            seen.add(c.cardId);
            useConversation.getState().clearChipsSelected(c.cardId);
          }
        }

        if (isFromActive) {
          const nextId = useConversation.getState().createTurn({
            role: 'user',
            parentId: assistantId,
          });
          setActiveId(nextId);
          // Mirror to server so a second tab on this project sees the
          // empty input card too (without this fix, it'd just sit
          // client-side and the other tab would see the agent reply
          // hanging with no follow-up input slot).
          void upsertTurnRemote(useConversation.getState().activeProjectId, {
            id: nextId,
            role: 'user',
            content: '',
            parentId: assistantId,
            emphasis: 1,
            streaming: false,
            meta: {},
          });

          // Camera follows the just-finished assistant + the new empty input.
          // Read positions from the (now-synced) tldraw shapes.
          const assistantShape = editor.getShape(assistantId) as unknown as
            | CardShape
            | undefined;
          const nextShape = editor.getShape(nextId) as unknown as
            | CardShape
            | undefined;
          if (assistantShape && nextShape) {
            const inputH = inputWrapRef.current?.offsetHeight ?? 140;
            const viewportH =
              window.visualViewport?.height ?? window.innerHeight ?? 800;
            const zoom = editor.getCamera().z || 1;
            const desiredScreenY = Math.max(140, viewportH - inputH - 120);
            const shift = (viewportH / 2 - desiredScreenY) / zoom;
            editor.centerOnPoint(
              {
                x: assistantShape.x + CARD_WIDTH / 2,
                y: nextShape.y + CARD_HEIGHT_MIN / 2 + shift,
              },
              SMOOTH_CAMERA,
            );
          }
        }

        // Chip spans (local): compromise NLP + regex backstops identify
        // selectable phrases (noun phrases, named entities, hyphenated
        // compounds, acronyms, numeric quantities) directly in the browser.
        // Synchronous — chips render instantly when the stream finishes.
        const spans = extractSpans(stripMarkdown(buffer).plain);
        if (spans.length > 0) {
          useConversation.getState().setChipSpans(assistantId, spans);
        }

        // Reflections (Haiku) — populates assistant.meta.predictions, which
        // ActiveInputCard renders as the pill row.
        const fullHistory = [
          ...history,
          { role: 'assistant' as const, content: buffer },
        ];
        fetchAgentPredictions(fullHistory)
          .then((predictions) => {
            useConversation.getState().setPredictions(assistantId, predictions);
          })
          .catch(() => {});

        // Background-fill map labels for any cards that lack one (the new
        // user + assistant pair, plus anything from prior turns the user
        // skipped). Fire-and-forget — the map menu reads from the cache.
        void refreshLabels();
      } catch (err) {
        console.error('generate failed', err);
        useConversation
          .getState()
          .setContent(
            assistantId,
            `[error: ${(err as Error).message}]`,
            { streaming: false },
          );
      } finally {
        setBusy(false);
        // Stream's done — clear any lingering activity for this turn so
        // the card doesn't leave a stale "searching the web…" hint.
        const cur = useConversation.getState().activity;
        if (cur && cur.turnId === assistantId) {
          useConversation.getState().setActivity(null);
        }
      }
    },
    [
      busy,
      activeId,
      historyFor,
      pathIdsFor,
      gatherEmphasized,
      getParentId,
      gatherSelectedChips,
      buildGraphSnapshot,
      refreshLabels,
    ],
  );

  const handleSubmit = useCallback(
    async (overrideText?: string) => {
      if (!activeId) return;
      let text = (overrideText ?? input).trim();
      let usedSelectionsAsMessage = false;
      // Empty input is allowed if at least one selection (toggled pill OR
      // selected chip) exists. Their `full` sentences become the user
      // message; userContext is skipped to avoid duplication.
      if (!text) {
        const parts: string[] = [];
        const parentId = getParentId(activeId);
        if (parentId) {
          const parent = useConversation.getState().getTurn(parentId);
          const toggled = new Set(parent?.meta.predictionsToggled ?? []);
          const refl = parent?.meta.predictions ?? [];
          for (const p of refl.filter((p) => toggled.has(p.label.trim()))) {
            parts.push(p.full.trim());
          }
        }
        for (const c of gatherSelectedChips(activeId)) parts.push(c.full);
        if (parts.length > 0) {
          text = parts.filter((s) => s.length > 0).join(' ');
          usedSelectionsAsMessage = true;
        }
        if (!text) return;
      }

      // Capture the shape of this send for analytics: how often does the user
      // type vs. ride pills/chips forward, how many selections, how many
      // emphasized ancestors are in flight.
      const parentId = getParentId(activeId);
      const togglesCount = parentId
        ? (useConversation.getState().getTurn(parentId)?.meta.predictionsToggled ?? []).length
        : 0;
      const chipCount = gatherSelectedChips(activeId).length;
      const emphasizedCount = gatherEmphasized().length;
      logEvent('client.send', {
        userTurnId: activeId,
        textLen: text.length,
        usedSelectionsAsMessage,
        toggledPredictions: togglesCount,
        selectedChips: chipCount,
        emphasized: emphasizedCount,
      });

      await runTurnFrom(activeId, text, {
        skipUserContext: usedSelectionsAsMessage,
      });
    },
    [activeId, input, runTurnFrom, getParentId, gatherSelectedChips, gatherEmphasized],
  );

  // Start a NEW stream on the current canvas — a parentId=null user input
  // sitting parallel to existing trees rather than branching off any card.
  // Lets the user open a fresh investigation without losing the work
  // already on the board. Optional pageX/pageY (in tldraw page coords) places
  // the new root where the user right-clicked; otherwise defaults to the
  // right of the rightmost existing tree.
  const startNewStream = useCallback(
    (pageX?: number, pageY?: number) => {
      const editor = editorRef.current;
      if (!editor) return null;
      const store = useConversation.getState();
      const projectId = store.activeProjectId;
      if (!projectId) return null;
      // Discard a previously-active empty user card (same orphan-cleanup
      // rule as branchFrom). Without this, opening "new stream here" on a
      // fresh canvas leaves the original empty input dangling alongside
      // the new one.
      if (activeId) {
        const current = store.getTurn(activeId);
        if (current && current.role === 'user' && current.content.trim() === '') {
          store.removeSubtree(activeId);
          void deleteSubtreeRemote(projectId, activeId);
        }
      }
      const newId = useConversation
        .getState()
        .createTurn({ role: 'user', parentId: null });
      void upsertTurnRemote(projectId, {
        id: newId,
        role: 'user',
        content: '',
        parentId: null,
        emphasis: 1,
        streaming: false,
        meta: {},
      });
      // Pre-position the new root before relayoutAll runs so its subtree
      // anchors at the chosen spot. If no coords were passed, place to the
      // right of every existing card so trees don't overlap.
      let x = pageX;
      let y = pageY;
      if (x === undefined || y === undefined) {
        const allShapes = editor.getCurrentPageShapes() as unknown as CardShape[];
        const maxRight = allShapes.reduce(
          (m, s) => Math.max(m, s.x + (s.props?.w ?? CARD_WIDTH)),
          -Infinity,
        );
        x = isFinite(maxRight) ? maxRight + CARD_GAP_X * 2 : 0;
        y = 0;
      }
      const shape = editor.getShape(newId) as unknown as CardShape | undefined;
      if (shape) {
        editor.updateShape({ id: newId, type: 'card', x, y });
      }
      setActiveId(newId);
      logEvent('client.new_stream', { newId });
      editor.centerOnPoint(
        { x: x + CARD_WIDTH / 2, y: y + CARD_HEIGHT_MIN / 2 },
        SMOOTH_CAMERA,
      );
      return newId;
    },
    [activeId],
  );

  // Branching: createTurn under sourceId; the syncer wires up the arrow.
  const createBranchUserTurn = useCallback((sourceId: TurnId): TurnId | null => {
    const store = useConversation.getState();
    if (!store.getTurn(sourceId)) return null;
    const newId = store.createTurn({ role: 'user', parentId: sourceId });
    // Mirror the empty user turn server-side so a different device sees
    // the new branch on next fetch even if the user doesn't type yet.
    void upsertTurnRemote(store.activeProjectId, {
      id: newId,
      role: 'user',
      content: '',
      parentId: sourceId,
      emphasis: 1,
      streaming: false,
      meta: {},
    });
    // Camera follows after layout settles (sync happens synchronously).
    const editor = editorRef.current;
    if (editor) {
      const shape = editor.getShape(newId) as unknown as CardShape | undefined;
      if (shape) {
        editor.centerOnPoint(
          { x: shape.x + CARD_WIDTH / 2, y: shape.y + CARD_HEIGHT_MIN / 2 },
          SMOOTH_CAMERA,
        );
      }
    }
    return newId;
  }, []);

  const branchFrom = useCallback(
    (turnId: TurnId) => {
      // Discard a previously-active empty branch input before opening the
      // new one. Without this, clicking + on a sequence of cards leaves a
      // trail of orphaned empty user turns dangling in the tree.
      const store = useConversation.getState();
      if (activeId && activeId !== turnId) {
        const current = store.getTurn(activeId);
        if (current && current.role === 'user' && current.content.trim() === '') {
          const projectId = store.activeProjectId;
          store.removeSubtree(activeId);
          void deleteSubtreeRemote(projectId, activeId);
        }
      }
      const newId = createBranchUserTurn(turnId);
      if (newId) {
        setActiveId(newId);
        logEvent('client.branch', { fromId: turnId, newId });
        // Refresh predictions for the source card. A card's stored
        // predictions are frozen at the moment it originally streamed; if
        // the user branches off an older card mid-conversation those pills
        // would be stale. Re-run /api/agents with the chain ending at
        // turnId so the active input shows pills tailored to *this*
        // branching point. Fire-and-forget — the input subscribes to the
        // store and re-renders when predictions land.
        const history = historyFor(turnId);
        if (history.length > 0) {
          fetchAgentPredictions(history)
            .then((predictions) => {
              useConversation.getState().setPredictions(turnId, predictions);
            })
            .catch(() => {});
        }
      }
    },
    [activeId, createBranchUserTurn, historyFor],
  );

  // Tap-to-submit for option pills the agent attached to a card via
  // present_options. The pill text is the literal next user message —
  // pushes it through the same handleSubmit path the typed input uses,
  // so any user-side toggled pills / selected chips merge in exactly as
  // if the user had typed and hit send. Clears the options on the
  // source card after picking so the chosen pill (now visible as a
  // proper user turn) becomes the only record.
  const pickOption = useCallback(
    (cardId: TurnId, text: string) => {
      if (!text.trim()) return;
      logEvent('client.option_picked', { cardId, text });
      useConversation.getState().setCardOptions(cardId, []);
      void handleSubmit(text);
    },
    [handleSubmit],
  );

  const acceptProposal = useCallback(
    (p: BranchProposal) => {
      // Don't accept while another turn is streaming: runTurnFrom would
      // early-return on its `busy` guard, leaving the empty user card we
      // created here orphaned with no prompt and no assistant child.
      // Keep the proposal in the panel so the user can re-click once the
      // current stream lands.
      if (busy) return;
      const projectId = useConversation.getState().activeProjectId;
      const turn = useConversation.getState().getTurn(p.parentId as TurnId);
      if (!turn) {
        // Parent gone (rare — user deleted the card mid-stream). Drop it.
        useConversation.getState().removeProposal(p.proposalId);
        void removeProposalRemote(projectId, p.proposalId);
        return;
      }
      const newId = createBranchUserTurn(p.parentId as TurnId);
      if (!newId) return;
      logEvent('client.proposal_accept', {
        proposalId: p.proposalId,
        parentId: p.parentId,
      });
      useConversation.getState().removeProposal(p.proposalId);
      void removeProposalRemote(projectId, p.proposalId);
      // Treat as if the user is on this new branch: clears input, creates
      // a follow-up empty user turn after the stream completes, pans the
      // camera. Without `activate`, runTurnFrom's "is this the active
      // leaf?" check fails and the new branch ends with the agent's reply
      // and no input card to continue from.
      void runTurnFrom(newId, p.prompt, {
        skipUserContext: true,
        activate: true,
      });
    },
    [busy, createBranchUserTurn, runTurnFrom],
  );

  const dismissProposal = useCallback((proposalId: string) => {
    logEvent('client.proposal_dismiss', { proposalId });
    const projectId = useConversation.getState().activeProjectId;
    useConversation.getState().removeProposal(proposalId);
    void removeProposalRemote(projectId, proposalId);
  }, []);

  const togglePrediction = useCallback(
    (p: AgentPrediction) => {
      if (!activeId) return;
      const parentId = getParentId(activeId);
      if (!parentId) return;
      useConversation.getState().togglePrediction(parentId, p.label.trim());
      logEvent('client.prediction_toggle', {
        parentId,
        agent: p.agent,
        label: p.label.trim(),
      });
    },
    [activeId, getParentId],
  );

  const toggleEmphasis = useCallback((id: TurnId) => {
    const t = useConversation.getState().getTurn(id);
    if (!t) return;
    const next = (t.emphasis ?? 1) >= 2 ? 1 : 2;
    useConversation.getState().setEmphasis(id, next);
    logEvent('client.emphasis_toggle', { id, emphasis: next });
    void upsertTurnRemote(useConversation.getState().activeProjectId, {
      id,
      role: t.role,
      content: t.content,
      parentId: t.parentId,
      emphasis: next,
      streaming: t.streaming,
      meta: t.meta as Record<string, unknown>,
    });
  }, []);

  const deleteCard = useCallback(
    (turnId: TurnId) => {
      const projectId = useConversation.getState().activeProjectId;
      const removed = new Set(
        useConversation.getState().removeSubtree(turnId),
      );
      logEvent('client.delete', { turnId, removedCount: removed.size });
      void deleteSubtreeRemote(projectId, turnId);
      if (activeId && removed.has(activeId)) {
        // Re-seat active on the most recent empty user turn, or last turn.
        const turns = Object.values(useConversation.getState().turns);
        const lastEmpty = [...turns]
          .reverse()
          .find((t) => t.role === 'user' && t.content.trim() === '');
        const latest = turns[turns.length - 1];
        setActiveId(lastEmpty?.id ?? latest?.id ?? null);
      }
    },
    [activeId],
  );

  // Wipe tldraw shapes so the syncer rebuilds from the freshly-swapped
  // store turns. Used when starting a new canvas, resuming an archived one,
  // or otherwise replacing the active turn set wholesale.
  const repaintCanvas = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    // Two-pass nuke. tldraw can leave orphan arrows behind when their
    // bound cards are deleted in the same batch — the bindings disappear
    // but the arrow shapes themselves survive into the next render.
    // Delete shapes, then re-query and delete anything still on the page
    // before letting the syncer recreate from the store.
    for (let pass = 0; pass < 2; pass++) {
      const ids = editor.getCurrentPageShapes().map((s) => s.id);
      if (ids.length === 0) break;
      editor.deleteShapes(ids);
    }
    syncStoreToTldraw(editor);
    relayoutAll(editor);
  }, []);

  // Refresh the global server-side project list. Called on mount and
  // after any mutation that changes the list (create / delete / rename).
  const refreshProjects = useCallback(async () => {
    const list = await fetchProjects();
    useConversation.getState().setProjects(list);
    return list;
  }, []);

  // Switch the tab to a different project: clear the active canvas,
  // flip activeProjectId, fetch the new state from the server, repaint
  // tldraw. The WS subscription effect re-runs on activeProjectId
  // change and resubscribes to the new project's channel.
  const switchToProject = useCallback(
    async (projectId: string) => {
      const editor = editorRef.current;
      if (!editor) return;
      logEvent('client.switch_project', { projectId });
      useConversation.getState().setActiveProjectId(projectId);
      useConversation.getState().clearActiveCanvas();
      const state = await fetchProjectState(projectId);
      if (state) {
        useConversation.getState().loadActiveCanvas({
          turns: Object.fromEntries(
            state.turns.map((t) => [
              t.id,
              {
                id: t.id as TurnId,
                role: t.role,
                content: t.content,
                parentId: (t.parentId ?? null) as TurnId | null,
                emphasis: t.emphasis,
                streaming: t.streaming,
                meta: t.meta as import('./graph/types').TurnMeta,
              },
            ]),
          ),
          links: state.links.map((l) => ({
            id: l.id,
            fromId: l.fromId as TurnId,
            toId: l.toId as TurnId,
            kind: l.kind,
          })),
          proposals: state.proposals.map((p) => ({
            proposalId: p.id,
            parentId: p.parentId,
            prompt: p.prompt,
            rationale: p.rationale,
          })),
          projectSessionId: state.project.sessionId,
        });
      }
      // Re-seat active on the most recent empty user turn (the input
      // slot) if present, else the most recent turn.
      const turns = Object.values(useConversation.getState().turns);
      const lastEmpty = [...turns]
        .reverse()
        .find((t) => t.role === 'user' && t.content.trim() === '');
      const fallback = turns[turns.length - 1];
      const targetId = lastEmpty?.id ?? fallback?.id ?? null;
      setActiveId(targetId);
      setInput('');
      repaintCanvas();
      if (targetId) {
        const shape = editor.getShape(targetId) as unknown as
          | CardShape
          | undefined;
        if (shape) {
          editor.centerOnPoint(
            { x: shape.x + CARD_WIDTH / 2, y: shape.y + shape.props.h / 2 },
            SMOOTH_CAMERA,
          );
        }
      }
    },
    [repaintCanvas],
  );

  // Create a new canvas. Server provisions a fresh per-project agent;
  // returns the new project shell. We then switch the tab to it.
  const startNew = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor) return;
    logEvent('client.start_new', {});
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'untitled canvas' }),
      });
      if (!res.ok) {
        alert('failed to create project');
        return;
      }
      const data = (await res.json()) as { project: { id: string } };
      await refreshProjects();
      // Switch immediately. The new project has no turns yet — the
      // user's first input creates the user turn (locally + server-side
      // via /api/generate's user-turn upsert).
      useConversation.getState().setActiveProjectId(data.project.id);
      useConversation.getState().clearActiveCanvas();
      const id = useConversation
        .getState()
        .createTurn({ role: 'user', parentId: null });
      // Persist that empty user input card to the server so a second
      // tab opening the same project sees the input slot.
      void upsertTurnRemote(data.project.id, {
        id,
        role: 'user',
        content: '',
        parentId: null,
        emphasis: 1,
        streaming: false,
        meta: {},
      });
      setActiveId(id);
      setInput(START_SEED);
      repaintCanvas();
      editor.centerOnPoint(
        { x: CARD_WIDTH / 2, y: CARD_HEIGHT_MIN / 2 + 90 },
        SMOOTH_CAMERA,
      );
    } catch (err) {
      console.error('startNew failed:', err);
    }
  }, [repaintCanvas, refreshProjects]);

  const deleteArchivedProject = useCallback(
    async (projectId: string) => {
      const target = useConversation
        .getState()
        .projects.find((p) => p.id === projectId);
      if (!target) return;
      if (target.sessionId) void deleteSession(target.sessionId);
      void deleteProjectRemote(projectId);
      logEvent('client.delete_project', {
        projectId,
        hadSession: !!target.sessionId,
      });
      await refreshProjects();
    },
    [refreshProjects],
  );

  const renameArchivedProject = useCallback(
    (projectId: string, name: string) => {
      void patchProjectRemote(projectId, { name }).then(refreshProjects);
    },
    [refreshProjects],
  );

  // Mount-time bootstrap. Server is the source of truth: list every
  // project, decide which one this tab should look at (the persisted
  // activeProjectId if it's still in the list, else the most recent
  // one), fetch its state, populate the store. If the server has zero
  // projects, create one automatically.
  const bootstrappedRef = useRef(false);
  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    void (async () => {
      const list = await refreshProjects();
      const persisted = useConversation.getState().activeProjectId;
      let targetId =
        persisted && list.some((p) => p.id === persisted)
          ? persisted
          : list[0]?.id ?? null;
      if (!targetId) {
        const res = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'untitled canvas' }),
        });
        if (res.ok) {
          const data = (await res.json()) as { project: { id: string } };
          targetId = data.project.id;
          await refreshProjects();
        }
      }
      if (!targetId) return;
      await switchToProject(targetId);
    })();
  }, [refreshProjects, switchToProject]);

  // Drop the active project's Managed Agent session so the next turn mints
  // a fresh one against the latest agent version. Keeps all canvas turns,
  // loses the agent's intra-session memory + container state. Useful to
  // shed accumulated kickoff bloat from earlier (pre-skinny) turns or to
  // pick up a new agent version on an existing canvas.
  const resetActiveSession = useCallback(() => {
    const cur = useConversation.getState().projectSessionId;
    if (!cur) return;
    if (
      !confirm(
        'Reset this canvas\'s session? Your cards stay; the agent\'s working memory + container state will reset, and the next turn picks up the latest agent. Memory in /mnt/memory/ persists.',
      )
    ) {
      return;
    }
    void deleteSession(cur);
    useConversation.getState().setProjectSessionId(null);
    void patchProjectRemote(useConversation.getState().activeProjectId, {
      sessionId: null,
    });
    logEvent('client.reset_session', { sessionId: cur });
  }, []);

  // Phase 1: ask the agent to take an autonomous turn on the active
  // project. Useful as a manual trigger before the cron loop ships;
  // every mutation flows through the WS channel so the canvas updates
  // live as the agent works.
  const [wakeBusy, setWakeBusy] = useState(false);
  const wakeActive = useCallback(async () => {
    const projectId = useConversation.getState().activeProjectId;
    const sessionId = useConversation.getState().projectSessionId;
    if (!sessionId) {
      // No session yet — autonomous turns require an existing session
      // to wake (cheaper + agent has memory). Tell the user.
      alert(
        'No agent session yet. Take a first turn so a session is minted, then come back.',
      );
      return;
    }
    setWakeBusy(true);
    logEvent('client.wake_start', { projectId });
    try {
      const result = await wakeProject(projectId);
      logEvent('client.wake_end', { projectId, ok: result.ok });
      if (!result.ok) alert(`wake failed: ${result.error}`);
    } finally {
      setWakeBusy(false);
    }
  }, []);

  function onInputChange(text: string): void {
    setInput(text);
  }

  // Card height is purely a tldraw layout concern — measured by the React
  // CardBody and written back to the shape (not the graph). Keep it editor-
  // side and let repositionChain re-flow downstream cards.
  const resizeActive = useCallback(
    (h: number) => {
      const editor = editorRef.current;
      if (!editor || !activeId) return;
      const current = editor.getShape(activeId) as unknown as CardShape | undefined;
      if (!current) return;
      if (current.props.h !== h) {
        editor.updateShape({ id: activeId, type: 'card', props: { h } });
      }
      repositionChain(editor, activeId);
    },
    [activeId],
  );

  const resizeCard = useCallback((id: TurnId, h: number) => {
    const editor = editorRef.current;
    if (!editor) return;
    const current = editor.getShape(id) as unknown as CardShape | undefined;
    if (!current) return;
    if (Math.abs(current.props.h - h) >= 1) {
      editor.updateShape({ id, type: 'card', props: { h } });
    }
    repositionChain(editor, id);
  }, []);

  // Subscribe to the parent assistant's reflections + toggled labels via the
  // store. Shallow-equal selectors keep references stable so ActiveInputCard
  // doesn't re-measure on unrelated turns' content streaming.
  const activePredictions = useConversation((s) => {
    if (!activeId) return EMPTY_PREDICTIONS;
    const t = s.turns[activeId];
    if (!t || !t.parentId) return EMPTY_PREDICTIONS;
    return s.turns[t.parentId]?.meta.predictions ?? EMPTY_PREDICTIONS;
  });
  const activeToggledLabels = useConversation((s) => {
    if (!activeId) return EMPTY_TOGGLED_LABELS;
    const t = s.turns[activeId];
    if (!t || !t.parentId) return EMPTY_TOGGLED_LABELS;
    return (
      s.turns[t.parentId]?.meta.predictionsToggled ?? EMPTY_TOGGLED_LABELS
    );
  });
  const activeToggled = useMemo(
    () => new Set(activeToggledLabels),
    [activeToggledLabels],
  );
  // Reactive: total count of selected chips across activeId's ancestors.
  // Walks the chain once per store change; cheap because the chain is short.
  const chipSelectionCount = useConversation((s) => {
    if (!activeId) return 0;
    let total = 0;
    let cur: TurnId | null = activeId;
    const seen = new Set<TurnId>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const t: import('./graph/types').Turn | undefined = s.turns[cur];
      if (!t) break;
      total += (t.meta.chipsSelected ?? []).length;
      cur = t.parentId;
    }
    return total;
  });
  const hasChipSelections = chipSelectionCount > 0;

  // Clear every selected chip across the active chain. Used when the user
  // taps the counter pill in the chatbox row.
  const clearAllChipSelections = useCallback(() => {
    if (!activeId) return;
    const ancestors = useConversation.getState().getAncestors(activeId);
    for (const t of ancestors) {
      if ((t.meta.chipsSelected ?? []).length > 0) {
        useConversation.getState().clearChipsSelected(t.id);
      }
    }
  }, [activeId]);

  return (
    <CardActionsContext.Provider
      value={{
        branchFrom,
        pickOption,
        toggleChipSelected,
        togglePrediction,
        toggleEmphasis,
        deleteCard,
        activeId,
        activePredictions,
        activeToggled,
        hasChipSelections,
        chipSelectionCount,
        clearAllChipSelections,
        input,
        setInput,
        onInputChange,
        submit: handleSubmit,
        resizeActive,
        resizeCard,
        busy,
      }}
    >
    <div
      style={{ position: 'fixed', inset: 0 }}
      onContextMenu={(e) => {
        e.preventDefault();
        const editor = editorRef.current;
        if (!editor) return;
        const point = editor.screenToPage({ x: e.clientX, y: e.clientY });
        const hit = editor.getShapeAtPoint(point);
        const card =
          hit && hit.type === 'card'
            ? (hit as unknown as CardShape)
            : null;
        setCtxMenu({ x: e.clientX, y: e.clientY, pageX: point.x, pageY: point.y, shape: card });
      }}
    >
      <Tldraw
        shapeUtils={shapeUtils}
        components={components}
        onMount={handleMount}
        hideUi
        inferDarkMode={false}
      />

      {/* Top-left toolbar */}
      <div
        style={{
          position: 'fixed',
          top: 'calc(12px + env(safe-area-inset-top))',
          left: 'calc(12px + env(safe-area-inset-left))',
          zIndex: 1001,
          display: 'flex',
          gap: 8,
        }}
      >
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => setProjectsOpen((o) => !o)}
            aria-label="Switch project"
            aria-expanded={projectsOpen}
            data-testid="toggle-projects"
            title="Switch between canvases (projects)."
            style={{
              ...toolbarBtn,
              background: projectsOpen ? '#111' : '#fff',
              color: projectsOpen ? '#fff' : '#111',
              maxWidth: 220,
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M3 7h13l3 3v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7zM3 7V5a1 1 0 0 1 1-1h6l2 3"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span
              style={{
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: 140,
              }}
            >
              {activeProjectName}
            </span>
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden
              style={{ marginLeft: -2 }}
            >
              <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {projectsOpen && (
            <ProjectsMenu
              activeName={activeProjectName}
              activeSessionId={activeSessionId}
              info={agentInfo}
              archive={otherProjects}
              onClose={() => setProjectsOpen(false)}
              onNew={() => {
                setProjectsOpen(false);
                startNew();
              }}
              onResume={(id) => {
                setProjectsOpen(false);
                void switchToProject(id);
              }}
              onResetSession={() => {
                setProjectsOpen(false);
                resetActiveSession();
              }}
              onDelete={deleteArchivedProject}
              onRename={renameArchivedProject}
            />
          )}
        </div>

        {/* Wake button — second toolbar slot. Click opens a small popover
            with the per-canvas direction textarea + a "wake now" trigger.
            Replaces the wake controls that used to live inside the
            projects menu. */}
        {activeSessionId && (
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => setWakeOpen((o) => !o)}
              disabled={wakeBusy}
              aria-label="Wake the agent and steer it"
              aria-expanded={wakeOpen}
              data-testid="toggle-wake"
              title="Wake the agent. Optionally write a direction it should keep watching for between sessions."
              style={{
                ...toolbarBtn,
                background: wakeOpen ? '#111' : '#fff',
                color: wakeBusy ? '#aaa' : wakeOpen ? '#fff' : '#111',
                cursor: wakeBusy ? 'default' : 'pointer',
                opacity: wakeBusy ? 0.6 : 1,
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden
              >
                <path
                  d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1M9 12a3 3 0 1 1 6 0 3 3 0 0 1-6 0z"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
              wake
            </button>
            {wakeOpen && (
              <WakeMenu
                activeWakeIntent={activeWakeIntent}
                wakeBusy={wakeBusy}
                onClose={() => setWakeOpen(false)}
                onWakeIntentChange={(intent) => {
                  if (!activeProjectIdSelRaw) return;
                  void patchProjectRemote(activeProjectIdSelRaw, {
                    wakeIntent: intent,
                  }).then(() => refreshProjects());
                }}
                onWake={() => {
                  setWakeOpen(false);
                  void wakeActive();
                }}
              />
            )}
          </div>
        )}
      </div>

      {/* Branch + buttons rendered as a screen-space overlay above the
          tldraw canvas. Lives outside the card's HTMLContainer because
          tldraw's per-shape z-stack races with arrow rendering — the
          arrow's div would paint over a CSS-positioned + button inside
          the card. As a separate React layer, the + sits above
          everything tldraw draws. */}
      <BranchPlusOverlay editorRef={editorRef} branchFrom={branchFrom} />

      {/* Top-right floating panel: agent's branch proposals */}
      {proposals.length > 0 && (
        <ProposalsPanel
          proposals={proposals}
          onAccept={acceptProposal}
          onDismiss={dismissProposal}
        />
      )}

      {/* Bottom hint area is only shown when there's no active card */}
      {activeId == null && (
        <div
          ref={inputWrapRef}
          className="river-input-wrap"
          style={{
            position: 'fixed',
            left: 0,
            right: 0,
            bottom: 'var(--kbd-offset, 0px)',
            paddingLeft: 'max(12px, env(safe-area-inset-left))',
            paddingRight: 'max(12px, env(safe-area-inset-right))',
            paddingBottom: 'calc(16px + env(safe-area-inset-bottom))',
            display: 'flex',
            justifyContent: 'center',
            pointerEvents: 'none',
            zIndex: 1000,
          }}
        >
          <div
            style={{
              pointerEvents: 'auto',
              padding: '12px 18px',
              background: '#fff',
              borderRadius: 999,
              border: '1px solid #1a1a1a',
              boxShadow: '0 6px 24px rgba(0,0,0,0.12)',
              fontSize: 13,
              color: '#555',
            }}
          >
            tap "+ new" to start
          </div>
        </div>
      )}


      {/* ─── Custom context menu ─── */}
      {ctxMenu && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 2000 }}
          onClick={() => setCtxMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setCtxMenu(null);
          }}
        >
          <RiverCtxMenu
            x={ctxMenu.x}
            y={ctxMenu.y}
            shape={ctxMenu.shape}
            onNewStream={() => {
              startNewStream(ctxMenu.pageX, ctxMenu.pageY);
              setCtxMenu(null);
            }}
            onNewConversation={() => { startNew(); setCtxMenu(null); }}
            onBranch={() => { if (ctxMenu.shape) branchFrom(ctxMenu.shape.id); setCtxMenu(null); }}
            onCopy={() => {
              if (!ctxMenu.shape) return;
              const turn = useConversation
                .getState()
                .getTurn(ctxMenu.shape.id);
              const text = turn?.content ?? '';
              if (text) void navigator.clipboard?.writeText(text);
              setCtxMenu(null);
            }}
            onDelete={() => {
              if (ctxMenu.shape && confirm('Delete this card?')) deleteCard(ctxMenu.shape.id);
              setCtxMenu(null);
            }}
          />
        </div>
      )}

      <style>{`
        @keyframes river-cursor-blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
        .river-cursor { display: inline-block; margin-left: 2px; color: #4a90e2; animation: river-cursor-blink 0.9s step-end infinite; }
        .tl-container, .tl-background { background: #f7f6f2 !important; }
        .river-input-wrap ::-webkit-scrollbar { display: none; }
        .river-card:hover .river-card-actions { opacity: 1 !important; }
        .river-card-actions button:hover { background: rgba(0,0,0,0.06) !important; }
        /* Chips are invisible by default; hover tints the background at
           low opacity so the affordance is discoverable, but the chip's
           box keeps its exact original width — no padding shift, no
           margin, so the prose wraps as if the chip weren't there. */
        .river-chip:not(.on):hover {
          background: rgba(46, 110, 207, 0.12) !important;
        }
        .tl-html-container button,
        .tl-html-container textarea,
        .tl-html-container [role="button"] {
          touch-action: manipulation;
        }
      `}</style>
    </div>
    </CardActionsContext.Provider>
  );
}

const toolbarBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '10px 14px',
  background: '#fff',
  color: '#111',
  border: '1px solid #1a1a1a',
  borderRadius: 999,
  font: 'inherit',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  boxShadow: '0 3px 10px rgba(0,0,0,0.1)',
  WebkitTapHighlightColor: 'transparent',
  minHeight: 40,
};


/* ─── Branch + button overlay ─── */

/**
 * Screen-space overlay that renders a small + button just below every
 * card on the canvas. Lives outside tldraw's shape system so its
 * stacking is independent of tldraw's per-shape z-order — the + always
 * paints on top of arrows, no matter what indices tldraw assigns.
 *
 * Listens to the editor's store + camera and re-renders whenever
 * shapes or the viewport change. Cheap because the overlay is a flat
 * list of buttons; for normal canvases (10-50 cards) the cost is
 * negligible.
 */
function BranchPlusOverlay({
  editorRef,
  branchFrom,
}: {
  editorRef: React.MutableRefObject<Editor | null>;
  branchFrom: (id: TurnId) => void;
}) {
  // Track the cards we want a + for. We only re-render this list when
  // the SET of cards changes (id list changes), not on every camera
  // tick — those are handled by per-button rAF DOM updates so React
  // doesn't reconcile thousands of times per second during pan/zoom.
  const [cardIds, setCardIds] = useState<TurnId[]>([]);
  useEffect(() => {
    let unsub: (() => void) | null = null;
    let cancelled = false;
    const sync = (editor: Editor) => {
      const ids = editor
        .getCurrentPageShapes()
        .filter((s) => s.type === 'card')
        .map((s) => s.id as TurnId);
      setCardIds((prev) => {
        if (prev.length === ids.length && prev.every((p, i) => p === ids[i])) return prev;
        return ids;
      });
    };
    const wait = () => {
      if (cancelled) return;
      const editor = editorRef.current;
      if (!editor) {
        // editorRef gets populated after Tldraw mounts; retry on the
        // next frame until it's ready.
        requestAnimationFrame(wait);
        return;
      }
      sync(editor);
      unsub = editor.store.listen(() => sync(editor), {
        source: 'all',
        scope: 'all',
      });
    };
    wait();
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [editorRef]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 800,
      }}
    >
      {cardIds.map((id) => (
        <BranchPlusButtonOverlay
          key={id}
          editorRef={editorRef}
          cardId={id}
          onClick={() => branchFrom(id)}
        />
      ))}
    </div>
  );
}

function BranchPlusButtonOverlay({
  editorRef,
  cardId,
  onClick,
}: {
  editorRef: React.MutableRefObject<Editor | null>;
  cardId: TurnId;
  onClick: () => void;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [hover, setHover] = useState(false);
  // Position the button via direct DOM writes on every animation frame
  // so it follows tldraw's camera and card-position changes without
  // needing React to reconcile. tldraw doesn't emit a clean "frame"
  // event we can hook, and store listeners miss some camera updates.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const editor = editorRef.current;
      const el = ref.current;
      if (editor && el) {
        const card = editor.getShape(cardId) as unknown as CardShape | undefined;
        if (card) {
          const pageX = card.x + card.props.w / 2;
          const pageY = card.y + card.props.h + 8;
          const p = editor.pageToScreen({ x: pageX, y: pageY });
          el.style.transform = `translate(${p.x - 11}px, ${p.y - 11}px)`;
          el.style.display = '';
        } else {
          el.style.display = 'none';
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [editorRef, cardId]);

  return (
    <button
      ref={ref}
      type="button"
      aria-label="branch"
      title="Branch from this card"
      onPointerDown={(e) => {
        e.stopPropagation();
        e.preventDefault();
        onClick();
      }}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: 22,
        height: 22,
        padding: 0,
        boxSizing: 'border-box',
        background: '#fff',
        border: `1px solid ${hover ? '#666' : '#bbb'}`,
        borderRadius: 999,
        color: hover ? '#111' : '#777',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: hover ? '0 1px 4px rgba(0,0,0,0.15)' : 'none',
        transition: 'color 120ms, border-color 120ms, box-shadow 120ms',
        WebkitTapHighlightColor: 'transparent',
        pointerEvents: 'auto',
        willChange: 'transform',
      }}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M12 5v14M5 12h14"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}

/* ─── Branch proposals panel ─── */

/**
 * Floating panel in the top-right that lists pending branch proposals from
 * the agent. Each row shows the parent card's title + the suggested prompt
 * with ✓ to accept (creates the branch + runs it) and ✕ to dismiss. The
 * agent stays unblocked: proposals are fire-and-forget from its side; the
 * user takes whichever look promising and ignores the rest.
 */
function ProposalsPanel({
  proposals,
  onAccept,
  onDismiss,
}: {
  proposals: BranchProposal[];
  onAccept: (p: BranchProposal) => void;
  onDismiss: (proposalId: string) => void;
}) {
  const turns = useConversation((s) => s.turns);
  return (
    <div
      style={{
        position: 'fixed',
        top: 'calc(12px + env(safe-area-inset-top))',
        right: 'calc(12px + env(safe-area-inset-right))',
        zIndex: 1001,
        width: 320,
        maxWidth: 'calc(100vw - 24px)',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          pointerEvents: 'auto',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          background: 'rgba(255,255,255,0.92)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          border: '1px solid rgba(26,26,26,0.12)',
          borderRadius: 999,
          fontFamily: 'system-ui, -apple-system, sans-serif',
          fontSize: 11,
          letterSpacing: 0.4,
          textTransform: 'uppercase',
          color: '#6b6660',
          alignSelf: 'flex-start',
        }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
        agent suggests · {proposals.length}
      </div>
      {proposals.map((p) => {
        const parent = turns[p.parentId as TurnId];
        const parentTitle =
          parent?.meta.label ??
          (parent
            ? parent.content.replace(/\s+/g, ' ').trim().slice(0, 60)
            : 'unknown card');
        return (
          <div
            key={p.proposalId}
            style={{
              pointerEvents: 'auto',
              padding: '10px 12px',
              background: '#fff',
              border: '1px solid rgba(26,26,26,0.14)',
              borderRadius: 12,
              boxShadow: '0 4px 14px rgba(0,0,0,0.08)',
              fontFamily: 'system-ui, -apple-system, sans-serif',
              fontSize: 13,
              color: '#1a1a1a',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            <div
              style={{
                fontSize: 11,
                color: '#9a9590',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
              title={`branch from ${parentTitle}`}
            >
              from <em style={{ color: '#6b6660' }}>{parentTitle}</em>
            </div>
            <div style={{ lineHeight: 1.4 }}>{p.prompt}</div>
            {p.rationale && (
              <div
                style={{
                  fontSize: 12,
                  color: '#6b6660',
                  fontStyle: 'italic',
                  lineHeight: 1.35,
                }}
              >
                {p.rationale}
              </div>
            )}
            <div
              style={{
                display: 'flex',
                gap: 6,
                marginTop: 2,
                justifyContent: 'flex-end',
              }}
            >
              <button
                type="button"
                onClick={() => onDismiss(p.proposalId)}
                aria-label="Dismiss suggestion"
                style={{
                  padding: '6px 12px',
                  background: '#fff',
                  color: '#6b6660',
                  border: '1px solid rgba(26,26,26,0.14)',
                  borderRadius: 999,
                  font: 'inherit',
                  fontSize: 12,
                  cursor: 'pointer',
                  WebkitTapHighlightColor: 'transparent',
                }}
              >
                dismiss
              </button>
              <button
                type="button"
                onClick={() => onAccept(p)}
                aria-label="Accept suggestion"
                style={{
                  padding: '6px 12px',
                  background: '#2e6ecf',
                  color: '#fff',
                  border: '1px solid #2e6ecf',
                  borderRadius: 999,
                  font: 'inherit',
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: 'pointer',
                  WebkitTapHighlightColor: 'transparent',
                }}
              >
                branch ↗
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ─── Wake menu ─── */

/**
 * Popover anchored to the toolbar wake button. Two parts:
 * 1) a textarea for the optional per-canvas wake direction (blur-saves
 *    to the project row), and
 * 2) a "wake now" trigger that fires the autonomous turn against the
 *    saved direction.
 *
 * Surfacing this on the toolbar (rather than buried in the projects
 * menu) makes wake a first-class affordance — the user can steer and
 * trigger the cartographer in two clicks.
 */
function WakeMenu({
  activeWakeIntent,
  wakeBusy,
  onClose,
  onWakeIntentChange,
  onWake,
}: {
  activeWakeIntent: string;
  wakeBusy: boolean;
  onClose: () => void;
  onWakeIntentChange: (intent: string) => void;
  onWake: () => void;
}) {
  const [draft, setDraft] = useState(activeWakeIntent);
  useEffect(() => {
    setDraft(activeWakeIntent);
  }, [activeWakeIntent]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const commit = () => {
    if (draft !== activeWakeIntent) onWakeIntentChange(draft);
  };

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 1499 }}
        aria-hidden
      />
      <div
        role="dialog"
        aria-label="Wake the agent"
        style={{
          position: 'absolute',
          top: 'calc(100% + 6px)',
          left: 0,
          width: 320,
          background: '#fff',
          border: '1px solid rgba(26,26,26,0.14)',
          borderRadius: 12,
          boxShadow:
            '0 10px 30px rgba(0,0,0,0.14), 0 2px 8px rgba(0,0,0,0.06)',
          padding: 12,
          fontFamily: 'system-ui, -apple-system, sans-serif',
          fontSize: 13,
          color: '#1a1a1a',
          zIndex: 1500,
        }}
      >
        <label
          style={{
            display: 'block',
            fontSize: 11,
            color: '#9a9590',
            letterSpacing: 0.3,
            textTransform: 'uppercase',
            marginBottom: 6,
          }}
        >
          wake direction
        </label>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
          placeholder="optional · what should the agent watch for between sessions?"
          rows={3}
          style={{
            width: '100%',
            padding: '8px 10px',
            border: '1px solid #e0dfd9',
            borderRadius: 6,
            background: '#fafaf7',
            font: 'inherit',
            fontSize: 13,
            lineHeight: 1.45,
            color: '#1a1a1a',
            resize: 'vertical',
            minHeight: 60,
            outline: 'none',
            boxSizing: 'border-box',
          }}
          onFocus={(e) => {
            e.currentTarget.style.background = '#fff';
            e.currentTarget.style.borderColor = '#bdb9b0';
          }}
        />
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: 10,
            gap: 8,
          }}
        >
          <span style={{ fontSize: 11, color: '#9a9590' }}>
            empty = generic survey
          </span>
          <button
            type="button"
            onClick={() => {
              commit();
              onWake();
            }}
            disabled={wakeBusy}
            style={{
              border: 'none',
              borderRadius: 8,
              padding: '8px 14px',
              background: wakeBusy ? '#bbb' : '#111',
              color: '#fff',
              fontSize: 13,
              fontWeight: 500,
              cursor: wakeBusy ? 'default' : 'pointer',
              fontFamily: 'inherit',
              opacity: wakeBusy ? 0.6 : 1,
            }}
          >
            {wakeBusy ? 'waking…' : 'wake now'}
          </button>
        </div>
      </div>
    </>
  );
}

/* ─── Projects menu ─── */

/**
 * Dropdown anchored to the projects toolbar button. Top: "+ new canvas".
 * Below: each archived project with click-to-resume and an inline ✕ to
 * delete (with confirm). Per-row rename via dblclick on the title.
 * Manual deletion only — auto-delete would orphan sessions the user may
 * want to return to.
 */
function ProjectsMenu({
  activeName,
  activeSessionId,
  info,
  archive,
  onClose,
  onNew,
  onResume,
  onResetSession,
  onDelete,
  onRename,
}: {
  activeName: string;
  activeSessionId: string | null;
  info: AgentInfo | null;
  archive: import('./api').ServerProject[];
  onClose: () => void;
  onNew: () => void;
  onResume: (id: string) => void;
  onResetSession: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (editingId) {
          setEditingId(null);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, editingId]);

  const commitRename = () => {
    if (editingId) {
      onRename(editingId, draftName);
      setEditingId(null);
    }
  };

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 1499 }}
        aria-hidden
      />
      <div
        role="menu"
        aria-label="Projects"
        style={{
          position: 'absolute',
          top: 'calc(100% + 6px)',
          left: 0,
          width: 280,
          maxHeight: 'calc(100vh - 120px)',
          overflowY: 'auto',
          background: '#fff',
          border: '1px solid rgba(26,26,26,0.14)',
          borderRadius: 12,
          boxShadow:
            '0 10px 30px rgba(0,0,0,0.14), 0 2px 8px rgba(0,0,0,0.06)',
          padding: 4,
          fontFamily: 'system-ui, -apple-system, sans-serif',
          fontSize: 13,
          color: '#1a1a1a',
          zIndex: 1500,
        }}
      >
        <button
          type="button"
          role="menuitem"
          onClick={onNew}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            padding: '8px 10px',
            background: 'none',
            border: 'none',
            borderRadius: 6,
            font: 'inherit',
            color: '#1a1a1a',
            cursor: 'pointer',
            textAlign: 'left',
            WebkitTapHighlightColor: 'transparent',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = '#f3f2ee';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'none';
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
          new canvas
        </button>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 10px',
            color: '#6b6660',
            background: '#f7f6f2',
            borderRadius: 6,
            margin: '4px 0',
          }}
        >
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: '#2e6ecf',
              flex: '0 0 auto',
            }}
          />
          <span
            style={{
              flex: '1 1 auto',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
            title={activeName}
          >
            {activeName}
          </span>
          <span
            style={{
              fontSize: 10,
              letterSpacing: 0.5,
              textTransform: 'uppercase',
              color: '#9a9590',
            }}
          >
            active
          </span>
          {activeSessionId && (
            <button
              type="button"
              onClick={onResetSession}
              aria-label="Reset this canvas's agent session"
              title="Drop the current Managed Agent session and start fresh on the next turn. Cards stay; agent's working memory + container reset."
              style={{
                flex: '0 0 auto',
                border: 'none',
                background: 'none',
                padding: 4,
                cursor: 'pointer',
                color: '#6b6660',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 4,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = '#1a1a1a';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = '#6b6660';
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M3 12a9 9 0 0 1 15.5-6.3M21 12a9 9 0 0 1-15.5 6.3M21 4v5h-5M3 20v-5h5"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
        </div>

        {archive.length === 0 ? (
          <div style={{ padding: '8px 10px', color: '#9a9590' }}>
            no other canvases yet
          </div>
        ) : (
          archive.map((p) => (
            <div
              key={p.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                paddingLeft: 4,
                paddingRight: 2,
                borderRadius: 6,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = '#f3f2ee';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'none';
              }}
            >
              {editingId === p.id ? (
                <input
                  autoFocus
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename();
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                  style={{
                    flex: '1 1 auto',
                    padding: '7px 8px',
                    background: '#fff',
                    border: '1px solid #2e6ecf',
                    borderRadius: 5,
                    font: 'inherit',
                    fontSize: 13,
                    color: '#1a1a1a',
                    outline: 'none',
                    minWidth: 0,
                  }}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => onResume(p.id)}
                  onDoubleClick={() => {
                    setDraftName(p.name);
                    setEditingId(p.id);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    flex: '1 1 auto',
                    minWidth: 0,
                    padding: '8px 6px',
                    background: 'none',
                    border: 'none',
                    font: 'inherit',
                    color: '#1a1a1a',
                    cursor: 'pointer',
                    textAlign: 'left',
                    WebkitTapHighlightColor: 'transparent',
                  }}
                  title={`${p.name}\n(double-click to rename)`}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: p.sessionId ? '#1a1a1a' : '#cccccc',
                      opacity: p.sessionId ? 0.55 : 1,
                      flex: '0 0 auto',
                    }}
                  />
                  <span
                    style={{
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      flex: '1 1 auto',
                      minWidth: 0,
                    }}
                  >
                    {p.name}
                  </span>
                </button>
              )}
              <button
                type="button"
                aria-label={`Delete ${p.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Delete "${p.name}" and its session?`)) {
                    onDelete(p.id);
                  }
                }}
                style={{
                  flex: '0 0 auto',
                  border: 'none',
                  background: 'none',
                  padding: 6,
                  cursor: 'pointer',
                  color: '#9a9590',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 4,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = '#a04040';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = '#9a9590';
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
          ))
        )}

        {/* Footer: agent + session identifiers (version, model, sesn id).
            Click to copy the session id to clipboard. */}
        <div
          style={{
            marginTop: 6,
            paddingTop: 8,
            paddingBottom: 4,
            borderTop: '1px solid #eeedea',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 11,
            color: '#9a9590',
            fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
            paddingLeft: 10,
            paddingRight: 10,
          }}
        >
          <span title="agent version">
            {info?.agentVersion != null ? `v${info.agentVersion}` : 'v?'}
          </span>
          <span aria-hidden style={{ opacity: 0.4 }}>·</span>
          <span
            title={`model: ${info?.model ?? 'unknown'}`}
            style={{
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {info?.model ? shortenModel(info.model) : 'no model'}
          </span>
          <span aria-hidden style={{ opacity: 0.4 }}>·</span>
          <button
            type="button"
            disabled={!activeSessionId}
            onClick={() => {
              if (!activeSessionId) return;
              void navigator.clipboard?.writeText(activeSessionId);
            }}
            title={
              activeSessionId
                ? `${activeSessionId} (click to copy)`
                : 'no session yet — first turn mints one'
            }
            style={{
              flex: '1 1 auto',
              minWidth: 0,
              border: 'none',
              background: 'none',
              padding: 0,
              font: 'inherit',
              color: activeSessionId ? '#9a9590' : '#cccccc',
              cursor: activeSessionId ? 'pointer' : 'default',
              textAlign: 'left',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              WebkitTapHighlightColor: 'transparent',
            }}
            onMouseEnter={(e) => {
              if (activeSessionId) e.currentTarget.style.color = '#1a1a1a';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = activeSessionId ? '#9a9590' : '#cccccc';
            }}
          >
            {activeSessionId ? shortenSessionId(activeSessionId) : 'no session'}
          </button>
        </div>
      </div>
    </>
  );
}

// Pretty-print "claude-opus-4-7" → "opus 4.7" for the menu footer. Falls
// back to the raw string for unknown shapes (so we don't accidentally
// hide info).
function shortenModel(model: string): string {
  const m = model.match(/^claude-([a-z]+)-(\d+)-(\d+)$/i);
  if (m) return `${m[1].toLowerCase()} ${m[2]}.${m[3]}`;
  return model;
}

// "sesn_011CaRyjgZKo96xnnMqpYHDq" → "sesn_…YHDq" so it fits on one line
// in the footer while still showing enough characters to be visually
// distinguishable across canvases.
function shortenSessionId(id: string): string {
  const tail = id.slice(-6);
  const head = id.split('_')[0];
  return `${head}_…${tail}`;
}


/* ─── Custom context menu ─── */

const CTX_ITEM: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '10px 14px',
  background: 'none',
  border: 'none',
  borderRadius: 6,
  font: 'inherit',
  fontSize: 13,
  color: '#111',
  cursor: 'pointer',
  textAlign: 'left',
  WebkitTapHighlightColor: 'transparent',
};

function RiverCtxMenu({
  x,
  y,
  shape,
  onNewStream,
  onNewConversation,
  onBranch,
  onCopy,
  onDelete,
}: {
  x: number;
  y: number;
  shape: CardShape | null;
  onNewStream: () => void;
  onNewConversation: () => void;
  onBranch: () => void;
  onCopy: () => void;
  onDelete: () => void;
}) {
  const menuW = 180;
  const menuRef = useRef<HTMLDivElement>(null);
  const left = Math.min(x, window.innerWidth - menuW - 12);
  const top = Math.min(y, window.innerHeight - 260);

  return (
    <div
      ref={menuRef}
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        left,
        top,
        width: menuW,
        background: '#fff',
        border: '1px solid #e0dfd9',
        borderRadius: 10,
        boxShadow: '0 6px 24px rgba(0,0,0,0.14), 0 2px 8px rgba(0,0,0,0.06)',
        padding: 4,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        zIndex: 2001,
      }}
    >
      <button
        type="button"
        style={CTX_ITEM}
        onMouseEnter={(e) => { (e.currentTarget.style.background = '#f3f2ee'); }}
        onMouseLeave={(e) => { (e.currentTarget.style.background = 'none'); }}
        onClick={onNewStream}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
        New stream here
      </button>

      <button
        type="button"
        style={CTX_ITEM}
        onMouseEnter={(e) => { (e.currentTarget.style.background = '#f3f2ee'); }}
        onMouseLeave={(e) => { (e.currentTarget.style.background = 'none'); }}
        onClick={onNewConversation}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M3 7h7v7H3zM14 10h7v7h-7z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        New canvas
      </button>

      {shape && (
        <>
          <div style={{ height: 1, background: '#eeedea', margin: '2px 8px' }} />
          <button
            type="button"
            style={CTX_ITEM}
            onMouseEnter={(e) => { (e.currentTarget.style.background = '#f3f2ee'); }}
            onMouseLeave={(e) => { (e.currentTarget.style.background = 'none'); }}
            onClick={onBranch}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M7 5v9a4 4 0 0 0 4 4h7M15 14l3 3-3 3"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Branch
          </button>

          <button
            type="button"
            style={CTX_ITEM}
            disabled={!shape.props.content.trim()}
            onMouseEnter={(e) => { (e.currentTarget.style.background = '#f3f2ee'); }}
            onMouseLeave={(e) => { (e.currentTarget.style.background = 'none'); }}
            onClick={onCopy}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M9 5h9a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM5 15V5a2 2 0 0 1 2-2h8"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Copy text
          </button>

          <button
            type="button"
            style={{ ...CTX_ITEM, color: '#a04040' }}
            onMouseEnter={(e) => { (e.currentTarget.style.background = '#fdf4f4'); }}
            onMouseLeave={(e) => { (e.currentTarget.style.background = 'none'); }}
            onClick={onDelete}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Delete
          </button>
        </>
      )}
    </div>
  );
}

const CARD_GAP_Y = 64;
const CARD_GAP_X = 80;
const COLUMN_WIDTH = CARD_WIDTH + CARD_GAP_X;

/**
 * Tidy-tree layout. Reads the parent→children relation from the graph store
 * (no longer from arrow bindings — those are a downstream view) and writes
 * x/y back to tldraw shapes. Positions remain a tldraw concern; structure is
 * a graph concern.
 */
function relayoutAll(editor: Editor): void {
  const turns = useConversation.getState().turns;
  const turnIds = Object.keys(turns) as TurnId[];
  if (turnIds.length === 0) return;

  // parent → children
  const children = new Map<TurnId, TurnId[]>();
  const hasParent = new Set<TurnId>();
  for (const id of turnIds) children.set(id, []);
  for (const t of Object.values(turns)) {
    if (t.parentId) {
      children.get(t.parentId)?.push(t.id);
      hasParent.add(t.id);
    }
  }
  // All roots — multiple are allowed (each represents an independent stream
  // on the same canvas). Each root anchors its own subtree wherever the user
  // placed it; the layout only flows children below the existing root.
  const roots = turnIds.filter((id) => !hasParent.has(id));
  if (roots.length === 0) return;

  // Post-order: column count per subtree.
  const cols = new Map<TurnId, number>();
  function computeCols(id: TurnId): number {
    const kids = children.get(id) ?? [];
    if (kids.length === 0) {
      cols.set(id, 1);
      return 1;
    }
    let total = 0;
    for (const c of kids) total += computeCols(c);
    cols.set(id, total);
    return total;
  }
  for (const r of roots) computeCols(r);

  function assign(id: TurnId, anchorX: number, y: number, colOffset: number): void {
    const shape = editor.getShape(id) as unknown as CardShape | undefined;
    if (!shape) return;
    const x = anchorX + colOffset * COLUMN_WIDTH;
    if (Math.abs(shape.x - x) >= 1 || Math.abs(shape.y - y) >= 1) {
      editor.updateShape({ id, type: 'card', x, y });
    }
    const bottom = y + shape.props.h;
    const kids = children.get(id) ?? [];
    let offset = 0;
    for (const c of kids) {
      assign(c, anchorX, bottom + CARD_GAP_Y, colOffset + offset);
      offset += cols.get(c) ?? 1;
    }
  }
  for (const root of roots) {
    const rootShape = editor.getShape(root) as unknown as CardShape | undefined;
    // Anchor each tree at its root's current position. The first root falls
    // back to (0,0); subsequent roots default to the right of the previous
    // tree if they haven't been placed yet (shouldn't happen — startNewStream
    // pre-positions them — but keeps the layout sane if it does).
    const anchorX = rootShape?.x ?? 0;
    const y = rootShape?.y ?? 0;
    assign(root, anchorX, y, 0);
  }
  // After cards settle, drag the small classification-tag text shapes
  // along with them.
  repositionCardLabels(editor);
}

/**
 * After a card's measured height changes, re-flow each downstream child so
 * its top sits exactly CARD_GAP_Y below its parent's bottom. Reads the edge
 * relation from the graph store.
 */
function repositionChain(editor: Editor, sourceId: TurnId): void {
  const turns = useConversation.getState().turns;
  const source = editor.getShape(sourceId) as unknown as CardShape | undefined;
  if (!source) return;
  const targetY = source.y + source.props.h + CARD_GAP_Y;
  const children = Object.values(turns).filter((t) => t.parentId === sourceId);
  for (const child of children) {
    const childShape = editor.getShape(child.id) as unknown as
      | CardShape
      | undefined;
    if (!childShape) continue;
    if (Math.abs(childShape.y - targetY) >= 1) {
      editor.updateShape({ id: child.id, type: 'card', y: targetY });
    }
    repositionChain(editor, child.id);
  }
  repositionCardLabels(editor);
}

// `toRichText` and `TLShapeId` are still used by sync/edge creation —
// re-export so unused imports don't trip TS strict mode if logic shifts.
export type { TLShapeId };
const _keepImports = toRichText;
void _keepImports;
