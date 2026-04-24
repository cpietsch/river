import { useEffect, useLayoutEffect, useRef } from 'react';
import {
  HTMLContainer,
  Rectangle2d,
  ShapeUtil,
  type RecordProps,
  T,
  type TLBaseShape,
} from 'tldraw';
import { useCardActions } from './CardActions';

export type CardShape = TLBaseShape<
  'card',
  {
    w: number;
    h: number;
    role: 'user' | 'assistant';
    content: string;
    streaming: boolean;
  }
>;

const cardShapeProps: RecordProps<CardShape> = {
  w: T.number,
  h: T.number,
  role: T.literalEnum('user', 'assistant'),
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
  const { role, content, streaming, w, h } = shape.props;
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

  return (
    <HTMLContainer
      id={shape.id}
      className="river-card"
      style={{
        width: w,
        height: h,
        position: 'relative',
        background: bg,
        border: `1px solid ${borderColor}`,
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
          padding: '10px 36px 10px 12px',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          color: content ? '#111' : '#bbb',
          fontStyle: content ? 'normal' : 'italic',
        }}
      >
        {content
          ? renderWithBranchChips(content, (term) =>
              actions?.branchAbout(shape.id, term),
            )
          : 'thinking…'}
        {streaming && <span className="river-cursor">▊</span>}
      </div>

      <div
        className="river-card-actions"
        style={{
          position: 'absolute',
          top: 6,
          right: 6,
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
          label="delete"
          onClick={() => actions?.deleteCard(shape.id)}
        >
          <path
            d="M6 6l12 12M18 6L6 18"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
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
      onPointerDown={(e) => e.stopPropagation()}
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
  const mist = actions?.mist ?? [];
  const resizeActive = actions?.resizeActive;

  // Measure the actual content height so wrap-aware suggestion bubbles and
  // growing textareas both feed a correct card height.
  useLayoutEffect(() => {
    const ta = taRef.current;
    const root = rootRef.current;
    if (!ta || !root || !resizeActive) return;
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
    const measured = root.scrollHeight;
    if (measured <= 0) return; // culled/unmounted — leave stored height alone
    resizeActive(measured);
  }, [input, mist, resizeActive]);

  if (!actions) return null;
  const { onInputChange, submit, commitMist, busy } = actions;
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
        gap: 6,
        padding: '8px 10px 10px',
      }}
    >
      {/* Suggestion bubbles — full-width, stacked vertically */}
      {mist.map((c, i) => (
        <button
          key={c.label + c.full}
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            commitMist(c);
          }}
          title={c.full}
          style={{
            width: '100%',
            padding: '10px 14px',
            background: i === 0 ? '#111' : '#f7f6f2',
            color: i === 0 ? '#fff' : '#333',
            border: i === 0 ? 'none' : '1px solid #e0dfd9',
            borderRadius: 10,
            font: 'inherit',
            fontSize: 13,
            fontWeight: i === 0 ? 600 : 400,
            cursor: 'pointer',
            textAlign: 'left',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          {c.label}
        </button>
      ))}

      {/* Input bubble — same visual weight as suggestions */}
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
          placeholder={busy ? 'thinking…' : 'or type your own…'}
          onChange={(e) => onInputChange(e.currentTarget.value)}
          onPointerDown={(e) => e.stopPropagation()}
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
          onPointerDown={(e) => e.stopPropagation()}
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
 * branch chip. Incomplete markers (e.g. "[[my" while still streaming) stay as
 * plain text until the closing `]]` arrives, at which point they snap into a
 * chip on the next render.
 */
function renderWithBranchChips(
  text: string,
  onChipClick: (term: string) => void,
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
    parts.push(
      <BranchChip key={`chip-${chipKey++}`} term={term} onClick={() => onChipClick(term)} />,
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
      onPointerDown={(e) => e.stopPropagation()}
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

