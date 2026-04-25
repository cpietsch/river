import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { createShapeId } from 'tldraw';
import type { AgentPrediction } from '../api';
import type { Turn, TurnId, TurnMeta, TurnRole } from './types';

interface NewTurnInit {
  id?: TurnId;
  role: TurnRole;
  content?: string;
  parentId: TurnId | null;
  emphasis?: number;
  streaming?: boolean;
  meta?: TurnMeta;
}

interface ConversationStore {
  turns: Record<TurnId, Turn>;

  // Mutations
  createTurn: (init: NewTurnInit) => TurnId;
  setContent: (
    id: TurnId,
    content: string,
    opts?: { streaming?: boolean },
  ) => void;
  setStreaming: (id: TurnId, streaming: boolean) => void;
  setEmphasis: (id: TurnId, emphasis: number) => void;
  setChipQuestions: (id: TurnId, questions: Record<string, string>) => void;
  setPredictions: (id: TurnId, predictions: AgentPrediction[]) => void;
  togglePrediction: (id: TurnId, label: string) => void;
  removeSubtree: (rootId: TurnId) => TurnId[];
  reset: () => void;

  // Selectors (read directly from current state — call via getState() in
  // imperative code, or from useConversation() in React).
  getTurn: (id: TurnId | null | undefined) => Turn | undefined;
  getChildren: (id: TurnId) => Turn[];
  getAncestors: (id: TurnId) => Turn[]; // root → leaf, includes self
  getDescendants: (id: TurnId) => Turn[]; // BFS from id, includes self
}

export const useConversation = create<ConversationStore>()(
  persist(
    (set, get) => ({
  turns: {},

  createTurn: (init) => {
    const id: TurnId = init.id ?? createShapeId();
    const turn: Turn = {
      id,
      role: init.role,
      content: init.content ?? '',
      parentId: init.parentId,
      emphasis: init.emphasis ?? 1,
      streaming: init.streaming ?? false,
      meta: init.meta ?? {},
    };
    set((s) => ({ turns: { ...s.turns, [id]: turn } }));
    return id;
  },

  setContent: (id, content, opts) => {
    set((s) => {
      const t = s.turns[id];
      if (!t) return s;
      const next: Turn = {
        ...t,
        content,
        streaming: opts?.streaming ?? t.streaming,
      };
      return { turns: { ...s.turns, [id]: next } };
    });
  },

  setStreaming: (id, streaming) => {
    set((s) => {
      const t = s.turns[id];
      if (!t) return s;
      return { turns: { ...s.turns, [id]: { ...t, streaming } } };
    });
  },

  setEmphasis: (id, emphasis) => {
    set((s) => {
      const t = s.turns[id];
      if (!t) return s;
      return { turns: { ...s.turns, [id]: { ...t, emphasis } } };
    });
  },

  setChipQuestions: (id, chipQuestions) => {
    set((s) => {
      const t = s.turns[id];
      if (!t) return s;
      return {
        turns: {
          ...s.turns,
          [id]: { ...t, meta: { ...t.meta, chipQuestions } },
        },
      };
    });
  },

  setPredictions: (id, predictions) => {
    set((s) => {
      const t = s.turns[id];
      if (!t) return s;
      return {
        turns: {
          ...s.turns,
          [id]: { ...t, meta: { ...t.meta, predictions } },
        },
      };
    });
  },

  togglePrediction: (id, label) => {
    set((s) => {
      const t = s.turns[id];
      if (!t) return s;
      const cur = new Set(t.meta.predictionsToggled ?? []);
      if (cur.has(label)) cur.delete(label);
      else cur.add(label);
      return {
        turns: {
          ...s.turns,
          [id]: {
            ...t,
            meta: { ...t.meta, predictionsToggled: Array.from(cur) },
          },
        },
      };
    });
  },

  removeSubtree: (rootId) => {
    const all = get().turns;
    const toRemove = new Set<TurnId>();
    const queue: TurnId[] = [rootId];
    while (queue.length) {
      const cur = queue.shift()!;
      if (toRemove.has(cur)) continue;
      toRemove.add(cur);
      for (const t of Object.values(all)) {
        if (t.parentId === cur) queue.push(t.id);
      }
    }
    set((s) => {
      const next = { ...s.turns };
      for (const id of toRemove) delete next[id];
      return { turns: next };
    });
    return Array.from(toRemove);
  },

  reset: () => set({ turns: {} }),

  getTurn: (id) => (id ? get().turns[id] : undefined),

  getChildren: (id) => {
    const all = get().turns;
    return Object.values(all).filter((t) => t.parentId === id);
  },

  getAncestors: (id) => {
    const all = get().turns;
    const chain: Turn[] = [];
    let cur: TurnId | null = id;
    const seen = new Set<TurnId>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const t: Turn | undefined = all[cur];
      if (!t) break;
      chain.push(t);
      cur = t.parentId;
    }
    return chain.reverse();
  },

  getDescendants: (id) => {
    const all = get().turns;
    const out: Turn[] = [];
    const queue: TurnId[] = [id];
    const seen = new Set<TurnId>();
    while (queue.length) {
      const cur = queue.shift()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const t: Turn | undefined = all[cur];
      if (!t) continue;
      out.push(t);
      for (const child of Object.values(all)) {
        if (child.parentId === cur) queue.push(child.id);
      }
    }
    return out;
  },
    }),
    {
      name: 'river-2-graph',
      storage: createJSONStorage(() => localStorage),
      // Only persist the data, not the action functions.
      partialize: (state) => ({ turns: state.turns }),
    },
  ),
);
