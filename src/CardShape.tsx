import {
  useEffect,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useCardActions } from './CardActions';
import type { ChipSpan } from './api';
import { parseBlocks, stripMarkdown } from './graph/markdown';
import { useConversation } from './graph/store';
import type { Turn, TurnId } from './graph/types';
import { CARD_WIDTH } from './graph/layout';

// Re-export for App / layout consumers; kept here so the rendering layer
// owns its own visual constants.
export { CARD_WIDTH } from './graph/layout';
export const CARD_HEIGHT_MIN = 120;

/**
 * Stop the pointerdown gesture from reaching React Flow (which would
 * interpret it as a canvas pan or node selection). All inline interactive
 * elements inside a card use this guard.
 */
function tapPointerDown(e: ReactPointerEvent<HTMLElement>): void {
  e.stopPropagation();
}

/**
 * Bind to onPointerDown to invoke `action` immediately on tap (mobile-safe)
 * while preventing the canvas from receiving the gesture. Skip the action
 * when `disabled` is true.
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
// perspective a prediction comes from without an extra label.
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

/**
 * React Flow custom node for a turn. Receives the turn id as `id`, reads
 * the actual turn data from the conversation store reactively, and renders
 * either the active input UI (when this card is the empty user-input
 * leaf) or the standard card body.
 */
// Invisible source/target anchors so React Flow has somewhere to attach
// parent → child edges. We don't surface drag-to-connect UX (cards aren't
// connectable), but without a Handle the edge layer logs warnings about
// missing source handles on every render tick.
const HIDDEN_HANDLE_STYLE: CSSProperties = {
  width: 1,
  height: 1,
  minWidth: 1,
  minHeight: 1,
  background: 'transparent',
  border: 'none',
  pointerEvents: 'none',
  opacity: 0,
};

export function CardNode({ id }: NodeProps) {
  const turn = useConversation((s) => s.turns[id as TurnId]);
  if (!turn) return null;
  // Wrapper div (rather than Fragment) so React Flow's node wrapper has a
  // single rooted child; `nopan nodrag` here also short-circuits d3-zoom's
  // pan filter at the node boundary so any inner pointer-down (chip taps,
  // text selection drags) is never interpreted as a canvas pan.
  return (
    <div className="nopan nodrag" style={{ position: 'relative' }}>
      <Handle type="target" position={Position.Top} style={HIDDEN_HANDLE_STYLE} isConnectable={false} />
      <CardBody turn={turn} />
      <Handle type="source" position={Position.Bottom} style={HIDDEN_HANDLE_STYLE} isConnectable={false} />
    </div>
  );
}

