import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type {
  AgentPrediction,
  BranchProposal,
  ChipSpan,
  ServerProject,
} from '../api';
import type { Link, Turn, TurnId, TurnMeta, TurnRole } from './types';

// Local id generator. Format mirrors the server (db.js's makeShapeId) so
// client- and server-minted ids are interchangeable. tldraw's
// `createShapeId` used to produce ids in the same shape; same convention
// kept on purpose so persisted state from older builds still loads.
function createShapeId(): TurnId {
  const a = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let body = '';
  for (let i = 0; i < 21; i++) body += a[Math.floor(Math.random() * a.length)];
  return `shape:${body}`;
}

interface NewTurnInit {
  id?: TurnId;
  role: TurnRole;
  content?: string;
  parentId: TurnId | null;
  emphasis?: number;
  streaming?: boolean;
  meta?: TurnMeta;
}

// Bulk replace of the active canvas's data — used when switching projects
// (fetched from server) or after a hard re-sync. Keeps activeProjectId
// management to the caller (App.tsx).
export interface ActiveCanvas {
  turns: Record<TurnId, Turn>;
  links: Link[];
  proposals: BranchProposal[];
  projectSessionId: string | null;
}

interface ConversationStore {
  // Per-tab UI state — which project this tab is currently looking at.
  // Persisted in localStorage so a reload picks up the same canvas.
  activeProjectId: string | null;

  // The full server-side project list. Refreshed on mount and after
  // mutations (create, delete, rename); not persisted (server is truth).
  projects: ServerProject[];

  // Active canvas's data — mirrored from the server's project state.
  // Local mutations also push to the API so the server stays canonical.
  // Not persisted: on reload we re-fetch from /api/projects/:id/state.
  turns: Record<TurnId, Turn>;
  projectSessionId: string | null;
  proposals: BranchProposal[];
  links: Link[];

  // Transient: what the agent is currently doing during a stream. Not
  // persisted.
  activity: { turnId: TurnId; text: string } | null;

  // ── Mutations ──────────────────────────────────────────────────────

  setActiveProjectId: (id: string | null) => void;
  setProjects: (projects: ServerProject[]) => void;
  // Replace the active canvas wholesale (after fetching server state).
  loadActiveCanvas: (data: ActiveCanvas) => void;
  // Clear local active-canvas state without changing activeProjectId
  // (e.g. while switching to a project whose state hasn't loaded yet).
  clearActiveCanvas: () => void;

  setProjectSessionId: (id: string | null) => void;
  setActivity: (entry: { turnId: TurnId; text: string } | null) => void;
  upsertTurnFromRemote: (turn: Turn) => void;

  addProposal: (proposal: BranchProposal) => void;
  removeProposal: (proposalId: string) => void;
  clearProposals: () => void;
  pruneStaleProposals: () => void;

  addLink: (link: Link) => void;
  removeLink: (linkId: string) => void;
  pruneStaleLinks: () => void;

  createTurn: (init: NewTurnInit) => TurnId;
  setContent: (
    id: TurnId,
    content: string,
    opts?: { streaming?: boolean },
  ) => void;
  setStreaming: (id: TurnId, streaming: boolean) => void;
  setEmphasis: (id: TurnId, emphasis: number) => void;
  setChipSpans: (id: TurnId, spans: ChipSpan[]) => void;
  setPredictions: (id: TurnId, predictions: AgentPrediction[]) => void;
  togglePrediction: (id: TurnId, label: string) => void;
  setLabel: (id: TurnId, label: string) => void;
  setAgentFlag: (id: TurnId, reason: string) => void;
  setCardOptions: (id: TurnId, options: string[]) => void;
  toggleChipSelected: (id: TurnId, term: string) => void;
  clearChipsSelected: (id: TurnId) => void;
  removeSubtree: (rootId: TurnId) => TurnId[];

  // ── Selectors ──────────────────────────────────────────────────────

  getTurn: (id: TurnId | null | undefined) => Turn | undefined;
  getChildren: (id: TurnId) => Turn[];
  getAncestors: (id: TurnId) => Turn[];
  getDescendants: (id: TurnId) => Turn[];
}

// Friendly project label, derived from the first user turn with content.
// "untitled canvas" when the canvas is blank. Used for display + as the
// project's auto-generated name when the server doesn't have a custom one.
export function deriveProjectName(turns: Record<TurnId, Turn>): string {
  const firstUser = Object.values(turns).find(
    (t) => t.role === 'user' && t.content.trim().length > 0,
  );
  if (!firstUser) return 'untitled canvas';
  const raw = firstUser.content.replace(/\s+/g, ' ').trim();
  return raw.length > 60 ? raw.slice(0, 60).trimEnd() + '…' : raw;
}

const EMPTY_CANVAS: ActiveCanvas = {
  turns: {},
  links: [],
  proposals: [],
  projectSessionId: null,
};

