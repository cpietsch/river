import { useEffect, useRef } from 'react';
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

export const CARD_WIDTH = 320;
export const CARD_HEIGHT_MIN = 120;

export class CardShapeUtil extends ShapeUtil<CardShape> {
  static override type = 'card' as const;
  static override props = cardShapeProps;

  override canEdit = () => false;
  override canResize = () => true;
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

  // ACTIVE USER CARD = embedded chat input
  if (isActive && isUser) {
    return <ActiveInputCard w={w} h={h} />;
  }

  const borderColor = isUser ? '#cfcdc6' : '#c7dbff';

  return (
    <HTMLContainer
      id={shape.id}
      style={{
        width: w,
        height: h,
        display: 'flex',
        flexDirection: 'column',
        background: '#ffffff',
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
        style={{
          padding: '5px 10px 3px',
          fontSize: 10,
          color: isUser ? '#8a8a8a' : '#4a90e2',
          textTransform: 'uppercase',
          letterSpacing: 1.5,
        }}
      >
        {isUser ? 'you' : '◆ assistant'}
      </div>
      <div
        style={{
          flex: 1,
          padding: '0 12px 8px',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          overflow: 'auto',
          color: content ? '#111' : '#bbb',
          fontStyle: content ? 'normal' : 'italic',
        }}
      >
        {content || 'thinking…'}
        {streaming && <span className="river-cursor">▊</span>}
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 6,
          padding: '4px 8px 8px',
          borderTop: '1px solid #f0efea',
        }}
      >
        <ActionPill
          label="branch"
          icon="branch"
          onClick={() => actions?.branchFrom(shape.id)}
        />
        {!isUser && (
          <ActionPill
            label="retry"
            icon="retry"
            onClick={() => actions?.regenerate(shape.id)}
          />
        )}
        <ActionPill
          label="delete"
          icon="delete"
          onClick={() => {
            if (confirm('Delete this card?')) actions?.deleteCard(shape.id);
          }}
          tone="danger"
        />
      </div>
    </HTMLContainer>
  );
}

function ActiveInputCard({ w, h }: { w: number; h: number }) {
  const actions = useCardActions();
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    // Brief timeout so tldraw's own focus handling settles before we grab it.
    const t = setTimeout(() => taRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);

  if (!actions) return null;
  const { input, onInputChange, submit, mist, commitMist, busy } = actions;

  return (
    <HTMLContainer
      style={{
        width: w,
        height: h,
        display: 'flex',
        flexDirection: 'column',
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
        style={{
          padding: '6px 12px 2px',
          fontSize: 10,
          color: '#6a6a6a',
          textTransform: 'uppercase',
          letterSpacing: 1.5,
        }}
      >
        your turn
      </div>

      {/* Mist pills row — scrolls horizontally */}
      {mist.length > 0 && (
        <div
          style={{
            display: 'flex',
            gap: 6,
            flexWrap: 'nowrap',
            overflowX: 'auto',
            scrollbarWidth: 'none',
            padding: '4px 10px 2px',
            WebkitOverflowScrolling: 'touch',
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {mist.map((c) => (
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
                flex: '0 0 auto',
                padding: '5px 10px',
                background: '#fff6e6',
                border: '1px solid #e0a848',
                color: '#a86a12',
                borderRadius: 999,
                font: 'inherit',
                fontSize: 11,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                WebkitTapHighlightColor: 'transparent',
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}

      <textarea
        ref={taRef}
        data-testid="river-input"
        value={input}
        disabled={busy}
        placeholder={busy ? 'thinking…' : 'type here…'}
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
          width: '100%',
          padding: '6px 12px',
          background: 'transparent',
          border: 'none',
          color: '#111',
          fontFamily: 'inherit',
          fontSize: 16,
          lineHeight: 1.4,
          resize: 'none',
          outline: 'none',
          minHeight: 44,
        }}
      />

      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          gap: 6,
          padding: '4px 8px 8px',
          borderTop: '1px solid #f0efea',
        }}
      >
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            submit();
          }}
          disabled={busy || input.trim().length === 0}
          aria-label="Send"
          data-testid="send"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 14px',
            background:
              busy || input.trim().length === 0 ? '#e8e6e0' : '#111',
            color:
              busy || input.trim().length === 0 ? '#8a8a8a' : '#fff',
            border: 'none',
            borderRadius: 999,
            cursor:
              busy || input.trim().length === 0 ? 'default' : 'pointer',
            font: 'inherit',
            fontSize: 13,
            fontWeight: 600,
            WebkitTapHighlightColor: 'transparent',
            minHeight: 36,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M5 12h14M13 6l6 6-6 6"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          send
        </button>
      </div>
    </HTMLContainer>
  );
}

function ActionPill({
  label,
  icon,
  onClick,
  tone,
}: {
  label: string;
  icon: 'branch' | 'retry' | 'delete';
  onClick: () => void;
  tone?: 'danger';
}) {
  const danger = tone === 'danger';
  return (
    <button
      type="button"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      aria-label={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '6px 10px',
        background: '#f7f6f2',
        border: `1px solid ${danger ? '#e0a0a0' : '#cfcdc6'}`,
        color: danger ? '#a04040' : '#111',
        borderRadius: 999,
        font: 'inherit',
        fontSize: 11,
        fontWeight: 500,
        cursor: 'pointer',
        minHeight: 30,
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <Icon kind={icon} />
      {label}
    </button>
  );
}

function Icon({ kind }: { kind: 'branch' | 'retry' | 'delete' }) {
  const s = { width: 11, height: 11 } as const;
  if (kind === 'branch') {
    return (
      <svg {...s} viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M7 5v9a4 4 0 0 0 4 4h7M15 14l3 3-3 3"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (kind === 'retry') {
    return (
      <svg {...s} viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M4 12a8 8 0 0 1 14-5M20 4v6h-6"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  // delete
  return (
    <svg {...s} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
