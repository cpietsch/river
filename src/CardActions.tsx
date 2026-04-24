import { createContext, useContext } from 'react';
import type { TLShapeId } from 'tldraw';
import type { MistCandidate } from './api';

export interface CardActions {
  activeId: TLShapeId | null;
  branchFrom: (turnId: TLShapeId) => void;
  deleteCard: (turnId: TLShapeId) => void;
  regenerate: (turnId: TLShapeId) => void;

  // Input state for the active (empty-user) card — its content IS the chat input.
  input: string;
  setInput: (v: string) => void;
  onInputChange: (text: string) => void;
  mist: MistCandidate[];
  submit: (overrideText?: string) => void;
  commitMist: (c: MistCandidate) => void;
  busy: boolean;
}

export const CardActionsContext = createContext<CardActions | null>(null);

export function useCardActions(): CardActions | null {
  return useContext(CardActionsContext);
}
