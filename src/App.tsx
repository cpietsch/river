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
  fetchMist,
  streamGenerate,
  type ChatMessage,
  type MistCandidate,
} from './api';

const shapeUtils = [CardShapeUtil];

const SMOOTH_CAMERA = {
  animation: { duration: 500, easing: EASINGS.easeOutCubic },
} as const;

// Prototype-only seed: pre-fill the input on fresh sessions so the dev can
// hammer Enter to watch a flow instead of thinking up a prompt each time.
const SEED_QUESTIONS = [
  'What is consciousness?',
  'Why do we dream?',
  'How did language evolve?',
  'What is dark matter?',
  'Why is the sky blue?',
  'What makes music emotional?',
  'How do birds navigate?',
  'What is time?',
  'Why do humans laugh?',
  'What is the purpose of sleep?',
  'How do plants communicate?',
  'What is beauty?',
  'Why do we have emotions?',
  'What is gravity?',
  'How do octopuses think?',
  'What is information?',
];
function randomSeed(): string {
  return SEED_QUESTIONS[Math.floor(Math.random() * SEED_QUESTIONS.length)];
}

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
  const [mist, setMist] = useState<MistCandidate[]>([]);
  const [busy, setBusy] = useState(false);
  const mistDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mistReqIdRef = useRef(0);
  const inputWrapRef = useRef<HTMLDivElement | null>(null);
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);

  const handleMount = useCallback((editor: Editor) => {
    editorRef.current = editor;
    // Dev-only debug handle. Remove before shipping.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__editor__ = editor;

    // Force animation speed to 1 regardless of OS "reduce motion" preference.
    // Our programmatic camera moves are purposeful UX, not decorative — without
    // this override, reduced-motion users see them snap instantly.
    editor.user.updateUserPreferences({ animationSpeed: 1 });

    // Lock to select tool — the user never creates tldraw-native shapes
    // directly. Any stray tool activation (keyboard shortcut, touch) would
    // let them scribble text/draw-strokes onto the canvas.
    editor.setCurrentTool('select');
    editor.store.listen(
      () => {
        if (editor.getCurrentToolId() !== 'select') {
          editor.setCurrentTool('select');
        }
      },
      { source: 'user', scope: 'session' },
    );

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
          content: '',
          streaming: false,
        },
      });
      setActiveId(id);
      setInput(randomSeed());
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
    // In v0 we rely on vertical stacking order: every card above the leaf
    // at roughly the same x is part of the chain. Simpler than walking arrows,
    // good enough for the prototype.
    const shapes = editor
      .getCurrentPageShapes()
      .filter((s): s is CardShape => s.type === 'card') as unknown as CardShape[];
    const leaf = shapes.find((c) => c.id === leafId);
    if (!leaf) return [];
    const chain = shapes
      .filter((c) => Math.abs(c.x - leaf.x) < 200 && c.y <= leaf.y)
      .sort((a, b) => a.y - b.y)
      .filter((c) => c.props.content.trim() !== '')
      .map((c) => ({ role: c.props.role, content: c.props.content }));
    return chain;
  }, []);

  const scheduleMist = useCallback(
    (text: string) => {
      if (mistDebounceRef.current) clearTimeout(mistDebounceRef.current);
      const myId = ++mistReqIdRef.current;
      if (text.trim() === '') {
        setMist([]);
        return;
      }
      mistDebounceRef.current = setTimeout(async () => {
        const history = historyFor(activeId);
        const candidates = await fetchMist(text, history);
        if (myId === mistReqIdRef.current) setMist(candidates);
      }, 600);
    },
    [activeId, historyFor],
  );

  useEffect(
    () => () => {
      if (mistDebounceRef.current) clearTimeout(mistDebounceRef.current);
    },
    [],
  );

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

      setBusy(true);
      setInput('');
      setMist([]);
      mistReqIdRef.current++;
      if (mistDebounceRef.current) clearTimeout(mistDebounceRef.current);

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
          content: '',
          streaming: true,
        },
      });
      connect(editor, userCardId, assistantId);
      relayoutAll(editor);

      try {
        const history = historyFor(userCardId);
        let buffer = '';
        await streamGenerate(text, history.slice(0, -1), (delta) => {
          buffer += delta;
          editor.updateShape({
            id: assistantId,
            type: 'card',
            props: { content: buffer, streaming: true },
          });
        });
        editor.updateShape({
          id: assistantId,
          type: 'card',
          props: { content: buffer, streaming: false },
        });

        const assistant = editor.getShape(assistantId) as unknown as CardShape;
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
            content: '',
            streaming: false,
          },
        });
        connect(editor, assistantId, nextId);
        relayoutAll(editor);
        setActiveId(nextId);

        const inputH = inputWrapRef.current?.offsetHeight ?? 140;
        const viewportH = window.visualViewport?.height ?? window.innerHeight ?? 800;
        const zoom = editor.getCamera().z || 1;
        const desiredScreenY = Math.max(140, viewportH - inputH - 120);
        const shift = (viewportH / 2 - desiredScreenY) / zoom;
        editor.centerOnPoint(
          { x: assistant.x + CARD_WIDTH / 2, y: nextY + CARD_HEIGHT_MIN / 2 + shift },
          SMOOTH_CAMERA,
        );

        const followUpId = ++mistReqIdRef.current;
        const fullHistory = [...history, { role: 'assistant' as const, content: buffer }];
        fetchMist('', fullHistory)
          .then((suggestions) => {
            if (mistReqIdRef.current === followUpId) setMist(suggestions);
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
    [busy, historyFor],
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

  function commitMist(c: MistCandidate) {
    setInput('');
    setMist([]);
    void handleSubmit(c.full);
  }

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
    (sourceId: TLShapeId, term: string) => {
      const newId = createBranchUserCard(sourceId);
      if (!newId) return;
      void runTurnFrom(newId, `Tell me more about ${term}.`);
    },
    [createBranchUserCard, runTurnFrom],
  );

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
        content: '',
        streaming: false,
      },
    });
    setActiveId(id);
    setInput(randomSeed());
    setMist([]);
    editor.centerOnPoint({ x: 0, y: 0 }, SMOOTH_CAMERA);
  }, []);

  function onInputChange(text: string): void {
    setInput(text);
    scheduleMist(text);
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
        deleteCard,
        activeId,
        input,
        setInput,
        onInputChange,
        mist,
        submit: handleSubmit,
        commitMist,
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
        persistenceKey="river-2"
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

/**
 * Tidy-tree layout. Anchors on the current root's (x, y) and recomputes every
 * card position so siblings never overlap: each branch gets its own column,
 * and each column's width equals the sum of its descendants' columns.
 */
function relayoutAll(editor: Editor): void {
  const shapes = editor
    .getCurrentPageShapes()
    .filter((s): s is CardShape => s.type === 'card') as unknown as CardShape[];
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
    if (Math.abs(child.y - targetY) >= 1) {
      editor.updateShape({ id: childId, type: 'card', y: targetY });
    }
    repositionChain(editor, childId);
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

