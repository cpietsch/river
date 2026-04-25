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
  fetchAgentPredictions,
  streamGenerate,
  type ChatMessage,
  type AgentPrediction,
  type GraphSnapshot,
} from './api';
import { useConversation } from './graph/store';
import { useTldrawSync } from './graph/useTldrawSync';
import { syncStoreToTldraw } from './graph/sync';
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

  // Precache toggle: when on, every chip / presumption fires a background
  // main-model call so clicks land instantly. Cache key = `${parentId}::${prompt}`.
  const [precacheEnabled, setPrecacheEnabled] = useState(false);
  const precacheEnabledRef = useRef(false);
  useEffect(() => {
    precacheEnabledRef.current = precacheEnabled;
  }, [precacheEnabled]);
  const precacheRef = useRef<Map<string, string>>(new Map());
  const precacheInFlightRef = useRef<Set<string>>(new Set());
  const precacheKey = (parentId: TurnId | string, prompt: string) =>
    `${parentId}::${prompt}`;

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
    // recreate exactly the shapes the store needs.
    {
      const ids = editor.getCurrentPageShapes().map((s) => s.id);
      if (ids.length > 0) editor.deleteShapes(ids);
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

  const warmCache = useCallback(
    (parentAssistantId: TurnId, prompts: string[]) => {
      if (prompts.length === 0) return;
      const history = historyFor(parentAssistantId);
      const emphasized = gatherEmphasized();
      for (const prompt of prompts) {
        const key = precacheKey(parentAssistantId, prompt);
        if (precacheRef.current.has(key) || precacheInFlightRef.current.has(key))
          continue;
        precacheInFlightRef.current.add(key);
        let buffer = '';
        streamGenerate(prompt, history, (d) => { buffer += d; }, undefined, emphasized, [], buildGraphSnapshot())
          .then(() => { precacheRef.current.set(key, buffer); })
          .catch(() => {})
          .finally(() => { precacheInFlightRef.current.delete(key); });
      }
    },
    [historyFor, gatherEmphasized, buildGraphSnapshot],
  );

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

  const runTurnFrom = useCallback(
    async (
      userTurnId: TurnId,
      text: string,
      opts: { skipUserContext?: boolean } = {},
    ) => {
      const editor = editorRef.current;
      const store = useConversation.getState();
      if (!editor || busy) return;
      const isFromActive = userTurnId === activeId;

      setBusy(true);
      if (isFromActive) setInput('');

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

        const cacheK =
          branchParentId && userContext.length === 0
            ? precacheKey(branchParentId, text)
            : null;
        const cached = cacheK ? precacheRef.current.get(cacheK) : undefined;
        let buffer = '';
        if (cached !== undefined) {
          buffer = cached;
          useConversation
            .getState()
            .setContent(assistantId, buffer, { streaming: false });
        } else {
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
            undefined,
            emphasized,
            userContext,
            buildGraphSnapshot(),
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
          if (precacheEnabledRef.current) {
            warmCache(assistantId, spans.map((s) => s.question));
          }
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
            if (precacheEnabledRef.current) {
              warmCache(
                assistantId,
                predictions.map((p) => p.label.trim()),
              );
            }
          })
          .catch(() => {});
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
      }
    },
    [
      busy,
      activeId,
      historyFor,
      gatherEmphasized,
      getParentId,
      warmCache,
      gatherSelectedChips,
      buildGraphSnapshot,
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
      await runTurnFrom(activeId, text, {
        skipUserContext: usedSelectionsAsMessage,
      });
    },
    [activeId, input, runTurnFrom, getParentId, gatherSelectedChips],
  );

  // Branching: createTurn under sourceId; the syncer wires up the arrow.
  const createBranchUserTurn = useCallback((sourceId: TurnId): TurnId | null => {
    const store = useConversation.getState();
    if (!store.getTurn(sourceId)) return null;
    const newId = store.createTurn({ role: 'user', parentId: sourceId });
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
      const newId = createBranchUserTurn(turnId);
      if (newId) setActiveId(newId);
    },
    [createBranchUserTurn],
  );

  const togglePrediction = useCallback(
    (p: AgentPrediction) => {
      if (!activeId) return;
      const parentId = getParentId(activeId);
      if (!parentId) return;
      useConversation.getState().togglePrediction(parentId, p.label.trim());
    },
    [activeId, getParentId],
  );

  const toggleEmphasis = useCallback((id: TurnId) => {
    const t = useConversation.getState().getTurn(id);
    if (!t) return;
    const next = (t.emphasis ?? 1) >= 2 ? 1 : 2;
    useConversation.getState().setEmphasis(id, next);
  }, []);

  const deleteCard = useCallback(
    (turnId: TurnId) => {
      const removed = new Set(
        useConversation.getState().removeSubtree(turnId),
      );
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

  const startNew = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    precacheRef.current.clear();
    precacheInFlightRef.current.clear();
    useConversation.getState().reset();
    const id = useConversation
      .getState()
      .createTurn({ role: 'user', parentId: null });
    setActiveId(id);
    setInput(START_SEED);
    editor.centerOnPoint(
      { x: CARD_WIDTH / 2, y: CARD_HEIGHT_MIN / 2 + 90 },
      SMOOTH_CAMERA,
    );
  }, []);

  const rerunSession = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor || busy) return;
    const turns = useConversation.getState().turns;

    // Build user→assistant pairs from the graph (parent edges, not positions).
    const pairs: { userId: TurnId; assistantId: TurnId }[] = [];
    for (const t of Object.values(turns)) {
      if (t.role !== 'user' || t.content.trim() === '') continue;
      const child = Object.values(turns).find(
        (c) => c.parentId === t.id && c.role === 'assistant',
      );
      if (child) pairs.push({ userId: t.id, assistantId: child.id });
    }
    if (pairs.length === 0) return;

    // Wipe stale precache + meta on the assistants being rerun.
    precacheRef.current.clear();
    precacheInFlightRef.current.clear();
    for (const { assistantId } of pairs) {
      const a = useConversation.getState().getTurn(assistantId);
      if (a) {
        useConversation.setState((s) => ({
          turns: {
            ...s.turns,
            [assistantId]: { ...a, meta: {} },
          },
        }));
      }
    }

    setBusy(true);
    try {
      for (const { userId, assistantId } of pairs) {
        const userT = useConversation.getState().getTurn(userId);
        if (!userT) continue;
        useConversation
          .getState()
          .setContent(assistantId, '', { streaming: true });
        const history = historyFor(userId);
        const emphasized = gatherEmphasized();
        let buffer = '';
        try {
          await streamGenerate(
            userT.content,
            history.slice(0, -1),
            (delta) => {
              buffer += delta;
              useConversation
                .getState()
                .setContent(assistantId, buffer, { streaming: true });
            },
            undefined,
            emphasized,
            [],
            buildGraphSnapshot(),
          );
        } catch (err) {
          useConversation
            .getState()
            .setContent(
              assistantId,
              `[error: ${(err as Error).message}]`,
              { streaming: false },
            );
          continue;
        }
        useConversation
          .getState()
          .setContent(assistantId, buffer, { streaming: false });

        const spans = extractSpans(stripMarkdown(buffer).plain);
        if (spans.length > 0) {
          useConversation.getState().setChipSpans(assistantId, spans);
          if (precacheEnabledRef.current) {
            warmCache(assistantId, spans.map((s) => s.question));
          }
        }

        const fullHistory = [
          ...history,
          { role: 'assistant' as const, content: buffer },
        ];
        fetchAgentPredictions(fullHistory)
          .then((predictions) => {
            useConversation
              .getState()
              .setPredictions(assistantId, predictions);
            if (precacheEnabledRef.current) {
              warmCache(
                assistantId,
                predictions.map((p) => p.label.trim()),
              );
            }
          })
          .catch(() => {});
      }
    } finally {
      setBusy(false);
    }
  }, [busy, historyFor, gatherEmphasized, warmCache, buildGraphSnapshot]);

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
        setCtxMenu({ x: e.clientX, y: e.clientY, shape: card });
      }}
    >
      <Tldraw
        shapeUtils={shapeUtils}
        components={components}
        onMount={handleMount}
        persistenceKey="river-2-graph"
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
        <button
          type="button"
          onClick={startNew}
          aria-label="Start a new canvas"
          data-testid="start-new"
          style={toolbarBtn}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
          new
        </button>

        <button
          type="button"
          onClick={rerunSession}
          disabled={busy}
          aria-label="Re-stream every assistant turn"
          data-testid="rerun-session"
          title="Re-run every turn in the graph using the regenerated history of ancestors."
          style={{
            ...toolbarBtn,
            color: busy ? '#aaa' : '#111',
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.6 : 1,
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M3 12a9 9 0 0 1 15.5-6.3M21 12a9 9 0 0 1-15.5 6.3M21 4v5h-5M3 20v-5h5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          rerun
        </button>

        <button
          type="button"
          onClick={() => setPrecacheEnabled((v) => !v)}
          aria-label="Toggle pre-caching of branch responses"
          data-testid="toggle-precache"
          title="When on, every chip and presumption is pre-fetched in the background so clicks render instantly. Costs extra API calls."
          style={{
            ...toolbarBtn,
            background: precacheEnabled ? '#1f6f4a' : '#fff',
            color: precacheEnabled ? '#fff' : '#1f6f4a',
            border: '1px solid #1f6f4a',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill={precacheEnabled ? 'currentColor' : 'none'}
            />
          </svg>
          {precacheEnabled ? 'precache on' : 'precache off'}
        </button>
      </div>

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
  onNewConversation,
  onBranch,
  onCopy,
  onDelete,
}: {
  x: number;
  y: number;
  shape: CardShape | null;
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
        onClick={onNewConversation}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
        New conversation
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

const CARD_GAP_Y = 40;
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
  const root = turnIds.find((id) => !hasParent.has(id));
  if (!root) return;

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
  computeCols(root);

  // Pre-order: assign x,y. Anchor at (0,0) — simple, predictable.
  const originX = 0;
  const originY = 0;
  function assign(id: TurnId, colOffset: number, y: number): void {
    const shape = editor.getShape(id) as unknown as CardShape | undefined;
    if (!shape) return;
    const x = originX + colOffset * COLUMN_WIDTH;
    if (Math.abs(shape.x - x) >= 1 || Math.abs(shape.y - y) >= 1) {
      editor.updateShape({ id, type: 'card', x, y });
    }
    const bottom = y + shape.props.h;
    const kids = children.get(id) ?? [];
    let offset = 0;
    for (const c of kids) {
      assign(c, colOffset + offset, bottom + CARD_GAP_Y);
      offset += cols.get(c) ?? 1;
    }
  }
  assign(root, 0, originY);
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
}

// `toRichText` and `TLShapeId` are still used by sync/edge creation —
// re-export so unused imports don't trip TS strict mode if logic shifts.
export type { TLShapeId };
const _keepImports = toRichText;
void _keepImports;
