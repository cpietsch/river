import {
  createShapeId,
  toRichText,
  type Editor,
  type TLShapeId,
} from 'tldraw';
import type { CardShape } from '../CardShape';
import { CARD_WIDTH, CARD_HEIGHT_MIN } from '../CardShape';
import { useConversation } from './store';
import type { Link, Turn, TurnId } from './types';

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
  const { turns, links } = useConversation.getState();
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

  // ── arrows: parent edges (one per parent->child) + link arrows (one
  // per Link in the store), reconciled separately so each kind reads
  // from its own canonical source. ──
  syncArrows(editor, turns, links);

  // ── card annotations: a small native tldraw text shape per card that
  // has meta.label. Tagged with meta.kind='card_label' + meta.cardId so
  // the syncer can correlate them. Positioned by relayoutAll, not here.
  syncCardLabels(editor, turns);

  // Final sweep: any arrow without both bindings is an orphan tldraw
  // didn't clean up after its bound cards were deleted. syncArrows
  // should delete these via its own logic, but in practice some survive
  // (tldraw appears to defer arrow deletion past the bindings-cleared
  // state). Belt-and-suspenders deletion catches them.
  const lingering: TLShapeId[] = [];
  for (const s of editor.getCurrentPageShapes()) {
    if (s.type !== 'arrow') continue;
    const bs = editor.getBindingsFromShape(s, 'arrow');
    if (bs.length < 2) lingering.push(s.id);
  }
  if (lingering.length) editor.deleteShapes(lingering);

}

function syncArrows(
  editor: Editor,
  turns: Record<TurnId, Turn>,
  links: Link[],
): void {
  // ── parent edges canonical set: child.id -> parent.id ──
  const wantParent = new Map<TurnId, TurnId>();
  for (const t of Object.values(turns)) {
    if (t.parentId) wantParent.set(t.id, t.parentId);
  }
  // ── link edges canonical set: keyed by from->to (one direction matters) ──
  const wantLinks = new Map<string, Link>();
  for (const l of links) {
    if (turns[l.fromId as TurnId] && turns[l.toId as TurnId]) {
      wantLinks.set(edgeKey(l.fromId as TurnId, l.toId as TurnId), l);
    }
  }

  // Read current arrows from tldraw and categorize by meta.kind ('parent'
  // | 'link'). Arrows pre-dating the meta.kind convention default to
  // 'parent' for migration safety.
  const arrows = editor
    .getCurrentPageShapes()
    .filter((s) => s.type === 'arrow');
  const haveParent = new Map<string, TLShapeId>();
  const haveLink = new Map<string, TLShapeId>();
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
    if (!turns[fromId] || !turns[toId]) {
      arrowsToDelete.push(a.id);
      continue;
    }
    const meta = (a.meta ?? {}) as { kind?: string };
    const kind = meta.kind === 'link' ? 'link' : 'parent';
    if (kind === 'link') {
      const k = edgeKey(fromId, toId);
      if (!wantLinks.has(k)) {
        arrowsToDelete.push(a.id);
        continue;
      }
      haveLink.set(k, a.id);
    } else {
      // Parent arrow validity = the canonical parent map says toId's
      // parent is fromId. Anything else is stale.
      if (wantParent.get(toId) !== fromId) {
        arrowsToDelete.push(a.id);
        continue;
      }
      haveParent.set(edgeKey(fromId, toId), a.id);
    }
  }
  if (arrowsToDelete.length) editor.deleteShapes(arrowsToDelete);

  // Add missing parent arrows
  for (const [childId, parentId] of wantParent) {
    if (!haveParent.has(edgeKey(parentId, childId))) {
      createParentArrow(editor, parentId, childId);
    }
  }
  // Add missing link arrows
  for (const [k, link] of wantLinks) {
    if (!haveLink.has(k)) {
      createLinkArrow(
        editor,
        link.fromId as TurnId,
        link.toId as TurnId,
      );
    }
  }
}

function edgeKey(from: TurnId, to: TurnId): string {
  return `${from}->${to}`;
}

function createParentArrow(
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
      meta: { kind: 'parent' },
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
    console.warn('createParentArrow failed', err);
  }
}

/**
 * Lateral link arrow created via the agent's link_cards tool. Visually
 * distinct from parent arrows: dashed light-violet stroke, no elbow
 * (curved arc routed by tldraw's default), so the user sees latent
 * structure without confusing it with parent → child flow.
 */
