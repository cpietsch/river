import { createContext, useContext } from 'react';
import type { TLShapeId } from 'tldraw';

export interface CardActions {
  activeId: TLShapeId | null;
  reflectionsVisible: boolean;
  branchFrom: (turnId: TLShapeId) => void;
  branchAbout: (turnId: TLShapeId, term: string) => void;
  promoteReflection: (turnId: TLShapeId) => void;
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
