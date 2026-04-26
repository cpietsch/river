import type { AgentPrediction, ChipSpan } from '../api';

// Turn IDs are opaque strings (format "shape:abc123" — same convention the
// server-side makeShapeId uses, so client + server agree). Shared with the
// canvas renderer's node ids since each turn renders 1:1 as a node.
export type TurnId = string;

export type TurnRole = 'user' | 'assistant';

export interface TurnMeta {
  // The selectable phrase-spans Haiku identified in the assistant's prose,
  // along with each one's contextual hover question. The card renderer
  // wraps each span's first verbatim occurrence as a tappable chip.
  chipSpans?: ChipSpan[];
  // Predictions from all agents for this assistant turn — flat, each entry
  // tagged with its agent id. Pills above the next user input read this.
  predictions?: AgentPrediction[];
  // Labels of predictions the user has toggled "on" for the next turn.
  // Stored as labels (not indices) so re-fetches don't desync.
  predictionsToggled?: string[];
  // Inline chip phrases the user has tapped on this card. Toggleable
  // in-place. On submit, every selected chip across the active chain's
  // ancestors rides forward as userContext using its question as the full
  // sentence.
  chipsSelected?: string[];
  // 3-6 word title used by the map menu's tree view to summarize this card
  // at a glance. Generated lazily by /api/labels (Haiku) after content
  // settles, then cached. Falls back to a content preview when missing.
  label?: string;
  // Reason the agent flagged this card via the flag_card custom tool.
  // Lives alongside emphasis = 2 (which is the visual cue) — this carries
  // the *why* so the user can hover to read it. Cleared on un-flag.
  agentFlagReason?: string;
  // Discrete options the agent presented for the user to pick from, via
  // the present_options custom tool. Renders as a pill row at the bottom
  // of the assistant card; tapping a pill submits that option as the
  // user's next turn. Short labels (≤ ~40 chars), 2-6 entries.
  options?: string[];
}

export interface Turn {
  id: TurnId;
  role: TurnRole;
  content: string;
  parentId: TurnId | null;
  emphasis: number; // 1 = normal, 2 = emphasized (becomes priority constraint)
  streaming: boolean;
  meta: TurnMeta;
}

// Lateral relationship between two cards beyond parent → child. Created
// by the agent via the link_cards custom tool. Renders as a dashed arrow
// on the canvas so the user can see latent structure (this card answers
// that question, this contradicts that decision, this elaborates that
// claim). Layout ignores links — they're a visualization concern only.
export interface Link {
  id: string; // unique link id (link_xxx)
  fromId: TurnId;
  toId: TurnId;
  kind: string; // free-form short label: "answers", "contradicts", "elaborates", etc
}

// The full conversation graph: many turns connected by parent pointers,
// possibly multiple roots (one per "+ new"-d session). Indexed by id.
export interface ConversationGraph {
  turns: Record<TurnId, Turn>;
  links: Link[];
}