function createLinkArrow(
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
      meta: { kind: 'link' },
      props: {
        kind: 'arc',
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
        normalizedAnchor: { x: 0.5, y: 0.5 },
        isExact: false,
        isPrecise: false,
        snap: 'none',
      },
    });
    editor.createBinding({
      type: 'arrow',
      fromId: arrowId,
      toId: toId,
      props: {
        terminal: 'end',
        normalizedAnchor: { x: 0.5, y: 0.5 },
        isExact: false,
        isPrecise: false,
        snap: 'none',
      },
    });
  } catch (err) {
    console.warn('createLinkArrow failed', err);
  }
}

// Native tldraw text shapes used as small classification labels above each
// card. Tagged with meta.kind='card_label' + meta.cardId so the syncer can
// correlate them. Position is set here at create time and refreshed by the
// relayout pass when card positions change.
function syncCardLabels(
  editor: Editor,
  turns: Record<TurnId, Turn>,
): void {
  const wantLabels = new Map<TurnId, string>();
  for (const t of Object.values(turns)) {
    const label = (t.meta as { label?: string } | undefined)?.label;
    if (label && label.trim()) wantLabels.set(t.id, label.trim());
  }

  const haveLabels = new Map<TurnId, TLShapeId>();
  const orphans: TLShapeId[] = [];
  for (const s of editor.getCurrentPageShapes()) {
    if (s.type !== 'text') continue;
    const meta = (s.meta ?? {}) as { kind?: string; cardId?: string };
    if (meta.kind !== 'card_label') continue;
    const cardId = meta.cardId as TurnId | undefined;
    if (!cardId || !wantLabels.has(cardId)) {
      orphans.push(s.id);
    } else {
      haveLabels.set(cardId, s.id);
    }
  }
  if (orphans.length) editor.deleteShapes(orphans);

  for (const [cardId, label] of wantLabels) {
    const cardShape = editor.getShape(cardId) as unknown as
      | { x: number; y: number }
      | undefined;
    if (!cardShape) continue;
    const text = label.toUpperCase();
    const existing = haveLabels.get(cardId);
    if (existing) {
      const exShape = editor.getShape(existing) as
        | { props: { richText: unknown }; x: number; y: number }
        | undefined;
      // Update text only if changed; tldraw richText is a JSON tree so we
      // don't try to deep-compare — just write the new value when the raw
      // label string differs from the cached one we stored on meta.label.
      const exMeta = exShape
        ? (editor.getShape(existing)?.meta as { label?: string } | undefined)
        : undefined;
      if (exMeta?.label !== label) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        editor.updateShape({
          id: existing,
          type: 'text',
          props: { richText: toRichText(text) },
          meta: { kind: 'card_label', cardId, label } as unknown as any,
        });
      }
    } else {
      const labelId = createShapeId();
      try {
        // NOTE: deliberately not isLocked. tldraw's editor.updateShape
        // silently no-ops on locked shapes, which breaks repositioning
        // when relayout moves the parent card. Users can't drag anyway —
        // the editor is hard-locked to the hand tool elsewhere.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        editor.createShape({
          id: labelId,
          type: 'text',
          x: cardShape.x,
          y: cardShape.y - 20,
          meta: { kind: 'card_label', cardId, label } as unknown as any,
          props: {
            richText: toRichText(text),
            color: 'grey',
            font: 'sans',
            size: 's',
            autoSize: true,
            scale: 0.55,
          },
        });
      } catch (err) {
        console.warn('syncCardLabels: createShape failed', err);
      }
    }
  }
}

/**
 * Re-position the card_label text shapes to sit just above their card.
 * Called by App.relayoutAll after card positions are written.
 */
export function repositionCardLabels(editor: Editor): void {
  for (const s of editor.getCurrentPageShapes()) {
    if (s.type !== 'text') continue;
    const meta = (s.meta ?? {}) as { kind?: string; cardId?: string };
    if (meta.kind !== 'card_label' || !meta.cardId) continue;
    const card = editor.getShape(meta.cardId as TLShapeId) as
      | { x: number; y: number }
      | undefined;
    if (!card) continue;
    const targetX = card.x;
    const targetY = card.y - 20;
    if (
      Math.abs((s as unknown as { x: number }).x - targetX) >= 1 ||
      Math.abs((s as unknown as { y: number }).y - targetY) >= 1
    ) {
      editor.updateShape({ id: s.id, type: 'text', x: targetX, y: targetY });
    }
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
