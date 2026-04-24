import { useCallback, useEffect, useRef, useState } from 'react';
import { Tldraw, toRichText, type Editor, type TLShapeId, createShapeId } from 'tldraw';
import {
  CardShapeUtil,
  CARD_WIDTH,
  CARD_HEIGHT_MIN,
  type CardShape,
} from './CardShape';
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
          h: CARD_HEIGHT_MIN,
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

  function onInputChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value;
    setInput(v);
    scheduleMist(v);
  }
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  }
  function commitMist(c: MistCandidate) {
    setInput('');
    setMist([]);
    void handleSubmit(c.full);
  }

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Tldraw
        shapeUtils={shapeUtils}
        onMount={handleMount}
        persistenceKey="river-2"
        hideUi
        inferDarkMode={false}
      />

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
          paddingBottom: 'calc(12px + env(safe-area-inset-bottom))',
          display: 'flex',
          justifyContent: 'center',
          pointerEvents: 'none',
          zIndex: 1000,
          transition: 'bottom 120ms ease',
        }}
      >
        <div
          style={{
            pointerEvents: 'auto',
            width: 'min(720px, 100%)',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          {mist.length > 0 && (
            <div
              style={{
                display: 'flex',
                gap: 6,
                flexWrap: 'nowrap',
                overflowX: 'auto',
                WebkitOverflowScrolling: 'touch',
                scrollbarWidth: 'none',
                padding: '4px 2px',
                margin: '0 -4px',
              }}
            >
              {mist.map((c) => (
                <button
                  key={c.label + c.full}
                  type="button"
                  onClick={() => commitMist(c)}
                  title={c.full}
                  style={{
                    flex: '0 0 auto',
                    padding: '8px 14px',
                    background: '#fff6e6',
                    border: '1px solid #e0a848',
                    color: '#a86a12',
                    borderRadius: 999,
                    font: 'inherit',
                    fontSize: 13,
                    cursor: 'pointer',
                    maxWidth: 260,
                    textOverflow: 'ellipsis',
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
                    WebkitTapHighlightColor: 'transparent',
                    minHeight: 36,
                  }}
                >
                  {c.label}
                </button>
              ))}
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleSubmit();
            }}
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'flex-end',
              background: '#ffffff',
              padding: 8,
              borderRadius: 18,
              border: '1px solid #1a1a1a',
              boxShadow:
                '0 10px 32px rgba(0,0,0,0.18), 0 3px 10px rgba(0,0,0,0.12)',
            }}
          >
            <textarea
              data-testid="river-input"
              value={input}
              disabled={busy}
              placeholder={busy ? 'thinking…' : 'type here…'}
              onChange={onInputChange}
              onKeyDown={onKeyDown}
              rows={1}
              autoCorrect="on"
              autoCapitalize="sentences"
              style={{
                flex: 1,
                minWidth: 0,
                padding: '12px 14px',
                background: 'transparent',
                border: 'none',
                color: '#111',
                fontFamily: 'inherit',
                fontSize: 16,
                lineHeight: 1.35,
                resize: 'none',
                outline: 'none',
                minHeight: 44,
                maxHeight: 160,
              }}
            />
            <button
              type="submit"
              disabled={busy || input.trim().length === 0}
              aria-label="Send"
              data-testid="send"
              style={{
                flex: '0 0 auto',
                width: 48,
                height: 48,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: busy || input.trim().length === 0 ? '#e8e6e0' : '#111',
                color: busy || input.trim().length === 0 ? '#8a8a8a' : '#fff',
                border: 'none',
                borderRadius: 14,
                cursor: busy || input.trim().length === 0 ? 'default' : 'pointer',
                transition: 'background 120ms ease',
                WebkitTapHighlightColor: 'transparent',
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M5 12h14M13 6l6 6-6 6"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </form>
        </div>
      </div>

      <style>{`
        @keyframes river-cursor-blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
        .river-cursor { display: inline-block; margin-left: 2px; color: #4a90e2; animation: river-cursor-blink 0.9s step-end infinite; }
        /* Ensure tldraw canvas background matches our cream tone */
        .tl-container, .tl-background { background: #f7f6f2 !important; }
        /* Hide horizontal scroll bar on mist pill strip */
        .river-input-wrap ::-webkit-scrollbar { display: none; }
        /* Auto-grow textarea vertically by letting rows handle it; keep padding tight on small screens */
        @media (max-width: 480px) {
          .river-input-wrap form { padding: 6px; gap: 6px; }
          .river-input-wrap textarea { font-size: 16px; }
        }
      `}</style>
    </div>
  );
}

function growToFit(editor: Editor, id: TLShapeId, text: string): void {
  const lines = Math.max(1, Math.ceil(text.length / 44));
  const desired = Math.max(CARD_HEIGHT_MIN, 50 + lines * 20);
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

