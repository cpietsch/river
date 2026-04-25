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
import type { ChipSpan } from './api';

// Mobile fix: tldraw's hand tool captures the pointer at touchstart and the
// synthesized click on touchend often never fires on the button — so onClick
// is unreliable for inline taps. We trigger actions on pointerdown directly
// (instant feedback, no waiting for capture release) and stopPropagation so
// tldraw never sees the gesture. For passive guards (textarea) where there
// IS no action, just stopPropagation.
function tapPointerDown(e: ReactPointerEvent<HTMLElement>): void {
  e.stopPropagation();
}

/**
 * Bind to onPointerDown to invoke `action` immediately on tap (mobile-safe)
 * while preventing tldraw from receiving the gesture. Skip the action when
 * `disabled` is true. This replaces the onClick + setPointerCapture pattern
 * which was racy under tldraw's hand-tool pointer capture.
 */
function tap(
  action: () => void,
  disabled = false,
): (e: ReactPointerEvent<HTMLElement>) => void {
  return (e) => {
    e.stopPropagation();
    if (disabled) return;
    action();
  };
}

// Color palette per agent: pills are color-coded so the user can read which
// perspective a prediction comes from without an extra label. `tint` is the
// off-state background, `solid` is the on-state background, `border` and
// `ink` keep enough contrast to read on cream/white card backgrounds.
const AGENT_PALETTE: Record<
  string,
  { tint: string; solid: string; border: string; ink: string }
> = {
  assumption: {
    tint: '#faf4ff',
    solid: '#8a5cc4',
    border: '#c8a8e8',
    ink: '#4a2d6b',
  },
  skeptic: {
    tint: '#fff5e9',
    solid: '#c47a2d',
    border: '#e8c39a',
    ink: '#6b452a',
  },
  expander: {
    tint: '#e9faf7',
    solid: '#2d8a8a',
    border: '#9adcd2',
    ink: '#1f5252',
  },
};

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
          ? renderWithChipSpans(
              content,
              (shape.meta as { chipSpans?: ChipSpan[] } | undefined)
                ?.chipSpans ?? [],
              new Set(
                (shape.meta as { chipsSelected?: string[] } | undefined)
                  ?.chipsSelected ?? [],
              ),
              (phrase) => actions?.toggleChipSelected(shape.id, phrase),
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
      onPointerDown={tap(onClick)}
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
  const reflections = actions?.activePredictions ?? [];

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
    activePredictions,
    activeToggled,
    togglePrediction,
  } = actions;
  // Send is enabled when there's typed input OR at least one selection
  // (toggled agent pill or selected inline chip on any ancestor) — any of
  // those count as input on their own.
  const canSend =
    !busy &&
    (input.trim().length > 0 ||
      activeToggled.size > 0 ||
      (actions.hasChipSelections ?? false));

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
      {activePredictions.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 4,
          }}
        >
          {activePredictions.map((p, i) => {
            const on = activeToggled.has(p.label.trim());
            const palette = AGENT_PALETTE[p.agent] ?? AGENT_PALETTE.assumption;
            return (
              <button
                key={`pred-${i}`}
                type="button"
                title={`${p.agent}: ${p.full}`}
                aria-pressed={on}
                onPointerDown={tap(() => togglePrediction(p))}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '4px 10px',
                  background: on ? palette.solid : palette.tint,
                  border: `1px solid ${on ? palette.solid : palette.border}`,
                  color: on ? '#fff' : palette.ink,
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
          onPointerDown={tap(() => submit(), !canSend)}
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
 * Render prose with EVERY occurrence of each `chipSpans` phrase wrapped as
 * a tappable chip. Marker-metaphor consistent: highlighting "MacBook Pro"
 * marks every mention, not just the first. Toggle state is keyed by phrase
 * so tapping any instance toggles all of them in unison.
 *
 * Algorithm:
 *  1. For each span (longest first so "MacBook Pro M-series" claims its
 *     range before "Pro" or "MacBook" can), find ALL non-overlapping
 *     case-insensitive occurrences.
 *  2. Sort the resulting matches by start position.
 *  3. Walk text + matches alternately to render parts.
 */
function renderWithChipSpans(
  text: string,
  spans: ChipSpan[],
  selected: Set<string>,
  onChipClick: (phrase: string) => void,
): React.ReactNode {
  type Match = { start: number; end: number; phrase: string };
  const matches: Match[] = [];
  const lower = text.toLowerCase();
  const sorted = [...spans].sort((a, b) => b.phrase.length - a.phrase.length);
  for (const span of sorted) {
    const target = span.phrase.toLowerCase();
    if (!target) continue;
    let from = 0;
    while (from < lower.length) {
      const idx = lower.indexOf(target, from);
      if (idx < 0) break;
      const end = idx + target.length;
      // Skip occurrences that overlap a longer span we've already claimed.
      const overlaps = matches.some((m) => idx < m.end && end > m.start);
      if (overlaps) {
        from = end;
        continue;
      }
      matches.push({ start: idx, end, phrase: span.phrase });
      from = end;
    }
  }
  matches.sort((a, b) => a.start - b.start);

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let chipKey = 0;
  for (const m of matches) {
    if (m.start > cursor) parts.push(text.slice(cursor, m.start));
    const visible = text.slice(m.start, m.end);
    parts.push(
      <BranchChip
        key={`chip-${chipKey++}`}
        term={visible}
        on={selected.has(m.phrase)}
        onClick={() => onChipClick(m.phrase)}
      />,
    );
    cursor = m.end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function BranchChip({
  term,
  on,
  onClick,
}: {
  term: string;
  on: boolean;
  onClick: () => void;
}) {
  // DEBUG visual (matches what the local extractor finds): blue pill when
  // selected, dotted blue underline when not. Once span coverage feels
  // right we restore the marker / highlighter visual. Default state is
  // intentionally NOT invisible here — the dotted line shows which words
  // the extractor caught.
  return (
    <button
      type="button"
      className={on ? 'river-chip on' : 'river-chip'}
      onPointerDown={tap(onClick)}
      aria-pressed={on}
      title={on ? `Selected: ${term} (tap to deselect)` : `Select: ${term}`}
      style={{
        display: 'inline',
        padding: on ? '1px 8px' : '0 1px',
        margin: '0 1px',
        background: on ? '#2e6ecf' : 'transparent',
        border: 'none',
        borderRadius: on ? 999 : 0,
        borderBottom: on ? 'none' : '1px dotted #2e6ecf',
        color: on ? '#fff' : 'inherit',
        font: 'inherit',
        fontSize: 'inherit',
        fontWeight: on ? 600 : 'inherit',
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
        lineHeight: 'inherit',
        transition: 'background 120ms, color 120ms, border-color 120ms',
      }}
    >
      {term}
    </button>
  );
}

