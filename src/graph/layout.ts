import dagre from 'dagre';
import type { Edge, Node } from '@xyflow/react';
import type { Link, Turn, TurnId } from './types';

// Fixed card width used both for layout calculations and the card node
// component itself. Mirrors the legacy CARD_WIDTH from the tldraw
// implementation so existing canvases lay out the same way.
export const CARD_WIDTH =
  typeof window !== 'undefined'
    ? Math.min(540, Math.max(280, window.innerWidth - 24))
    : 540;

// Minimum height we hand to dagre. The actual node rendered by React Flow
// auto-grows to fit its content; dagre uses this as a placeholder so
// columns aren't crammed before the first measurement comes in. The card
// node component then re-reports its real height so the next layout pass
// has accurate dimensions.
export const CARD_HEIGHT_HINT = 140;
const COLUMN_GAP = 80;
const ROW_GAP = 40;

/**
 * Build the React Flow node + edge sets from the conversation store.
 * Layout is a top-down dagre tidy-tree. Heights are taken from the
 * `heights` map (last measured per-card) when available; falls back to
 * CARD_HEIGHT_HINT.
 */
export function buildFlow(
  turns: Record<TurnId, Turn>,
  links: Link[],
  heights: Record<TurnId, number>,
): { nodes: Node[]; edges: Edge[] } {
  const turnList = Object.values(turns);
  if (turnList.length === 0) return { nodes: [], edges: [] };

  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: 'TB',
    nodesep: COLUMN_GAP,
    ranksep: ROW_GAP,
    marginx: 40,
    marginy: 40,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const t of turnList) {
    g.setNode(t.id, {
      width: CARD_WIDTH,
      height: heights[t.id] ?? CARD_HEIGHT_HINT,
    });
  }
  for (const t of turnList) {
    if (t.parentId && turns[t.parentId]) {
      g.setEdge(t.parentId, t.id);
    }
  }

  dagre.layout(g);

  const nodes: Node[] = turnList.map((t) => {
    const pos = g.node(t.id);
    return {
      id: t.id,
      type: 'card',
      position: {
        // dagre anchors at center; React Flow at top-left.
        x: (pos?.x ?? 0) - CARD_WIDTH / 2,
        y: (pos?.y ?? 0) - (heights[t.id] ?? CARD_HEIGHT_HINT) / 2,
      },
      data: { turnId: t.id },
      // No drag — positions come from layout, not user dragging.
      draggable: false,
      // Card UI handles all internal interaction; we don't want the
      // node-wrapping selection/move cursor.
      selectable: false,
      // Apply nodrag/nopan at the React Flow node wrapper so any pointer
      // event originating inside a card is excluded from React Flow's
      // drag/pan filters at the boundary — interactive children (chips,
      // text selection) work without the d3-zoom pane handler eating
      // their pointerdown.
      className: 'nodrag nopan',
      // React Flow sets `pointer-events: none` on the node wrapper when
      // the node is neither selectable nor draggable AND no node-level
      // mouse handlers are bound on <ReactFlow> (see NodeWrapper's
      // hasPointerEvents check in @xyflow/react). Cards still need to
      // receive pointer events to drive their own internal UI (textarea
      // focus, chip taps, button presses), so re-enable here. `style` is
      // spread after the computed pointerEvents in NodeWrapper, so this
      // wins.
      style: { pointerEvents: 'all' },
    };
  });

  const edges: Edge[] = [];
  for (const t of turnList) {
    if (t.parentId && turns[t.parentId]) {
      edges.push({
        id: `parent-${t.parentId}-${t.id}`,
        source: t.parentId,
        target: t.id,
        type: 'parent',
      });
    }
  }
  for (const l of links) {
    if (turns[l.fromId] && turns[l.toId]) {
      edges.push({
        id: l.id,
        source: l.fromId,
        target: l.toId,
        type: 'link',
        data: { kind: l.kind },
      });
    }
  }

  return { nodes, edges };
}
