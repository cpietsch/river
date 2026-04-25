import { useEffect, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import {
  HTMLContainer,
  Rectangle2d,
  ShapeUtil,
  type RecordProps,
  T,
  type TLBaseShape,
} from 'tldraw';
import { useCardActions } from './CardActions';

// Mobile fix: with tldraw's hand tool active, the editor's pointer handler
// races to setPointerCapture on the canvas root the moment a touch lands.
// Even tiny finger drift before touchend makes the browser cancel the
// synthesized click on the button. Calling setPointerCapture on the button
// itself in pointerdown wins that race — the gesture stays anchored to the
// button and click fires on touchend. stopPropagation prevents tldraw's
// React-level handlers from running too.
function tapPointerDown(e: ReactPointerEvent<HTMLElement>): void {
  e.stopPropagation();
  try {
    e.currentTarget.setPointerCapture(e.pointerId);
  } catch {
    // Some browsers throw on capture for transient elements — ignore.
  }
}

export type CardShape = TLBaseShape<
  'card',
  {
    w: number;
    h: number;
    role: 'user' | 'assistant' | 'presumption';
    layer: 'action' | 'reflection';
    emphasis: number;
    content: string;
    streaming: boolean;
  }
>;

const cardShapeProps: RecordProps<CardShape> = {
  w: T.number,
  h: T.number,
  role: T.literalEnum('user', 'assistant', 'presumption'),
  layer: T.literalEnum('action', 'reflection'),
  emphasis: T.number,
  content: T.string,
  streaming: T.boolean,
};

export const CARD_WIDTH = 400;
export const CARD_HEIGHT_MIN = 120;

export class CardShapeUtil extends ShapeUtil<CardShape> {
  static override type = 'card' as const;
  static override props = cardShapeProps;

  override canEdit = () => false;
  override canResize = () => false;
  override canCull = () => false;
  override hideResizeHandles = () => true;
  override hideRotateHandle = () => true;
  override isAspectRatioLocked = () => false;

  getDefaultProps(): CardShape['props'] {
    return {
      w: CARD_WIDTH,
      h: CARD_HEIGHT_MIN,
      role: 'user',
      layer: 'action',
      emphasis: 1,
      content: '',
      streaming: false,
    };
  }

  getGeometry(shape: CardShape) {
    return new Rectangle2d({
      width: shape.props.w,
      height: shape.props.h,
      isFilled: true,
    });
  }

  component(shape: CardShape) {
    return <CardBody shape={shape} />;
  }

  indicator(shape: CardShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={10} ry={10} />;
  }
}

function CardBody({ shape }: { shape: CardShape }) {
  const { role, content, streaming, w, h, emphasis } = shape.props;
  const isUser = role === 'user';
  const actions = useCardActions();
  const isActive = actions?.activeId === shape.id;
  const contentRef = useRef<HTMLDivElement | null>(null);
  const resizeCard = actions?.resizeCard;

  // Measure the content block so the card's shape height matches exactly the
  // rendered text — one source of truth, no character-count heuristic.
  useLayoutEffect(() => {
    if (isActive && isUser && !content) return; // active input card measures itself
    const el = contentRef.current;
    if (!el || !resizeCard) return;
    const measured = el.scrollHeight;
    // If measured is 0 the shape is culled/unmounted; don't clobber the stored
    // height with a bogus value or the card turns into a one-pixel sliver.
    if (measured <= 0) return;
    resizeCard(shape.id, measured);
  }, [content, streaming, w, isActive, isUser, resizeCard, shape.id]);

  // ACTIVE USER CARD = embedded chat input (only when content is still empty;
  // once submitted the card immediately shows the committed text).
  if (isActive && isUser && !content) {
    return <ActiveInputCard w={w} h={h} />;
  }

  const bg = isUser ? '#fffef9' : '#f2f7ff';
  const borderColor = isUser ? '#d4d2c8' : '#a8c8ff';

  // Emphasis pushes the border red and thicker — visual weight doubles as a
  // prompt signal (see prompt-weighting pass in App.tsx).
  const emph = emphasis ?? 1;
  const isEmphasized = emph >= 2;
  const emphBorder = isEmphasized ? '#e24a4a' : borderColor;
  const emphWidth = isEmphasized ? 2 : 1;

  return (
    <HTMLContainer
      id={shape.id}
      className="river-card"
      style={{
        width: w,
        height: h,
        position: 'relative',
        background: bg,
        border: `${emphWidth}px solid ${emphBorder}`,
        borderRadius: 10,
        color: '#111',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: 14,
        lineHeight: 1.5,
        overflow: 'hidden',
        pointerEvents: 'all',
        boxShadow: '0 1px 3px rgba(0,0,0,0.08), 0 2px 8px rgba(0,0,0,0.04)',
      }}
    >
      <div
        ref={contentRef}
        style={{
          // Reserve ~34px of bottom padding so the floating icon row below
          // never sits on top of the last line of text.
          padding: '10px 12px 34px 12px',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          fontSize: 14,
          lineHeight: 1.5,
          color: content ? '#111' : '#bbb',
          fontStyle: content ? 'normal' : 'italic',
        }}
      >
        {content
          ? renderWithBranchChips(
              content,
              (shape.meta as { chipQuestions?: Record<string, string> })
                ?.chipQuestions,
              (prompt) => actions?.branchAbout(shape.id, prompt),
            )
          : 'thinking…'}
        {streaming && <span className="river-cursor">▊</span>}
      </div>

      {/* Action icons: same two on every card (branch + like), bottom-right so
          they never overlap text. Faded when idle, prominent on hover. */}
      <div
        className="river-card-actions"
        style={{
          position: 'absolute',
          bottom: 4,
          right: 4,
          display: 'flex',
          gap: 2,
          opacity: 0.35,
          transition: 'opacity 120ms',
        }}
      >
        <IconButton
          label="branch"
          onClick={() => actions?.branchFrom(shape.id)}
        >
          <path
            d="M7 5v9a4 4 0 0 0 4 4h7M15 14l3 3-3 3"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </IconButton>
        <IconButton
          label={isEmphasized ? 'unlike' : 'like (priority)'}
          onClick={() => actions?.toggleEmphasis(shape.id)}
        >
          <path
            d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"
            stroke="currentColor"
            strokeWidth="1.8"
            fill={isEmphasized ? '#e24a4a' : 'none'}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </IconButton>
      </div>
    </HTMLContainer>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onPointerDown={tapPointerDown}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 22,
        height: 22,
        padding: 0,
        background: 'transparent',
        border: 'none',
        borderRadius: 4,
        color: '#333',
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
        {children}
      </svg>
    </button>
  );
}

function ActiveInputCard({ w, h }: { w: number; h: number }) {
  const actions = useCardActions();
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const t = setTimeout(() => taRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);

  const input = actions?.input ?? '';
  const resizeActive = actions?.resizeActive;
  const reflections = actions?.activeReflections ?? [];

  // Measure the actual content height so the growing textarea feeds a correct
  // card height — no scrollbar, no wasted space. Re-runs when reflection
  // pills land or change so the card grows to fit them.
  useLayoutEffect(() => {
    const ta = taRef.current;
    const root = rootRef.current;
    if (!ta || !root || !resizeActive) return;
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
    const measured = root.scrollHeight;
    if (measured <= 0) return; // culled/unmounted — leave stored height alone
    resizeActive(measured);
  }, [input, resizeActive, reflections]);

  if (!actions) return null;
  const {
    onInputChange,
    submit,
    busy,
    activeReflections,
    activeToggled,
    toggleReflection,
  } = actions;
  const canSend = !busy && input.trim().length > 0;

  return (
    <HTMLContainer
      style={{
        width: w,
        height: h,
        background: '#ffffff',
        border: '2px solid #111',
        borderRadius: 12,
        color: '#111',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: 14,
        lineHeight: 1.5,
        overflow: 'hidden',
        pointerEvents: 'all',
        boxShadow: '0 4px 14px rgba(0,0,0,0.16), 0 10px 32px rgba(0,0,0,0.08)',
      }}
    >
    <div
      ref={rootRef}
      style={{
        display: 'flex',
        flexDirection: 'column',
        padding: '8px 10px 10px',
        gap: 6,
      }}
    >
      {/* Reflection pills — implicit assumptions surfaced in first-person.
          Tap to toggle: each toggled pill becomes part of `userContext` on
          the next /api/generate call. Multiple selections are supported.
          Filled lavender = on, outline = off. Title attr exposes the full
          sentence for hover. */}
      {activeReflections.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 4,
          }}
        >
          {activeReflections.map((p, i) => {
            const on = activeToggled.has(p.label.trim());
            return (
              <button
                key={`refl-${i}`}
                type="button"
                title={p.full}
                aria-pressed={on}
                onPointerDown={tapPointerDown}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleReflection(p);
                }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '4px 10px',
                  background: on ? '#8a5cc4' : '#faf4ff',
                  border: `1px solid ${on ? '#8a5cc4' : '#c8a8e8'}`,
                  color: on ? '#fff' : '#4a2d6b',
                  borderRadius: 999,
                  font: 'inherit',
                  fontSize: 12,
                  fontWeight: on ? 600 : 500,
                  cursor: 'pointer',
                  WebkitTapHighlightColor: 'transparent',
                  lineHeight: 1.4,
                  whiteSpace: 'nowrap',
                  maxWidth: '100%',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  transition: 'background 120ms, color 120ms',
                }}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      )}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          background: '#f7f6f2',
          border: '1px solid #e0dfd9',
          borderRadius: 10,
          padding: '4px 6px 4px 12px',
        }}
      >
        <textarea
          ref={taRef}
          data-testid="river-input"
          value={input}
          disabled={busy}
          placeholder={busy ? 'thinking…' : 'ask the river…'}
          onChange={(e) => onInputChange(e.currentTarget.value)}
          onPointerDown={tapPointerDown}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          autoCorrect="on"
          autoCapitalize="sentences"
          style={{
            flex: 1,
            padding: '6px 0',
            background: 'transparent',
            border: 'none',
            color: '#111',
            fontFamily: 'inherit',
            fontSize: 14,
            lineHeight: 1.4,
            resize: 'none',
            outline: 'none',
            minHeight: 28,
            overflow: 'hidden',
          }}
        />
        <button
          type="button"
          onPointerDown={tapPointerDown}
          onClick={(e) => {
            e.stopPropagation();
            submit();
          }}
          disabled={!canSend}
          aria-label="Send"
          data-testid="send"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 32,
            height: 32,
            flexShrink: 0,
            background: canSend ? '#111' : 'transparent',
            color: canSend ? '#fff' : '#bbb',
            border: 'none',
            borderRadius: 8,
            cursor: canSend ? 'pointer' : 'default',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M5 12h14M13 6l6 6-6 6"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </div>
    </HTMLContainer>
  );
}

