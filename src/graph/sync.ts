import {
  createShapeId,
  toRichText,
  type Editor,
  type TLShapeId,
} from 'tldraw';
import type { CardShape } from '../CardShape';
import { CARD_WIDTH, CARD_HEIGHT_MIN } from '../CardShape';
import { useConversation } from './store';
import type { Turn, TurnId } from './types';

/**
 * Ensure tldraw mirrors the conversation store one-for-one:
 *   - every turn has a matching card shape (created if missing, props updated
 *     if drifted)
 *   - every parent->child edge has a single elbow arrow with bindings
 *   - any tldraw card or arrow without a corresponding store entry is removed
 *
 * Idempotent: safe to call after every mutation. Positions are not the
 * syncer's concern — call `relayoutAll` after structural changes (turn
 * created/deleted) to re-flow the canvas.
 */
export function syncStoreToTldraw(editor: Editor): void {
  const { turns } = useConversation.getState();
  const turnIds = new Set(Object.keys(turns) as TurnId[]);

  // ── cards: create missing, update drifted, delete orphaned ──
  const allShapes = editor.getCurrentPageShapes();
  const existingCards = new Map<TurnId, CardShape>();
  for (const s of allShapes) {
    if (s.type === 'card') {
      existingCards.set(s.id as TurnId, s as unknown as CardShape);
    }
  }

  // Create / update
  for (const id of turnIds) {
    const turn = turns[id];
    const existing = existingCards.get(id);
    if (!existing) {
      editor.createShape({
        id,
        type: 'card',
        x: 0,
        y: 0,
        props: {
          w: CARD_WIDTH,
          h: CARD_HEIGHT_MIN,
          role: turn.role,
          // 'layer' is a vestigial schema field kept for migration safety; the
          // graph branch only operates in 'action' space.
          layer: 'action',
          emphasis: turn.emphasis,
          content: turn.content,
          streaming: turn.streaming,
        },
      });
    } else {
      // Diff: only call updateShape when something actually changed to avoid
      // tldraw's history bloat under streaming.
      const propDiff: Partial<CardShape['props']> = {};
      if (existing.props.content !== turn.content)
        propDiff.content = turn.content;
      if (existing.props.streaming !== turn.streaming)
        propDiff.streaming = turn.streaming;
      if (existing.props.emphasis !== turn.emphasis)
        propDiff.emphasis = turn.emphasis;
      if (existing.props.role !== turn.role) propDiff.role = turn.role;
      const sameMeta = shallowMetaEqual(
        existing.meta as Record<string, unknown>,
        turn.meta as unknown as Record<string, unknown>,
      );
      if (Object.keys(propDiff).length > 0 || !sameMeta) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        editor.updateShape({
          id,
          type: 'card',
          props: propDiff,
          meta: { ...turn.meta } as unknown as any,
        });
      }
    }
  }

  // Delete orphan cards
  for (const [id, shape] of existingCards) {
    if (!turnIds.has(id)) {
      editor.deleteShapes([shape.id]);
    }
  }

  // ── arrows: ensure one elbow arrow per parent->child edge ──
  syncArrows(editor, turns);
}

function syncArrows(editor: Editor, turns: Record<TurnId, Turn>): void {
  // Build the canonical edge set from the store: child.id -> parent.id
  const wantEdges = new Map<TurnId, TurnId>();
  for (const t of Object.values(turns)) {
    if (t.parentId) wantEdges.set(t.id, t.parentId);
  }

  // Read current edges from tldraw arrow bindings.
  const arrows = editor
    .getCurrentPageShapes()
    .filter((s) => s.type === 'arrow');
  const haveEdges = new Map<string, TLShapeId>(); // `${from}->${to}` -> arrowId
  const arrowsToDelete: TLShapeId[] = [];
  for (const a of arrows) {
    const bs = editor.getBindingsFromShape(a, 'arrow');
    const start = bs.find((b) => b.props.terminal === 'start');
    const end = bs.find((b) => b.props.terminal === 'end');
    if (!start || !end) {
      arrowsToDelete.push(a.id);
      continue;
    }
    const fromId = start.toId as TurnId;
    const toId = end.toId as TurnId;
    // Drop arrows that no longer reflect a real store edge.
    if (!turns[fromId] || !turns[toId] || wantEdges.get(toId) !== fromId) {
      arrowsToDelete.push(a.id);
      continue;
    }
    haveEdges.set(edgeKey(fromId, toId), a.id);
  }
  if (arrowsToDelete.length) editor.deleteShapes(arrowsToDelete);

  // Add missing edges
  for (const [childId, parentId] of wantEdges) {
    if (!haveEdges.has(edgeKey(parentId, childId))) {
      createElbowArrow(editor, parentId, childId);
    }
  }
}

function edgeKey(from: TurnId, to: TurnId): string {
  return `${from}->${to}`;
}

function createElbowArrow(
  editor: Editor,
  fromId: TLShapeId,
  toId: TLShapeId,
): void {
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
    console.warn('createElbowArrow failed', err);
  }
}

function shallowMetaEqual(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}
