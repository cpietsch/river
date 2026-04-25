import type { TLShapeId } from 'tldraw';
import type { Presumption } from '../api';

// Turn IDs reuse tldraw's TLShapeId so the graph store and the canvas share
// a single id space — a turn and its rendered card shape are the same id.
export type TurnId = TLShapeId;

export type TurnRole = 'user' | 'assistant';

export interface TurnMeta {
  // Map of [[term]] -> contextual question, populated post-stream by Haiku.
  chipQuestions?: Record<string, string>;
  // The 6 implicit assumptions surfaced for this assistant turn. Pills above
  // the next user input read from this.
  reflections?: Presumption[];
  // Labels of reflections the user has toggled "on" for the next turn.
  reflectionsToggled?: string[];
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
