import { createContext, useContext } from 'react';
import type { TLShapeId } from 'tldraw';
import type { MistCandidate } from './api';

export interface CardActions {
  activeId: TLShapeId | null;
  branchFrom: (turnId: TLShapeId) => void;
  branchAbout: (turnId: TLShapeId, term: string) => void;
  deleteCard: (turnId: TLShapeId) => void;

  // Input state for the active (empty-user) card — its content IS the chat input.
  input: string;
  setInput: (v: string) => void;
  onInputChange: (text: string) => void;
  mist: MistCandidate[];
  submit: (overrideText?: string) => void;
  commitMist: (c: MistCandidate) => void;
  resizeActive: (h: number) => void;
  resizeCard: (id: TLShapeId, h: number) => void;
  busy: boolean;
}

export const CardActionsContext = createContext<CardActions | null>(null);

export function useCardActions(): CardActions | null {
  return useContext(CardActionsContext);
}
