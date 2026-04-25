import { createContext, useContext } from 'react';
import type { TLShapeId } from 'tldraw';
import type { AgentPrediction } from './api';

export interface CardActions {
  activeId: TLShapeId | null;
  // Predictions from all agents (assumption / skeptic / expander / …) for the
  // active input card's parent assistant — rendered as inline pills above the
  // textarea, color-coded by agent. Empty until the parent's predictions
  // settle (or when there is no parent yet).
  activePredictions: AgentPrediction[];
  // Subset of activePredictions labels the user has toggled on. Each toggled
  // label's `full` sentence is sent as userContext on the next turn (or as
  // the user message itself when no text is typed).
  activeToggled: Set<string>;
  branchFrom: (turnId: TLShapeId) => void;
  // Pin a chip from inline assistant text as a pill on the active input.
  // Tapping again removes it. Shares the toggle pipeline with agents.
  pinChip: (term: string, question: string) => void;
  togglePrediction: (prediction: AgentPrediction) => void;
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