function CardBody({ turn }: { turn: Turn }) {
  const { id, role, content, streaming, emphasis } = turn;
  const isUser = role === 'user';
  const actions = useCardActions();
  const isActive = actions?.activeId === id;
  const contentRef = useRef<HTMLDivElement | null>(null);
  const resizeCard = actions?.resizeCard;
  // Live read of the agent's current activity (e.g. "searching the web · …")
  // when this card is the streaming target. Filtered by turnId so other
  // cards don't re-render on every activity change.
  const activityText = useConversation((s) =>
    s.activity && s.activity.turnId === id ? s.activity.text : null,
  );

  // Measure the content block so the node's reported height matches the
  // rendered text — feeds the dagre layout via App's heights state. Uses
  // ResizeObserver so we re-measure on every reflow (initial mount,
  // content edits, late font loads, etc).
  useLayoutEffect(() => {
    if (isActive && isUser && !content) return; // active input card measures itself
    const el = contentRef.current;
    if (!el || !resizeCard) return;
    const initial = el.scrollHeight;
    if (initial > 0) resizeCard(id, initial);
    const observer = new ResizeObserver(() => {
      const measured = el.scrollHeight;
      if (measured > 0) resizeCard(id, measured);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [content, streaming, isActive, isUser, resizeCard, id]);

  if (isActive && isUser && !content) {
    return <ActiveInputCard />;
  }

  const bg = isUser ? '#fffef9' : '#f2f7ff';
  const borderColor = isUser ? '#d4d2c8' : '#a8c8ff';
  const emph = emphasis ?? 1;
  const isEmphasized = emph >= 2;
  const emphBorder = isEmphasized ? '#e24a4a' : borderColor;
  const emphWidth = isEmphasized ? 2 : 1;

  const meta = turn.meta ?? {};
  const chipSpans: ChipSpan[] = (meta.chipSpans ?? []) as ChipSpan[];
  const chipsSelected = new Set<string>(meta.chipsSelected ?? []);
  const flagReason = meta.agentFlagReason;
  const options = meta.options ?? [];

  return (
    <div
      className="river-card nodrag nopan"
      style={{
        width: CARD_WIDTH,
        position: 'relative',
        background: bg,
        border: `${emphWidth}px solid ${emphBorder}`,
        borderRadius: 10,
        color: '#1a1a1a',
        fontFamily:
          '"Source Serif 4", "Source Serif Pro", "Charter", "Iowan Old Style", "Georgia", "Times New Roman", serif',
        fontSize: 16,
        lineHeight: 1.65,
        boxShadow: '0 1px 3px rgba(0,0,0,0.08), 0 2px 8px rgba(0,0,0,0.04)',
      }}
    >
      <div
        ref={contentRef}
        style={{
          padding: '18px 22px 42px 22px',
          wordBreak: 'break-word',
          fontSize: 16,
          lineHeight: 1.65,
          color: content ? '#1a1a1a' : '#bbb',
          fontStyle: content ? 'normal' : 'italic',
          letterSpacing: '0.005em',
        }}
      >
        {content
          ? renderContentBlocks(
              content,
              chipSpans,
              chipsSelected,
              (phrase) => actions?.toggleChipSelected(id, phrase),
              streaming,
            )
          : streaming && activityText
            ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <span
                    aria-hidden
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: '#2e6ecf',
                      boxShadow: '0 0 0 4px rgba(46,110,207,0.18)',
                      flex: '0 0 auto',
                    }}
                  />
                  <span style={{ color: '#6b6660', fontStyle: 'italic' }}>
                    {activityText}
                  </span>
                </span>
              )
            : 'thinking…'}
        {!content && streaming && !activityText && <span className="river-cursor">▊</span>}

        {content && streaming && activityText && (
          <div
            style={{
              marginTop: 10,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              color: '#6b6660',
              fontStyle: 'italic',
              fontSize: 14,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: '#2e6ecf',
                boxShadow: '0 0 0 4px rgba(46,110,207,0.18)',
                flex: '0 0 auto',
              }}
            />
            {activityText}
          </div>
        )}

        {options.length > 0 && (
          <div
            style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 6 }}
          >
            {options.map((opt, i) => (
              <button
                key={`${i}-${opt}`}
                type="button"
                onPointerDown={tap(() => actions?.pickOption(id, opt))}
                style={{
                  display: 'inline-block',
                  padding: '6px 12px',
                  background: '#fff',
                  color: '#2e6ecf',
                  border: '1px solid #2e6ecf',
                  borderRadius: 999,
                  font: 'inherit',
                  fontSize: 13,
                  fontFamily: 'system-ui, -apple-system, sans-serif',
                  cursor: 'pointer',
                  WebkitTapHighlightColor: 'transparent',
                  lineHeight: 1.3,
                  textAlign: 'left',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = '#2e6ecf';
                  e.currentTarget.style.color = '#fff';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = '#fff';
                  e.currentTarget.style.color = '#2e6ecf';
                }}
              >
                {opt}
              </button>
            ))}
          </div>
        )}
      </div>

      {flagReason && (
        <div
          title={`agent: ${flagReason}`}
          aria-label="Flagged by the agent"
          style={{
            position: 'absolute',
            top: 8,
            right: 10,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '2px 8px',
            background: '#e24a4a',
            color: '#fff',
            borderRadius: 999,
            fontSize: 10,
            fontFamily: 'system-ui, -apple-system, sans-serif',
            fontWeight: 500,
            letterSpacing: 0.4,
            textTransform: 'uppercase',
            cursor: 'help',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M5 3v18M5 4h12l-2 4 2 4H5"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="currentColor"
            />
          </svg>
          flagged
        </div>
      )}

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
        <IconButton label="branch" onClick={() => actions?.branchFrom(id)}>
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
          onClick={() => actions?.toggleEmphasis(id)}
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
    </div>
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

function ActiveInputCard() {
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
  const chipCount = actions?.chipSelectionCount ?? 0;

  useLayoutEffect(() => {
    const ta = taRef.current;
    const root = rootRef.current;
    if (!ta || !root || !resizeActive) return;
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
    const measured = root.scrollHeight;
    if (measured <= 0) return;
    resizeActive(measured);
  }, [input, resizeActive, reflections, chipCount]);

  if (!actions) return null;
  const {
    onInputChange,
    submit,
    busy,
    activePredictions,
    activeToggled,
    togglePrediction,
    chipSelectionCount,
    clearAllChipSelections,
  } = actions;
  const canSend =
    !busy &&
    (input.trim().length > 0 ||
      activeToggled.size > 0 ||
      (actions.hasChipSelections ?? false));

  return (
    <div
      className="nodrag nopan"
      style={{
        width: CARD_WIDTH,
        background: '#ffffff',
        border: '2px solid #111',
        borderRadius: 12,
        color: '#111',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: 14,
        lineHeight: 1.5,
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
        {(activePredictions.length > 0 || chipSelectionCount > 0) && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
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
            {chipSelectionCount > 0 && (
              <button
                key="chip-count"
                type="button"
                title={`${chipSelectionCount} in-text selection${chipSelectionCount === 1 ? '' : 's'} — tap to clear`}
                aria-label="Clear text selections"
                onPointerDown={tap(() => clearAllChipSelections())}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '4px 10px',
                  background: '#2e6ecf',
                  border: '1px solid #2e6ecf',
                  color: '#fff',
                  borderRadius: 999,
                  font: 'inherit',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  WebkitTapHighlightColor: 'transparent',
                  lineHeight: 1.4,
                  whiteSpace: 'nowrap',
                  transition: 'background 120ms',
                }}
              >
                {chipSelectionCount} selected
                <span
                  aria-hidden
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 14,
                    height: 14,
                    borderRadius: 999,
                    background: 'rgba(255,255,255,0.2)',
                    fontSize: 11,
                    lineHeight: 1,
                  }}
                >
                  ✕
                </span>
              </button>
            )}
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
            className="nodrag nopan nowheel"
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
    </div>
  );
}

function renderContentBlocks(
  raw: string,
  spans: ChipSpan[],
  selected: Set<string>,
  onChipClick: (phrase: string) => void,
  streaming: boolean,
): React.ReactNode {
  const blocks = parseBlocks(raw);
  if (blocks.length === 0) return null;
  return blocks.map((block, idx) => {
    const isLast = idx === blocks.length - 1;
    if (block.kind === 'paragraph') {
      return (
        <p
          key={`p-${idx}`}
          style={{
            margin: 0,
            marginBottom: isLast ? 0 : '0.85em',
            whiteSpace: 'pre-wrap',
          }}
        >
          {renderWithChipSpans(block.text, spans, selected, onChipClick)}
          {isLast && streaming && <span className="river-cursor">▊</span>}
        </p>
      );
    }
    return (
      <table
        key={`t-${idx}`}
        style={{
          borderCollapse: 'collapse',
          marginTop: idx === 0 ? 0 : '0.85em',
          marginBottom: isLast ? 0 : '0.85em',
          fontSize: '0.95em',
          width: '100%',
        }}
      >
        <thead>
          <tr>
            {block.header.map((h, i) => (
              <th
                key={`th-${i}`}
                style={{
                  textAlign: 'left',
                  padding: '6px 10px',
                  borderBottom: '1.5px solid #1a1a1a',
                  fontWeight: 600,
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, ri) => (
            <tr key={`tr-${ri}`}>
              {row.map((cell, ci) => (
                <td
                  key={`td-${ci}`}
                  style={{
                    padding: '6px 10px',
                    borderBottom: '1px solid rgba(0,0,0,0.08)',
                    verticalAlign: 'top',
                  }}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  });
}

function renderWithChipSpans(
  raw: string,
  spans: ChipSpan[],
  selected: Set<string>,
  onChipClick: (phrase: string) => void,
): React.ReactNode {
  const { plain, bold, italic } = stripMarkdown(raw);

  type Match = { start: number; end: number; phrase: string };
  const matches: Match[] = [];
  const lower = plain.toLowerCase();
  const sorted = [...spans].sort((a, b) => b.phrase.length - a.phrase.length);
  for (const span of sorted) {
    const target = span.phrase.toLowerCase();
    if (!target) continue;
    let from = 0;
    while (from < lower.length) {
      const idx = lower.indexOf(target, from);
      if (idx < 0) break;
      const end = idx + target.length;
      const overlaps = matches.some((m) => idx < m.end && end > m.start);
      if (overlaps) {
        from = end;
        continue;
      }
      matches.push({ start: idx, end, phrase: span.phrase });
      break;
    }
  }

  const points = new Set<number>([0, plain.length]);
  for (const r of [...matches, ...bold, ...italic]) {
    points.add(r.start);
    points.add(r.end);
  }
  const sortedPts = [...points].sort((a, b) => a - b);

  const inRange = (
    pos: number,
    ranges: { start: number; end: number }[],
  ): boolean => ranges.some((r) => pos >= r.start && pos < r.end);

  const findChipMatch = (start: number, end: number): Match | undefined =>
    matches.find((m) => m.start === start && m.end === end);

  const parts: React.ReactNode[] = [];
  let chipKey = 0;
  let mdKey = 0;
  for (let i = 0; i < sortedPts.length - 1; i++) {
    const a = sortedPts[i];
    const b = sortedPts[i + 1];
    if (a === b) continue;
    const slice = plain.slice(a, b);
    const isBold = inRange(a, bold);
    const isItalic = inRange(a, italic);
    const chip = findChipMatch(a, b);

    let node: React.ReactNode;
    if (chip) {
      node = (
        <BranchChip
          key={`chip-${chipKey++}`}
          term={slice}
          on={selected.has(chip.phrase)}
          onClick={() => onChipClick(chip.phrase)}
        />
      );
    } else {
      node = slice;
    }
    if (isItalic) {
      node = <em key={`em-${mdKey++}`}>{node}</em>;
    }
    if (isBold) {
      node = <strong key={`b-${mdKey++}`}>{node}</strong>;
    }
    parts.push(node);
  }
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
  return (
    <button
      type="button"
      className={on ? 'river-chip on' : 'river-chip'}
      onPointerDown={tap(onClick)}
      aria-pressed={on}
      title={on ? `Selected: ${term} (tap to deselect)` : `Select: ${term}`}
      style={{
        display: 'inline',
        padding: 0,
        margin: 0,
        background: on ? '#2e6ecf' : 'transparent',
        border: 'none',
        borderRadius: on ? 3 : 0,
        color: on ? '#fff' : 'inherit',
        font: 'inherit',
        fontSize: 'inherit',
        fontWeight: 'inherit',
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
        lineHeight: 'inherit',
        transition: 'background 120ms, color 120ms',
        boxShadow: on ? '0 0 0 2px #2e6ecf' : 'none',
      }}
    >
      {term}
    </button>
  );
}
