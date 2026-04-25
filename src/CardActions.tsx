import { createContext, useContext } from 'react';
import type { TLShapeId } from 'tldraw';
import type { Presumption } from './api';

export interface CardActions {
  activeId: TLShapeId | null;
  // Reflections for the active input card's parent assistant — rendered as
  // inline pills above the textarea. Empty until the parent's reflections
  // settle (or when there is no parent yet).
  activeReflections: Presumption[];
  // Subset of activeReflections labels the user has toggled on. Each toggled
  // label's `full` sentence is sent as userContext on the next turn.
  activeToggled: Set<string>;
  branchFrom: (turnId: TLShapeId) => void;
  branchAbout: (turnId: TLShapeId, term: string) => void;
  toggleReflection: (presumption: Presumption) => void;
  toggleEmphasis: (turnId: TLShapeId) => void;
  deleteCard: (turnId: TLShapeId) => void;

  // Input state for the active (empty-user) card — its content IS the chat input.
  input: string;
  setInput: (v: string) => void;
  onInputChange: (text: string) => void;
  submit: (overrideText?: string) => void;
  resizeActive: (h: number) => void;
  resizeCard: (id: TLShapeId, h: number) => void;
  busy: boolean;
}

export const CardActionsContext = createContext<CardActions | null>(null);

export function useCardActions(): CardActions | null {
  return useContext(CardActionsContext);
}
