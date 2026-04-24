import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Tldraw,
  toRichText,
  EASINGS,
  type Editor,
  type TLShapeId,
  createShapeId,
  type TLComponents,
} from 'tldraw';
import {
  CardShapeUtil,
  CARD_WIDTH,
  CARD_HEIGHT_MIN,
  type CardShape,
} from './CardShape';

const ACTIVE_CARD_HEIGHT = 170;
import { CardActionsContext } from './CardActions';
import {
  fetchChipQuestions,
  fetchReflections,
  streamGenerate,
  type ChatMessage,
} from './api';

const shapeUtils = [CardShapeUtil];

const SMOOTH_CAMERA = {
  animation: { duration: 500, easing: EASINGS.easeOutCubic },
} as const;

// Prototype-only seed: pre-fill the input on fresh sessions so the dev can
// hammer Enter and compare responses across iterations using the same prompt.
const START_SEED = 'LUCKFOX PicoKVM Base vs NanoKVM';

// Suppress tldraw's built-in context menu — we render our own.
// Setting to null makes tldraw fall through to rendering <Canvas /> directly.
const components: TLComponents = {
  ContextMenu: null,
};

interface CtxMenu {
  x: number;
  y: number;
  shape: CardShape | null;
}

export function App() {
  const editorRef = useRef<Editor | null>(null);
  const [activeId, setActiveId] = useState<TLShapeId | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const inputWrapRef = useRef<HTMLDivElement | null>(null);
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const [reflectionsVisible, setReflectionsVisible] = useState(true);
  // Mirror state in a ref so async spawners (fired from .then) read the
  // current toggle without needing to re-create callbacks on each change.
  const reflectionsVisibleRef = useRef(true);
  useEffect(() => {
    reflectionsVisibleRef.current = reflectionsVisible;
  }, [reflectionsVisible]);

  // Precache toggle: when on, after each assistant card completes we fire
  // background main-model calls for every chip's contextual question and every
  // presumption's promotion prompt. The full responses are stashed in
  // precacheRef keyed by `${parentId}::${prompt}`. Branch clicks then hit the
  // cache and render the assistant content instantly instead of streaming.
  const [precacheEnabled, setPrecacheEnabled] = useState(false);
  const precacheEnabledRef = useRef(false);
  useEffect(() => {
    precacheEnabledRef.current = precacheEnabled;
  }, [precacheEnabled]);
  const precacheRef = useRef<Map<string, string>>(new Map());
  const precacheInFlightRef = useRef<Set<string>>(new Set());
  const precacheKey = (parentId: TLShapeId | string, prompt: string) =>
    `${parentId}::${prompt}`;

  const handleMount = useCallback((editor: Editor) => {
    editorRef.current = editor;
    // Dev-only debug handle. Remove before shipping.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__editor__ = editor;

    // Force animation speed to 1 regardless of OS "reduce motion" preference.
    // Our programmatic camera moves are purposeful UX, not decorative — without
    // this override, reduced-motion users see them snap instantly.
    editor.user.updateUserPreferences({ animationSpeed: 1 });

    // Lock to hand tool — drag anywhere pans the camera. The select tool's
    // marquee box is wrong for a chat canvas, and the hand tool naturally
    // makes cards unmovable since it only pans, never translates shapes.
    // Card buttons/chips still receive pointer events (they stopPropagation
    // before tldraw sees them).
    editor.setCurrentTool('hand');
    editor.store.listen(
      () => {
        if (editor.getCurrentToolId() !== 'hand') {
          editor.setCurrentTool('hand');
        }
      },
      { source: 'user', scope: 'session' },
    );

    // On every mount, re-sync reflection arrows to the current toggle state —
    // the effect alone runs before editorRef is populated and would no-op,
    // leaving arrows at whatever opacity was persisted last session.
    syncReflectionArrows(editor, reflectionsVisibleRef.current);

    // Sweep orphaned arrows from prior sessions: any arrow whose bindings no
    // longer reach an existing shape. Accumulates across hot-reloads and crash
    // recoveries if shapes were deleted without the arrow being cleaned.
    {
      const arrows = editor
        .getCurrentPageShapes()
        .filter((s) => s.type === 'arrow');
      const orphanIds: TLShapeId[] = [];
      for (const a of arrows) {
        const bs = editor.getBindingsFromShape(a, 'arrow');
        if (bs.length < 2) {
          orphanIds.push(a.id);
          continue;
        }
        const missing = bs.some((b) => !editor.getShape(b.toId as TLShapeId));
        if (missing) orphanIds.push(a.id);
      }
      if (orphanIds.length) editor.deleteShapes(orphanIds);
    }

    const hasAny = editor.getCurrentPageShapes().some((s) => s.type === 'card');
    if (!hasAny) {
      const id = createShapeId();
      editor.createShape({
        id,
        type: 'card',
        x: -CARD_WIDTH / 2,
        y: -CARD_HEIGHT_MIN / 2,
          props: {
          w: CARD_WIDTH,
          h: ACTIVE_CARD_HEIGHT,
          role: 'user',
          layer: 'action',
          emphasis: 1,
          content: '',
          streaming: false,
        },
      });
      setActiveId(id);
      setInput(START_SEED);
      // Center at origin with zoom 1 — predictable placement for mobile.
      editor.setCamera({ x: window.innerWidth / 2, y: 180, z: 1 }, { animation: { duration: 0 } });
    } else {
      // Use the last-updated user card as active, or fall back to anything
      const userCards = editor
        .getCurrentPageShapes()
        .filter((s) => s.type === 'card') as unknown as CardShape[];
      const lastEmptyUser = [...userCards]
        .reverse()
        .find((c) => c.props.role === 'user' && c.props.content.trim() === '');
      setActiveId(lastEmptyUser?.id ?? userCards[userCards.length - 1]?.id ?? null);
    }
  }, []);

  const historyFor = useCallback((leafId: TLShapeId | null): ChatMessage[] => {
    const editor = editorRef.current;
    if (!editor || leafId == null) return [];
    // Walk arrows upward from the leaf to reconstruct the exact chain of
    // ancestors — branches leave the X-column, so positional heuristics would
    // lose context. Reflection cards are skipped; presumption cards are a
    // sidebar, not parents.
    const chain: CardShape[] = [];
    const seen = new Set<TLShapeId>();
    let currentId: TLShapeId | null = leafId;
    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      const card = editor.getShape(currentId) as unknown as CardShape | undefined;
      if (!card || card.type !== 'card') break;
      if (
        card.props.layer !== 'reflection' &&
        (card.props.role === 'user' || card.props.role === 'assistant')
      ) {
        chain.push(card);
      }
      // Parent = the card on the 'start' end of any arrow ending on this card.
      const incoming: { fromId: TLShapeId }[] = editor
        .getBindingsToShape(currentId, 'arrow')
        .filter((b) => b.props.terminal === 'end') as { fromId: TLShapeId }[];
      if (incoming.length === 0) break;
      const arrowId: TLShapeId = incoming[0].fromId;
      const startBinding: { toId: TLShapeId } | undefined = editor
        .getBindingsFromShape(arrowId, 'arrow')
        .find((b) => b.props.terminal === 'start') as { toId: TLShapeId } | undefined;
      currentId = startBinding?.toId ?? null;
    }
    return chain
      .reverse()
      .filter((c) => c.props.content.trim() !== '')
      .map((c) => ({
        role: c.props.role as 'user' | 'assistant',
        content: c.props.content,
      }));
  }, []);

  // Walk one step up the arrow graph to find a card's parent (the card on the
  // 'start' end of the arrow whose 'end' terminal binds to this card).
  const getParentId = useCallback(
    (childId: TLShapeId): TLShapeId | null => {
      const editor = editorRef.current;
      if (!editor) return null;
      const incoming = editor
        .getBindingsToShape(childId, 'arrow')
        .filter((b) => b.props.terminal === 'end') as { fromId: TLShapeId }[];
      if (incoming.length === 0) return null;
      const arrowId = incoming[0].fromId;
      const startBinding = editor
        .getBindingsFromShape(arrowId, 'arrow')
        .find((b) => b.props.terminal === 'start') as
        | { toId: TLShapeId }
        | undefined;
      return startBinding?.toId ?? null;
    },
    [],
  );

  // Background-fetch the assistant response for a hypothetical branch, keyed
  // by `${parentId}::${prompt}`. Used by the precache toggle to make pill /
  // presumption clicks render instantly. Skips already-cached entries.
  const warmCache = useCallback(
    (parentAssistantId: TLShapeId, prompts: string[]) => {
      if (prompts.length === 0) return;
      const editor = editorRef.current;
      if (!editor) return;
      const history = historyFor(parentAssistantId);
      const emphasized = gatherEmphasized(editor);
      for (const prompt of prompts) {
        const key = precacheKey(parentAssistantId, prompt);
        if (precacheRef.current.has(key) || precacheInFlightRef.current.has(key))
          continue;
        precacheInFlightRef.current.add(key);
        let buffer = '';
        streamGenerate(prompt, history, (d) => { buffer += d; }, undefined, emphasized)
          .then(() => {
            precacheRef.current.set(key, buffer);
          })
          .catch(() => {})
          .finally(() => {
            precacheInFlightRef.current.delete(key);
          });
      }
    },
    [historyFor],
  );

  // Sync reflection-arrow opacity to the X-ray toggle. Arrows have their own
  // opacity property — the card's opacity doesn't cascade. Because the
  // arrows are isLocked to prevent user drag, we unlock → update → relock;
  // locked tldraw shapes silently reject updateShape calls.
  useEffect(() => {
    syncReflectionArrows(editorRef.current, reflectionsVisible);
  }, [reflectionsVisible]);

  // Mobile: track the visual viewport so the input bar stays above the
  // software keyboard instead of being hidden behind it.
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

  const runTurnFrom = useCallback(
    async (userCardId: TLShapeId, text: string) => {
      const editor = editorRef.current;
      if (!editor || busy) return;

      // Only the main-flow active card should shift input state and activeId
      // when its turn finishes. Side-flows (pill branches, reflection
      // promotion) run their own thread and must leave the user's main input
      // alone — otherwise the original empty user card loses active status
      // and the non-active CardBody renders its empty-content fallback
      // ('thinking…') permanently.
      const isFromActive = userCardId === activeId;

      setBusy(true);
      if (isFromActive) setInput('');

      // Commit user text. Works for empty-active cards and for freshly-created
      // branch cards alike.
      editor.updateShape({
        id: userCardId,
        type: 'card',
        props: { content: text, streaming: false },
      });

      const parent = editor.getShape(userCardId) as unknown as CardShape;
      const assistantId = createShapeId();
      editor.createShape({
        id: assistantId,
        type: 'card',
        x: parent.x,
        y: parent.y + parent.props.h + CARD_GAP_Y,
          props: {
          w: CARD_WIDTH,
          h: CARD_HEIGHT_MIN,
          role: 'assistant',
          layer: 'action',
          emphasis: 1,
          content: '',
          streaming: true,
        },
      });
      connect(editor, userCardId, assistantId);
      relayoutAll(editor);

      try {
        const history = historyFor(userCardId);
        // Collect all emphasized card contents in the conversation — these get
        // injected as priority constraints into the system prompt.
        const emphasized = gatherEmphasized(editor);
        // Cache lookup: pill clicks and reflection promotions may have been
        // pre-warmed with the precache toggle on. Cache key uses the parent
        // (the assistant the branch springs from) + the prompt, which uniquely
        // determines the would-be response.
        const branchParentId = getParentId(userCardId);
        const cacheK = branchParentId ? precacheKey(branchParentId, text) : null;
        const cached = cacheK ? precacheRef.current.get(cacheK) : undefined;
        let buffer = '';
        if (cached !== undefined) {
          buffer = cached;
          editor.updateShape({
            id: assistantId,
            type: 'card',
            props: { content: buffer, streaming: false },
          });
        } else {
          await streamGenerate(
            text,
            history.slice(0, -1),
            (delta) => {
              buffer += delta;
              editor.updateShape({
                id: assistantId,
                type: 'card',
                props: { content: buffer, streaming: true },
              });
            },
            undefined,
            emphasized,
          );
          editor.updateShape({
            id: assistantId,
            type: 'card',
            props: { content: buffer, streaming: false },
          });
        }

        const assistant = editor.getShape(assistantId) as unknown as CardShape;
        if (isFromActive) {
          const nextId = createShapeId();
          const nextY = assistant.y + assistant.props.h + CARD_GAP_Y;
          editor.createShape({
            id: nextId,
            type: 'card',
            x: assistant.x,
            y: nextY,
            props: {
              w: CARD_WIDTH,
              h: CARD_HEIGHT_MIN,
              role: 'user',
              layer: 'action',
              emphasis: 1,
              content: '',
              streaming: false,
            },
          });
          connect(editor, assistantId, nextId);
          relayoutAll(editor);
          setActiveId(nextId);

          const inputH = inputWrapRef.current?.offsetHeight ?? 140;
          const viewportH =
            window.visualViewport?.height ?? window.innerHeight ?? 800;
          const zoom = editor.getCamera().z || 1;
          const desiredScreenY = Math.max(140, viewportH - inputH - 120);
          const shift = (viewportH / 2 - desiredScreenY) / zoom;
          editor.centerOnPoint(
            {
              x: assistant.x + CARD_WIDTH / 2,
              y: nextY + CARD_HEIGHT_MIN / 2 + shift,
            },
            SMOOTH_CAMERA,
          );
        }

        // Fetch contextual questions for each [[term]] chip in the response.
        // The model emits bare [[X]] reliably (the wiki-link prior in Sonnet
        // resists any combined-syntax attempt); a quick Haiku call generates
        // anchored questions for them, which the chip click handler reads
        // from card meta.
        const chipTerms = Array.from(
          new Set(
            [...buffer.matchAll(/\[\[([^\[\]]+?)\]\]/g)].map((m) =>
              m[1].trim(),
            ),
          ),
        );
        if (chipTerms.length > 0) {
          fetchChipQuestions(buffer, chipTerms)
            .then((questions) => {
              const a = editor.getShape(assistantId) as unknown as
                | CardShape
                | undefined;
              if (!a) return;
              editor.updateShape({
                id: assistantId,
                type: 'card',
                meta: { ...(a.meta ?? {}), chipQuestions: questions },
              });
              if (precacheEnabledRef.current) {
                warmCache(assistantId, Object.values(questions));
              }
            })
            .catch(() => {});
        }

        // Spawn the reflection layer: presumption cards that surface the
        // implicit frame of this exchange, placed alongside the just-finished
        // assistant card in a parallel column, each tied by a dashed arrow.
        const fullHistory = [...history, { role: 'assistant' as const, content: buffer }];
        fetchReflections(fullHistory)
          .then((presumptions) => {
            spawnPresumptions(
              editor,
              assistantId,
              presumptions,
              reflectionsVisibleRef.current,
            );
            relayoutAll(editor);
            if (precacheEnabledRef.current) {
              // promoteReflection sends the label lower-cased-first as the
              // prompt; mirror that exactly so the cache key matches at click.
              const promotionPrompts = presumptions.map((p) => {
                const label = p.label.trim();
                return label.charAt(0).toLowerCase() + label.slice(1);
              });
              warmCache(assistantId, promotionPrompts);
            }
          })
          .catch(() => {});
      } catch (err) {
        console.error('generate failed', err);
        editor.updateShape({
          id: assistantId,
          type: 'card',
          props: { content: `[error: ${(err as Error).message}]`, streaming: false },
        });
      } finally {
        setBusy(false);
      }
    },
    [busy, activeId, historyFor, getParentId, warmCache],
  );

  const handleSubmit = useCallback(
    async (overrideText?: string) => {
      if (!activeId) return;
      const text = (overrideText ?? input).trim();
      if (!text) return;
      await runTurnFrom(activeId, text);
    },
    [activeId, input, runTurnFrom],
  );

  const createBranchUserCard = useCallback((sourceId: TLShapeId): TLShapeId | null => {
    const editor = editorRef.current;
    if (!editor) return null;
    const source = editor.getShape(sourceId) as unknown as CardShape | undefined;
    if (!source) return null;
    const newId = createShapeId();
    const branchX = source.x + CARD_WIDTH + 80;
    const branchY = source.y;
    editor.createShape({
      id: newId,
      type: 'card',
      x: branchX,
      y: branchY + source.props.h + CARD_GAP_Y,
      props: {
        w: CARD_WIDTH,
        h: ACTIVE_CARD_HEIGHT,
        role: 'user',
          layer: 'action',
          emphasis: 1,
        content: '',
        streaming: false,
      },
    });
    connect(editor, sourceId, newId);
    relayoutAll(editor);
    const placed = editor.getShape(newId) as unknown as CardShape | undefined;
    if (placed) {
      editor.centerOnPoint(
        { x: placed.x + CARD_WIDTH / 2, y: placed.y + CARD_HEIGHT_MIN / 2 },
        SMOOTH_CAMERA,
      );
    }
    return newId;
  }, []);

  const branchFrom = useCallback(
    (turnId: TLShapeId) => {
      const newId = createBranchUserCard(turnId);
      if (newId) setActiveId(newId);
    },
    [createBranchUserCard],
  );

  const branchAbout = useCallback(
    (sourceId: TLShapeId, prompt: string) => {
      // The chip already carries the contextual question (the model emitted
      // `[[term|question]]` in the same response). No second round-trip.
      const newId = createBranchUserCard(sourceId);
      if (!newId) return;
      void runTurnFrom(newId, prompt);
    },
    [createBranchUserCard, runTurnFrom],
  );

  const promoteReflection = useCallback(
    (presumptionId: TLShapeId) => {
      const editor = editorRef.current;
      if (!editor) return;
      const p = editor.getShape(presumptionId) as unknown as CardShape | undefined;
      if (!p || p.props.role !== 'presumption') return;
      // Promote the reflection in place — it IS the user turn now, no need to
      // clone its text into a new card. Flip role to 'user' and layer to
      // 'action' so history-walking includes it, then run the turn from this
      // same card. runTurnFrom will re-commit the content (with normalized
      // casing) and spawn the assistant + next-user chain directly below.
      editor.updateShape({
        id: presumptionId,
        type: 'card',
        props: {
          ...p.props,
          role: 'user',
          layer: 'action',
        },
      });
      const label = p.props.content.trim();
      const query = label.charAt(0).toLowerCase() + label.slice(1);
      void runTurnFrom(presumptionId, query);
    },
    [runTurnFrom],
  );

  const toggleEmphasis = useCallback((id: TLShapeId) => {
    const editor = editorRef.current;
    if (!editor) return;
    const s = editor.getShape(id) as unknown as CardShape | undefined;
    if (!s) return;
    const next = (s.props.emphasis ?? 1) >= 2 ? 1 : 2;
    editor.updateShape({ id, type: 'card', props: { emphasis: next } });
  }, []);

  const deleteCard = useCallback(
    (turnId: TLShapeId) => {
      const editor = editorRef.current;
      if (!editor) return;
      // Walk arrow bindings to collect the full subtree — deleting a card should
      // remove everything downstream, since cutting a link mid-chain would leave
      // orphan context that's no longer reachable from any conversation root.
      const toDelete = new Set<TLShapeId>();
      const queue: TLShapeId[] = [turnId];
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (toDelete.has(current)) continue;
        toDelete.add(current);
        const bindings = editor.getBindingsToShape(current, 'arrow');
        for (const b of bindings) {
          if (b.props.terminal !== 'start') continue;
          const arrow = editor.getShape(b.fromId);
          if (!arrow) continue;
          const endBinding = editor
            .getBindingsFromShape(arrow, 'arrow')
            .find((x) => x.props.terminal === 'end');
          if (endBinding) queue.push(endBinding.toId as TLShapeId);
        }
      }
      editor.deleteShapes([...toDelete]);

      // Re-seat active card: prefer most recent empty user card, else latest.
      const wasActiveDeleted = toDelete.has(activeId as TLShapeId);
      if (wasActiveDeleted) {
        const remaining = editor
          .getCurrentPageShapes()
          .filter((s) => s.type === 'card') as unknown as CardShape[];
        const emptyUser = [...remaining]
          .reverse()
          .find((c) => c.props.role === 'user' && c.props.content.trim() === '');
        const latest = remaining[remaining.length - 1];
        setActiveId(emptyUser?.id ?? latest?.id ?? null);
      }
    },
    [activeId],
  );

  const startNew = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    // Cache is per-conversation: chip prompts and presumption prompts collide
    // by string across conversations and would serve stale responses.
    precacheRef.current.clear();
    precacheInFlightRef.current.clear();
    const all = editor.getCurrentPageShapes().map((s) => s.id);
    if (all.length > 0) editor.deleteShapes(all);
    const id = createShapeId();
    editor.createShape({
      id,
      type: 'card',
      x: -CARD_WIDTH / 2,
      y: -CARD_HEIGHT_MIN / 2,
      props: {
        w: CARD_WIDTH,
        h: ACTIVE_CARD_HEIGHT,
        role: 'user',
          layer: 'action',
          emphasis: 1,
        content: '',
        streaming: false,
      },
    });
    setActiveId(id);
    setInput(START_SEED);
    editor.centerOnPoint({ x: 0, y: 0 }, SMOOTH_CAMERA);
  }, []);

  function onInputChange(text: string): void {
    setInput(text);
  }

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

  const resizeCard = useCallback((id: TLShapeId, h: number) => {
    const editor = editorRef.current;
    if (!editor) return;
    const current = editor.getShape(id) as unknown as CardShape | undefined;
    if (!current) return;
    if (Math.abs(current.props.h - h) >= 1) {
      editor.updateShape({ id, type: 'card', props: { h } });
    }
    if (current.props.layer === 'reflection') {
      // Reflection cards shrink to their short labels after measurement; they
      // were initially placed assuming CARD_HEIGHT_MIN, leaving big gaps.
      // Re-stack the whole sidebar against actual measured heights.
      const sourceId = (
        current.meta as { reflectionSource?: TLShapeId } | undefined
      )?.reflectionSource;
      if (sourceId) restackReflections(editor, sourceId);
      return;
    }
    // After any resize, re-flow downstream cards so the vertical gap between
    // parent-bottom and child-top stays constant. This keeps the elbow arrows
    // short and uniform even when cards shrink after their initial placement.
    repositionChain(editor, id);
  }, []);

  return (
    <CardActionsContext.Provider
      value={{
        branchFrom,
        branchAbout,
        promoteReflection,
        toggleEmphasis,
        deleteCard,
        activeId,
        reflectionsVisible,
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
        persistenceKey="river-2-reflection"
        hideUi
        inferDarkMode={false}
      />

      {/* Top-left toolbar: start new session */}
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
          style={{
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
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
          new
        </button>

        <button
          type="button"
          onClick={() => setReflectionsVisible((v) => !v)}
          aria-label="Toggle reflection layer"
          data-testid="toggle-reflections"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '10px 14px',
            background: reflectionsVisible ? '#4a2d6b' : '#fff',
            color: reflectionsVisible ? '#fff' : '#4a2d6b',
            border: '1px solid #4a2d6b',
            borderRadius: 999,
            font: 'inherit',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
            boxShadow: '0 3px 10px rgba(0,0,0,0.1)',
            WebkitTapHighlightColor: 'transparent',
            minHeight: 40,
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2" fill={reflectionsVisible ? 'currentColor' : 'none'} />
          </svg>
          {reflectionsVisible ? 'reflection on' : 'reflection off'}
        </button>

        <button
          type="button"
          onClick={() => setPrecacheEnabled((v) => !v)}
          aria-label="Toggle pre-caching of branch responses"
          data-testid="toggle-precache"
          title="When on, every chip and presumption is pre-fetched in the background so clicks render instantly. Costs extra API calls."
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '10px 14px',
            background: precacheEnabled ? '#1f6f4a' : '#fff',
            color: precacheEnabled ? '#fff' : '#1f6f4a',
            border: '1px solid #1f6f4a',
            borderRadius: 999,
            font: 'inherit',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
            boxShadow: '0 3px 10px rgba(0,0,0,0.1)',
            WebkitTapHighlightColor: 'transparent',
            minHeight: 40,
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

      {/* Bottom hint area is only shown when there's no active card to host the input */}
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
        /* Ensure tldraw canvas background matches our cream tone */
        .tl-container, .tl-background { background: #f7f6f2 !important; }
        /* Hide horizontal scroll bar on mist pill strip */
        .river-input-wrap ::-webkit-scrollbar { display: none; }
        /* Card actions fade in on hover — ambient when idle, discoverable on interaction */
        .river-card:hover .river-card-actions { opacity: 1 !important; }
        .river-card-actions button:hover { background: rgba(0,0,0,0.06) !important; }
      `}</style>
    </div>
    </CardActionsContext.Provider>
  );
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
  onNewConversation,
  onBranch,
  onDelete,
}: {
  x: number;
  y: number;
  shape: CardShape | null;
  onNewConversation: () => void;
  onBranch: () => void;
  onDelete: () => void;
}) {
  const menuW = 180;
  const menuRef = useRef<HTMLDivElement>(null);

  // Clamp so the menu stays on-screen.
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
// Reflections stack as a tight sidebar — they're alternate angles on the same
// turn, so visually they should read as a list, not a separate conversation.
const REFLECTION_GAP_Y = 10;

/**
 * Tidy-tree layout. Anchors on the current root's (x, y) and recomputes every
 * card position so siblings never overlap: each branch gets its own column,
 * and each column's width equals the sum of its descendants' columns.
 */
function relayoutAll(editor: Editor): void {
  const shapes = editor
    .getCurrentPageShapes()
    .filter((s): s is CardShape => s.type === 'card')
    .filter((s) => s.props.layer !== 'reflection') as unknown as CardShape[];
  if (shapes.length === 0) return;

  // Build parent → children map via arrow bindings.
  const children = new Map<TLShapeId, TLShapeId[]>();
  const hasParent = new Set<TLShapeId>();
  for (const s of shapes) children.set(s.id, []);
  for (const s of shapes) {
    const bindings = editor.getBindingsToShape(s.id, 'arrow');
    for (const b of bindings) {
      if (b.props.terminal !== 'start') continue;
      const arrow = editor.getShape(b.fromId);
      if (!arrow) continue;
      const endBinding = editor
        .getBindingsFromShape(arrow, 'arrow')
        .find((x) => x.props.terminal === 'end');
      if (!endBinding) continue;
      const childId = endBinding.toId as TLShapeId;
      const childShape = editor.getShape(childId) as unknown as CardShape | undefined;
      // Reflection children don't participate in action-tree layout — they're
      // positioned by spawnPresumptions in their own sidebar column.
      if (!childShape || childShape.props.layer === 'reflection') continue;
      children.get(s.id)?.push(childId);
      hasParent.add(childId);
    }
  }

  const root = shapes.find((s) => !hasParent.has(s.id));
  if (!root) return;

  // Post-order: column count each subtree occupies.
  const cols = new Map<TLShapeId, number>();
  function computeCols(id: TLShapeId): number {
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
  computeCols(root.id);

  // Pre-order: assign x,y. The first child inherits the parent's column; each
  // subsequent child opens a new column offset by the accumulated widths.
  const originX = root.x;
  const originY = root.y;
  function assign(id: TLShapeId, colOffset: number, y: number): void {
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
  assign(root.id, 0, originY);
}

/**
 * Walk outgoing arrow bindings from `sourceId` and reposition each child card
 * so its top sits exactly `CARD_GAP_Y` below the source's bottom. Recurses
 * down the chain and across branches.
 */
function repositionChain(editor: Editor, sourceId: TLShapeId): void {
  const source = editor.getShape(sourceId) as unknown as CardShape | undefined;
  if (!source) return;
  const targetY = source.y + source.props.h + CARD_GAP_Y;

  const bindings = editor.getBindingsToShape(sourceId, 'arrow');
  for (const b of bindings) {
    if (b.props.terminal !== 'start') continue;
    const arrow = editor.getShape(b.fromId);
    if (!arrow) continue;
    const endBinding = editor
      .getBindingsFromShape(arrow, 'arrow')
      .find((x) => x.props.terminal === 'end');
    if (!endBinding) continue;
    const childId = endBinding.toId as TLShapeId;
    const child = editor.getShape(childId) as unknown as CardShape | undefined;
    if (!child) continue;
    // Reflection-layer cards have their own vertical stacking in the sidebar
    // column — don't drag them into the action chain's flow.
    if (child.props.layer === 'reflection') continue;
    if (Math.abs(child.y - targetY) >= 1) {
      editor.updateShape({ id: childId, type: 'card', y: targetY });
    }
    repositionChain(editor, childId);
  }
}

/**
 * Re-stack all reflection-layer cards belonging to a given assistant source
 * so each presumption sits flush against the previous one's measured bottom.
 * Called after a presumption card's height settles via `resizeCard` —
 * presumptions are spawned at CARD_HEIGHT_MIN-stride and shrink afterwards,
 * leaving big gaps unless we re-pack them.
 */
function restackReflections(
  editor: Editor,
  sourceAssistantId: TLShapeId,
): void {
  const source = editor.getShape(sourceAssistantId) as unknown as
    | CardShape
    | undefined;
  if (!source) return;
  const cards = editor
    .getCurrentPageShapes()
    .filter((s): s is CardShape => s.type === 'card')
    .map((s) => s as unknown as CardShape)
    .filter(
      (c) =>
        c.props.layer === 'reflection' &&
        (c.meta as { reflectionSource?: TLShapeId } | undefined)
          ?.reflectionSource === sourceAssistantId,
    )
    .sort((a, b) => a.y - b.y);
  let y = source.y;
  for (const c of cards) {
    if (Math.abs(c.y - y) >= 1) {
      editor.updateShape({ id: c.id, type: 'card', y });
    }
    y += c.props.h + REFLECTION_GAP_Y;
  }
}

/**
 * Collect the content of every emphasized (emphasis >= 2) card. These strings
 * are injected as priority constraints at the top of the LLM system prompt,
 * so visual weight on the canvas becomes semantic weight in the model.
 */
function gatherEmphasized(editor: Editor): string[] {
  return editor
    .getCurrentPageShapes()
    .filter((s): s is CardShape => s.type === 'card')
    .map((s) => s as unknown as CardShape)
    .filter((c) => (c.props.emphasis ?? 1) >= 2 && c.props.content.trim() !== '')
    .map((c) => c.props.content.trim());
}

/**
 * Place reflection-layer presumption cards adjacent to the assistant they
 * reflect on. Styled as first-class citizens — same width and typographic
 * weight as the input card — so the reflections are equal-footing options,
 * not a background aside. Their lavender border and dashed provenance arrow
 * keep them readable as "the other layer."
 */
function syncReflectionArrows(editor: Editor | null, visible: boolean): void {
  if (!editor) return;
  const arrows = editor
    .getCurrentPageShapes()
    .filter(
      (s) =>
        s.type === 'arrow' &&
        (s.meta as { kind?: string } | undefined)?.kind === 'reflection',
    );
  const target = visible ? 0.7 : 0;
  for (const a of arrows) {
    if (a.opacity === target) continue;
    editor.updateShape({ id: a.id, type: 'arrow', isLocked: false });
    editor.updateShape({ id: a.id, type: 'arrow', opacity: target });
    editor.updateShape({ id: a.id, type: 'arrow', isLocked: true });
  }
}

function spawnPresumptions(
  editor: Editor,
  sourceAssistantId: TLShapeId,
  presumptions: Array<{ label: string; full: string }>,
  visible = true,
): void {
  if (!presumptions.length) return;
  const source = editor.getShape(sourceAssistantId) as unknown as CardShape | undefined;
  if (!source) return;

  // Walk right from the source's column until we find a column with no action
  // cards in the vertical band we'd occupy. Reflections now live to the right
  // of the assistant they reflect on; collision detection keeps them off of
  // any existing action branch column.
  const actionCards = editor
    .getCurrentPageShapes()
    .filter((s): s is CardShape => s.type === 'card')
    .map((s) => s as unknown as CardShape)
    .filter((c) => c.props.layer === 'action');
  const minY = source.y;
  const maxY =
    source.y + presumptions.length * (CARD_HEIGHT_MIN + REFLECTION_GAP_Y);
  let reflectX = source.x + CARD_WIDTH + CARD_GAP_X;
  const isOccupied = (x: number) =>
    actionCards.some(
      (c) =>
        Math.abs(c.x - x) < CARD_WIDTH / 2 &&
        c.y + c.props.h > minY &&
        c.y < maxY,
    );
  while (isOccupied(reflectX)) {
    reflectX += COLUMN_WIDTH;
  }

  let y = source.y;
  for (const p of presumptions) {
    const id = createShapeId();
    editor.createShape({
      id,
      type: 'card',
      x: reflectX,
      y,
      meta: { reflectionSource: sourceAssistantId, fullPresumption: p.full },
      props: {
        w: CARD_WIDTH,
        h: CARD_HEIGHT_MIN,
        role: 'presumption',
        layer: 'reflection',
        emphasis: 1,
        // Display the terse label — the full sentence lives in meta for hover.
        content: p.label,
        streaming: false,
      },
    });
    // Dashed lavender arrow from the assistant card to each presumption so
    // the provenance is visually explicit, not just positional.
    connectReflection(editor, sourceAssistantId, id, visible);
    // Advance by the actual measured-then-settled height (rough estimate
    // here; repositionChain would fix it if presumptions had children).
    y += CARD_HEIGHT_MIN + REFLECTION_GAP_Y;
  }
}


function connect(editor: Editor, fromId: TLShapeId, toId: TLShapeId): void {
  const arrowId = createShapeId();
  try {
    editor.createShape({
      id: arrowId,
      type: 'arrow',
      x: 0,
      y: 0,
      isLocked: true,
      props: {
        kind: 'elbow',
        color: 'grey',
        size: 's',
        dash: 'solid',
        arrowheadStart: 'none',
        arrowheadEnd: 'arrow',
        richText: toRichText(''),
      },
    });
    editor.createBinding({
      type: 'arrow',
      fromId: arrowId,
      toId: fromId,
      props: {
        terminal: 'start',
        normalizedAnchor: { x: 0.5, y: 1 },
        isExact: false,
        isPrecise: true,
        snap: 'none',
      },
    });
    editor.createBinding({
      type: 'arrow',
      fromId: arrowId,
      toId: toId,
      props: {
        terminal: 'end',
        normalizedAnchor: { x: 0.5, y: 0 },
        isExact: false,
        isPrecise: true,
        snap: 'none',
      },
    });
  } catch (err) {
    console.warn('connect failed — skipping arrow', err);
  }
}

/**
 * Reflection-layer arrow: dashed light-violet tie from an assistant card to
 * one of its presumptions on the right-side sidebar. Anchors right-to-left so
 * the arrow reads as "thinking leaking sideways," not as a continuation.
 */
function connectReflection(
  editor: Editor,
  fromId: TLShapeId,
  toId: TLShapeId,
  visible = true,
): void {
  const arrowId = createShapeId();
  try {
    editor.createShape({
      id: arrowId,
      type: 'arrow',
      x: 0,
      y: 0,
      isLocked: true,
      opacity: visible ? 0.7 : 0,
      meta: { kind: 'reflection' },
      props: {
        kind: 'elbow',
        color: 'light-violet',
        size: 's',
        dash: 'dashed',
        arrowheadStart: 'none',
        arrowheadEnd: 'arrow',
        richText: toRichText(''),
      },
    });
    editor.createBinding({
      type: 'arrow',
      fromId: arrowId,
      toId: fromId,
      props: {
        terminal: 'start',
        normalizedAnchor: { x: 1, y: 0.5 }, // right edge of assistant
        isExact: false,
        isPrecise: true,
        snap: 'none',
      },
    });
    editor.createBinding({
      type: 'arrow',
      fromId: arrowId,
      toId: toId,
      props: {
        terminal: 'end',
        normalizedAnchor: { x: 0, y: 0.5 }, // left edge of presumption
        isExact: false,
        isPrecise: true,
        snap: 'none',
      },
    });
  } catch (err) {
    console.warn('connectReflection failed — skipping arrow', err);
  }
}

