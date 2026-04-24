import { useCallback, useEffect, useRef, useState } from 'react';
import { Tldraw, toRichText, type Editor, type TLShapeId, createShapeId } from 'tldraw';
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

export function App() {
  const editorRef = useRef<Editor | null>(null);
  const [activeId, setActiveId] = useState<TLShapeId | null>(null);
  const [input, setInput] = useState('');
  const [mist, setMist] = useState<MistCandidate[]>([]);
  const [busy, setBusy] = useState(false);
  const mistDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mistReqIdRef = useRef(0);
  const inputWrapRef = useRef<HTMLDivElement | null>(null);

  const handleMount = useCallback((editor: Editor) => {
    editorRef.current = editor;

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

  const handleSubmit = useCallback(
    async (overrideText?: string) => {
      const editor = editorRef.current;
      if (!editor || !activeId) return;
      const text = (overrideText ?? input).trim();
      if (!text || busy) return;

      setBusy(true);
      setInput('');
      setMist([]);
      mistReqIdRef.current++;
      if (mistDebounceRef.current) clearTimeout(mistDebounceRef.current);

      // Commit user text into the active card
      editor.updateShape({
        id: activeId,
        type: 'card',
        props: { content: text, streaming: false },
      });
      growToFit(editor, activeId, text);

      const parent = editor.getShape(activeId) as unknown as CardShape;
      // Assistant card directly below the parent
      const assistantId = createShapeId();
      const assistantX = parent.x;
      const assistantY = parent.y + parent.props.h + 60;
      editor.createShape({
        id: assistantId,
        type: 'card',
        x: assistantX,
        y: assistantY,
        props: {
          w: CARD_WIDTH,
          h: CARD_HEIGHT_MIN,
          role: 'assistant',
          content: '',
          streaming: true,
        },
      });
      connect(editor, activeId, assistantId);

      try {
        const history = historyFor(activeId);
        let buffer = '';
        await streamGenerate(text, history.slice(0, -1), (delta) => {
          buffer += delta;
          editor.updateShape({
            id: assistantId,
            type: 'card',
            props: { content: buffer, streaming: true },
          });
          growToFit(editor, assistantId, buffer);
        });
        editor.updateShape({
          id: assistantId,
          type: 'card',
          props: { content: buffer, streaming: false },
        });

        // Spawn a fresh empty user card below the assistant
        const assistant = editor.getShape(assistantId) as unknown as CardShape;
        const nextId = createShapeId();
        const nextY = assistant.y + assistant.props.h + 60;
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
        setActiveId(nextId);

        // Center so the new empty tip sits above the input bar, not under it.
        const inputH = inputWrapRef.current?.offsetHeight ?? 140;
        const viewportH = window.visualViewport?.height ?? window.innerHeight ?? 800;
        // We want the tip card center to land roughly at screen-Y = viewportH - inputH - 120.
        // centerOnPoint places the given world point at the visual center, so shift the target
        // point DOWN by (viewportCenter - desiredScreenY) in world coords (at z=1).
        const zoom = editor.getCamera().z || 1;
        const desiredScreenY = Math.max(140, viewportH - inputH - 120);
        const shift = (viewportH / 2 - desiredScreenY) / zoom;
        editor.centerOnPoint(
          {
            x: assistant.x + CARD_WIDTH / 2,
            y: nextY + CARD_HEIGHT_MIN / 2 + shift,
          },
          { animation: { duration: 400 } },
        );
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
    [activeId, busy, historyFor, input],
  );

  function commitMist(c: MistCandidate) {
    setInput('');
    setMist([]);
    void handleSubmit(c.full);
  }

  const branchFrom = useCallback((turnId: TLShapeId) => {
    const editor = editorRef.current;
    if (!editor) return;
    const source = editor.getShape(turnId) as unknown as CardShape | undefined;
    if (!source) return;
    // Drop the existing empty-next-user placeholder(s) that might already be sitting
    // below the current tip — they're stale once the user picks a different branch point.
    // We simply place a fresh empty user card to the LEFT (new column) of the source so
    // the branch is visually distinct from the original chain.
    const newId = createShapeId();
    const branchX = source.x + CARD_WIDTH + 80;
    const branchY = source.y;
    editor.createShape({
      id: newId,
      type: 'card',
      x: branchX,
      y: branchY + source.props.h + 60,
      props: {
        w: CARD_WIDTH,
        h: ACTIVE_CARD_HEIGHT,
        role: 'user',
        content: '',
        streaming: false,
      },
    });
    connect(editor, turnId, newId);
    setActiveId(newId);
    editor.centerOnPoint(
      { x: branchX + CARD_WIDTH / 2, y: branchY + source.props.h + CARD_HEIGHT_MIN / 2 + 60 },
      { animation: { duration: 400 } },
    );
  }, []);

  const regenerate = useCallback((turnId: TLShapeId) => {
    const editor = editorRef.current;
    if (!editor) return;
    const target = editor.getShape(turnId) as unknown as CardShape | undefined;
    if (!target || target.props.role !== 'assistant') return;
    // Clear the assistant card's content and stream a new reply from its chain.
    editor.updateShape({
      id: turnId,
      type: 'card',
      props: { content: '', streaming: true },
    });
    void (async () => {
      const history = historyFor(turnId);
      let buffer = '';
      try {
        await streamGenerate('', history.slice(0, -1), (delta) => {
          buffer += delta;
          editor.updateShape({
            id: turnId,
            type: 'card',
            props: { content: buffer, streaming: true },
          });
          growToFit(editor, turnId, buffer);
        });
        editor.updateShape({
          id: turnId,
          type: 'card',
          props: { content: buffer, streaming: false },
        });
      } catch (err) {
        editor.updateShape({
          id: turnId,
          type: 'card',
          props: { content: `[error: ${(err as Error).message}]`, streaming: false },
        });
      }
    })();
  }, [historyFor]);

  const deleteCard = useCallback(
    (turnId: TLShapeId) => {
      const editor = editorRef.current;
      if (!editor) return;
      // Delete the card itself. tldraw bindings clean up the bound arrows automatically
      // when the card they're bound to disappears.
      editor.deleteShapes([turnId]);
      // If we deleted the active card, promote the most recent empty user card,
      // else the most recent user card of any kind.
      if (turnId === activeId) {
        const remaining = editor
          .getCurrentPageShapes()
          .filter((s): s is { id: TLShapeId } & CardShape => s.type === 'card')
          .map((s) => s as unknown as CardShape);
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
    setInput('');
    setMist([]);
    editor.centerOnPoint({ x: 0, y: 0 }, { animation: { duration: 200 } });
  }, []);

  function onInputChange(text: string): void {
    setInput(text);
    scheduleMist(text);
  }

  return (
    <CardActionsContext.Provider
      value={{
        branchFrom,
        regenerate,
        deleteCard,
        activeId,
        input,
        setInput,
        onInputChange,
        mist,
        submit: handleSubmit,
        commitMist,
        busy,
      }}
    >
    <div style={{ position: 'fixed', inset: 0 }}>
      <Tldraw
        shapeUtils={shapeUtils}
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


      <style>{`
        @keyframes river-cursor-blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
        .river-cursor { display: inline-block; margin-left: 2px; color: #4a90e2; animation: river-cursor-blink 0.9s step-end infinite; }
        /* Ensure tldraw canvas background matches our cream tone */
        .tl-container, .tl-background { background: #f7f6f2 !important; }
        /* Hide horizontal scroll bar on mist pill strip */
        .river-input-wrap ::-webkit-scrollbar { display: none; }
      `}</style>
    </div>
    </CardActionsContext.Provider>
  );
}

function growToFit(editor: Editor, id: TLShapeId, text: string): void {
  // Card inner content width ~= CARD_WIDTH - 24 padding = 296.
  // At 14px font, ~40 chars fit per line. Add slack for partial wrap words.
  const lines = text.trim() === '' ? 1 : Math.max(1, Math.ceil(text.length / 38));
  // header (~28) + content (lines * 22) + action row (~40) + vertical padding (~20)
  const desired = Math.max(CARD_HEIGHT_MIN, 88 + lines * 22);
  const s = editor.getShape(id) as unknown as CardShape | undefined;
  if (!s) return;
  if (s.props.h !== desired) {
    editor.updateShape({ id, type: 'card', props: { h: desired } });
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
      props: {
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

