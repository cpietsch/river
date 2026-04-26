import { createContext, useContext } from 'react';
import type { AgentPrediction } from './api';
import type { TurnId } from './graph/types';

export interface CardActions {
  activeId: TurnId | null;
  // Predictions from all agents (assumption / skeptic / expander / …) for the
  // active input card's parent assistant — rendered as inline pills above the
  // textarea, color-coded by agent. Empty until the parent's predictions
  // settle (or when there is no parent yet).
  activePredictions: AgentPrediction[];
  // Subset of activePredictions labels the user has toggled on. Each toggled
  // label's `full` sentence is sent as userContext on the next turn (or as
  // the user message itself when no text is typed).
  activeToggled: Set<string>;
  // True when any inline chip is selected on any ancestor of the active
  // card. The send button uses this to enable empty-input submission when
  // chips alone are the user's intent.
  hasChipSelections: boolean;
  // Total number of selected inline chips across the active chain's
  // ancestors — surfaced as a counter pill in the input row so the user
  // sees their text selections at a glance.
  chipSelectionCount: number;
  // Clear every selected chip across the active chain's ancestors.
  clearAllChipSelections: () => void;
  branchFrom: (turnId: TurnId) => void;
  // Submit an option pill verbatim as the next user turn. Bypasses the
  // input field — the user already chose by tapping. Clears the options
  // on the source card so the canvas reads cleanly when scrolled back to
  // (the chosen text shows up as the next user turn anyway).
  pickOption: (cardId: TurnId, text: string) => void;
  // Toggle an inline [[term]] chip's selected state in-place on its card.
  // On submit, every selected chip across the active chain's ancestors
  // rides forward as userContext.
  toggleChipSelected: (cardId: TurnId, term: string) => void;
  togglePrediction: (prediction: AgentPrediction) => void;
  toggleEmphasis: (turnId: TurnId) => void;
  deleteCard: (turnId: TurnId) => void;

  // Input state for the active (empty-user) card — its content IS the chat input.
  input: string;
  setInput: (v: string) => void;
  onInputChange: (text: string) => void;
  submit: (overrideText?: string) => void;
  resizeActive: (h: number) => void;
  resizeCard: (id: TurnId, h: number) => void;
  busy: boolean;
}

export const CardActionsContext = createContext<CardActions | null>(null);

export function useCardActions(): CardActions | null {
  return useContext(CardActionsContext);
}