/**
 * Parse `[[term]]` markers inside assistant text and render each as a tappable
 * branch chip. After the main stream completes, App fetches a contextual
 * question for each term via Haiku and stores the map in the card's meta as
 * `chipQuestions`. The chip's click handler uses the question if available,
 * else falls back to the bare term (which still works because the main model
 * has the full conversation history). Incomplete markers mid-stream stay as
 * plain text until the closing `]]` arrives.
 */
function renderWithBranchChips(
  text: string,
  chipQuestions: Record<string, string> | undefined,
  onChipClick: (prompt: string) => void,
): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const regex = /\[\[([^\[\]]+?)\]\]/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  let chipKey = 0;
  while ((match = regex.exec(text))) {
    if (match.index > lastIdx) {
      parts.push(text.slice(lastIdx, match.index));
    }
    const term = match[1].trim();
    const prompt = chipQuestions?.[term] || term;
    parts.push(
      <BranchChip
        key={`chip-${chipKey++}`}
        term={term}
        onClick={() => onChipClick(prompt)}
      />,
    );
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < text.length) {
    parts.push(text.slice(lastIdx));
  }
  return parts;
}

function BranchChip({ term, onClick }: { term: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onPointerDown={tapPointerDown}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={`Branch: ${term}`}
      style={{
        display: 'inline',
        padding: '1px 8px',
        margin: '0 1px',
        background: '#fff',
        border: '1px solid #a8c8ff',
        color: '#2e6ecf',
        borderRadius: 999,
        font: 'inherit',
        fontSize: 13,
        fontWeight: 500,
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
        lineHeight: 1.4,
      }}
    >
      {term}
    </button>
  );
}