export const useConversation = create<ConversationStore>()(
  persist(
    (set, get) => ({
      activeProjectId: null,
      projects: [],
      turns: {},
      projectSessionId: null,
      proposals: [],
      links: [],
      activity: null,

      setActiveProjectId: (id) => set({ activeProjectId: id }),
      setProjects: (projects) => set({ projects }),
      loadActiveCanvas: (data) =>
        set({
          turns: data.turns,
          links: data.links,
          proposals: data.proposals,
          projectSessionId: data.projectSessionId,
        }),
      clearActiveCanvas: () => set({ ...EMPTY_CANVAS }),

      setProjectSessionId: (id) => set({ projectSessionId: id }),
      setActivity: (entry) => set({ activity: entry }),

      upsertTurnFromRemote: (turn) =>
        set((s) => ({ turns: { ...s.turns, [turn.id]: turn } })),

      addProposal: (proposal) =>
        set((s) => {
          const filtered = s.proposals.filter(
            (p) => p.proposalId !== proposal.proposalId,
          );
          return { proposals: [proposal, ...filtered].slice(0, 5) };
        }),
      removeProposal: (proposalId) =>
        set((s) => ({
          proposals: s.proposals.filter((p) => p.proposalId !== proposalId),
        })),
      clearProposals: () => set({ proposals: [] }),
      pruneStaleProposals: () =>
        set((s) => ({
          proposals: s.proposals.filter(
            (p) => !!s.turns[p.parentId as TurnId],
          ),
        })),

      addLink: (link) =>
        set((s) => {
          const filtered = s.links.filter(
            (l) =>
              l.id !== link.id &&
              !(l.fromId === link.fromId && l.toId === link.toId),
          );
          return { links: [...filtered, link].slice(-50) };
        }),
      removeLink: (linkId) =>
        set((s) => ({ links: s.links.filter((l) => l.id !== linkId) })),
      pruneStaleLinks: () =>
        set((s) => ({
          links: s.links.filter(
            (l) =>
              !!s.turns[l.fromId as TurnId] && !!s.turns[l.toId as TurnId],
          ),
        })),

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

      setStreaming: (id, streaming) =>
        set((s) => {
          const t = s.turns[id];
          if (!t) return s;
          return { turns: { ...s.turns, [id]: { ...t, streaming } } };
        }),

      setEmphasis: (id, emphasis) =>
        set((s) => {
          const t = s.turns[id];
          if (!t) return s;
          return { turns: { ...s.turns, [id]: { ...t, emphasis } } };
        }),

      setChipSpans: (id, chipSpans) =>
        set((s) => {
          const t = s.turns[id];
          if (!t) return s;
          return {
            turns: { ...s.turns, [id]: { ...t, meta: { ...t.meta, chipSpans } } },
          };
        }),

      setPredictions: (id, predictions) =>
        set((s) => {
          const t = s.turns[id];
          if (!t) return s;
          return {
            turns: {
              ...s.turns,
              [id]: { ...t, meta: { ...t.meta, predictions } },
            },
          };
        }),

      setCardOptions: (id, options) =>
        set((s) => {
          const t = s.turns[id];
          if (!t) return s;
          const cleaned = (Array.isArray(options) ? options : [])
            .map((o) => (typeof o === 'string' ? o.trim() : ''))
            .filter((o) => o.length > 0)
            .slice(0, 6);
          return {
            turns: {
              ...s.turns,
              [id]: { ...t, meta: { ...t.meta, options: cleaned } },
            },
          };
        }),

      setAgentFlag: (id, reason) =>
        set((s) => {
          const t = s.turns[id];
          if (!t) return s;
          return {
            turns: {
              ...s.turns,
              [id]: {
                ...t,
                emphasis: 2,
                meta: {
                  ...t.meta,
                  agentFlagReason: reason.trim() || undefined,
                },
              },
            },
          };
        }),

      setLabel: (id, label) =>
        set((s) => {
          const t = s.turns[id];
          if (!t) return s;
          if (t.meta.label === label) return s;
          return {
            turns: { ...s.turns, [id]: { ...t, meta: { ...t.meta, label } } },
          };
        }),

      togglePrediction: (id, label) =>
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
        }),

      toggleChipSelected: (id, term) =>
        set((s) => {
          const t = s.turns[id];
          if (!t) return s;
          const cur = new Set(t.meta.chipsSelected ?? []);
          if (cur.has(term)) cur.delete(term);
          else cur.add(term);
          return {
            turns: {
              ...s.turns,
              [id]: {
                ...t,
                meta: { ...t.meta, chipsSelected: Array.from(cur) },
              },
            },
          };
        }),

      clearChipsSelected: (id) =>
        set((s) => {
          const t = s.turns[id];
          if (!t || !t.meta.chipsSelected || t.meta.chipsSelected.length === 0) {
            return s;
          }
          return {
            turns: {
              ...s.turns,
              [id]: { ...t, meta: { ...t.meta, chipsSelected: [] } },
            },
          };
        }),

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
          const links = s.links.filter(
            (l) =>
              !toRemove.has(l.fromId as TurnId) &&
              !toRemove.has(l.toId as TurnId),
          );
          const proposals = s.proposals.filter(
            (p) => !toRemove.has(p.parentId as TurnId),
          );
          return { turns: next, links, proposals };
        });
        return Array.from(toRemove);
      },

      getTurn: (id) => (id ? get().turns[id] : undefined),

      getChildren: (id) =>
        Object.values(get().turns).filter((t) => t.parentId === id),

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
      // Bumped from 'river-2-graph' to invalidate any old localStorage
      // shape from before the server-as-source-of-truth refactor. Now we
      // persist ONLY which project this tab is looking at; everything
      // else comes from the server on mount.
      name: 'river-2-active-v2',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ activeProjectId: state.activeProjectId }),
    },
  ),
);
