import { createContext, useContext } from 'react';
import type { TLShapeId } from 'tldraw';

export interface CardActions {
  branchFrom: (turnId: TLShapeId) => void;
  regenerate: (turnId: TLShapeId) => void;
  activeId: TLShapeId | null;
}

export const CardActionsContext = createContext<CardActions | null>(null);

export function useCardActions(): CardActions | null {
  return useContext(CardActionsContext);
}
