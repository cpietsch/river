import type { TLShapeId } from 'tldraw';
import type { AgentPrediction } from '../api';

// Turn IDs reuse tldraw's TLShapeId so the graph store and the canvas share
// a single id space — a turn and its rendered card shape are the same id.
export type TurnId = TLShapeId;

export type TurnRole = 'user' | 'assistant';

export interface TurnMeta {
  // Map of [[term]] -> contextual question, populated post-stream by Haiku.
  chipQuestions?: Record<string, string>;
  // Predictions from all agents for this assistant turn — flat, each entry
  // tagged with its agent id. Pills above the next user input read this.
  predictions?: AgentPrediction[];
  // Labels of predictions the user has toggled "on" for the next turn.
  // Stored as labels (not indices) so re-fetches don't desync.
  predictionsToggled?: string[];
  // Inline chip terms the user has tapped on this card. Toggleable in-place
  // (not moved to the input row). On submit, every selected chip across the
  // active chain's ancestors rides forward as userContext using its
  // chipQuestions[term] entry as the full sentence.
  chipsSelected?: string[];
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

// The full conversation graph: many turns connected by parent pointers,
// possibly multiple roots (one per "+ new"-d session). Indexed by id.
export interface ConversationGraph {
  turns: Record<TurnId, Turn>;
}
