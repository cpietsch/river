import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { createShapeId } from 'tldraw';
import type { AgentPrediction, BranchProposal, ChipSpan } from '../api';
import type { Link, Turn, TurnId, TurnMeta, TurnRole } from './types';

interface NewTurnInit {
  id?: TurnId;
  role: TurnRole;
  content?: string;
  parentId: TurnId | null;
  emphasis?: number;
  streaming?: boolean;
  meta?: TurnMeta;
}

// Snapshot of a prior canvas (project) the user has set aside. Held in
// `archive[]` so the projects menu can list them and the user can resume
// or delete each one. The session id is preserved — resuming reattaches
// to the same Managed Agent session, so the brain's memory + container
// state pick up where it left off.
export interface ArchivedProject {
  id: string;             // local id (proj_*) — distinct from sessionId
  name: string;
  sessionId: string | null;
  turns: Record<TurnId, Turn>;
  savedAt: number;
}

interface ConversationStore {
  // Stable identifier for the active project. Server uses this to scope
  // persisted state per canvas (Phase 0b — lazily created on the server
  // on the first /api/generate call when an activeProjectId arrives).
  activeProjectId: string;
  // Active canvas working set.
  turns: Record<TurnId, Turn>;
  // Persistent Managed Agent session for the active project. All turns
  // across all branches share this one session; the brain's memory store +
  // container state evolve over the canvas's lifetime. Multi-project: each
  // ArchivedProject holds its own sessionId — resuming swaps it in here.
  projectSessionId: string | null;
  // Prior projects the user has stashed via "+ new canvas". Most-recent
  // first. Manual delete only — auto-delete would orphan sessions the user
  // may want to return to.
  archive: ArchivedProject[];
  // Transient: what the agent is currently doing (tool call description),
  // bound to the streaming assistant turn. Set on each tool_use event,
  // cleared on the first text delta after, and on stream end. Not
  // persisted — pure UI feedback.
  activity: { turnId: TurnId; text: string } | null;
  // Pending branch proposals from the agent (create_branch). Persisted
  // alongside the active canvas so reloads don't lose them. Cleared on
  // accept / dismiss / canvas switch / + new.
  proposals: BranchProposal[];
  // Lateral connections the agent has drawn between cards via link_cards.
  // Rendered as dashed arrows on the canvas. Persisted with turns so the
  // visualization survives reloads and project switches.
  links: Link[];

  // Mutations — active canvas
  setProjectSessionId: (id: string | null) => void;
  setActivity: (entry: { turnId: TurnId; text: string } | null) => void;
  // Replace a turn wholesale from a remote source (server-side push or
  // initial fetch). Creates if absent, replaces all fields if present.
  // Used by the WS sync hook so a single message applies fully.
  upsertTurnFromRemote: (turn: Turn) => void;
  addProposal: (proposal: BranchProposal) => void;
  removeProposal: (proposalId: string) => void;
  clearProposals: () => void;
  pruneStaleProposals: () => void; // drops proposals whose parentId no longer exists
  addLink: (link: Link) => void;
  removeLink: (linkId: string) => void;
  pruneStaleLinks: () => void; // drops links whose endpoints no longer exist
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
  // Agent-driven emphasis flip: sets emphasis=2 AND records the reason on
  // meta.agentFlagReason so the UI can surface the why on hover. Distinct
  // from the user-driven `setEmphasis` so the two intents don't tangle.
  setAgentFlag: (id: TurnId, reason: string) => void;
  // Discrete pick-from list the agent attached to a card via the
  // present_options custom tool. Renders as a pill row below the prose.
  setCardOptions: (id: TurnId, options: string[]) => void;
  toggleChipSelected: (id: TurnId, term: string) => void;
  clearChipsSelected: (id: TurnId) => void;
  removeSubtree: (rootId: TurnId) => TurnId[];
  reset: () => void;

  // Mutations — project lifecycle
  archiveAndReset: () => void;            // stash active to archive, blank slate
  resumeArchived: (archiveId: string) => boolean; // swap active <-> archived
  deleteArchived: (archiveId: string) => void;    // returns sessionId so caller can DELETE it server-side
  renameArchived: (archiveId: string, name: string) => void;

  // Selectors (read directly from current state — call via getState() in
  // imperative code, or from useConversation() in React).
  getTurn: (id: TurnId | null | undefined) => Turn | undefined;
  getChildren: (id: TurnId) => Turn[];
  getAncestors: (id: TurnId) => Turn[]; // root → leaf, includes self
  getDescendants: (id: TurnId) => Turn[]; // BFS from id, includes self
}

function makeProjectId(): string {
  return 'proj_' + Math.random().toString(36).slice(2, 10);
}

// Friendly project label, derived from the first user turn with content.
// "untitled" when the canvas is blank. Used at archive time so the projects
// menu has something to show; user can rename via renameArchived later.
export function deriveProjectName(turns: Record<TurnId, Turn>): string {
  const firstUser = Object.values(turns).find(
    (t) => t.role === 'user' && t.content.trim().length > 0,
  );
  if (!firstUser) return 'untitled canvas';
  const raw = firstUser.content.replace(/\s+/g, ' ').trim();
  return raw.length > 60 ? raw.slice(0, 60).trimEnd() + '…' : raw;
}

export const useConversation = create<ConversationStore>()(
  persist(
    (set, get) => ({
  activeProjectId: makeProjectId(),
  turns: {},
  projectSessionId: null,
  archive: [],
  activity: null,
  proposals: [],
  links: [],

  setProjectSessionId: (id) => set({ projectSessionId: id }),
  setActivity: (entry) => set({ activity: entry }),

  upsertTurnFromRemote: (turn) =>
    set((s) => ({
      turns: { ...s.turns, [turn.id]: turn },
    })),

  addProposal: (proposal) =>
    set((s) => {
      // Drop any duplicate (same proposalId) and cap at 5 to avoid runaway
      // visual noise from chatty agents.
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
      // Drop duplicates (same from/to pair) — re-firing should replace,
      // not stack. Also dedupe by exact id in case the server retries.
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

  setChipSpans: (id, chipSpans) => {
    set((s) => {
      const t = s.turns[id];
      if (!t) return s;
      return {
        turns: {
          ...s.turns,
          [id]: { ...t, meta: { ...t.meta, chipSpans } },
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

  setCardOptions: (id, options) => {
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
    });
  },

  setAgentFlag: (id, reason) => {
    set((s) => {
      const t = s.turns[id];
      if (!t) return s;
      return {
        turns: {
          ...s.turns,
          [id]: {
            ...t,
            emphasis: 2,
            meta: { ...t.meta, agentFlagReason: reason.trim() || undefined },
          },
        },
      };
    });
  },

  setLabel: (id, label) => {
    set((s) => {
      const t = s.turns[id];
      if (!t) return s;
      if (t.meta.label === label) return s;
      return {
        turns: {
          ...s.turns,
          [id]: { ...t, meta: { ...t.meta, label } },
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

  toggleChipSelected: (id, term) => {
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
    });
  },

  clearChipsSelected: (id) => {
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
      // Drop links + proposals whose endpoints fell with the subtree.
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

  reset: () =>
    set({
      activeProjectId: makeProjectId(),
      turns: {},
      projectSessionId: null,
      proposals: [],
      links: [],
    }),

  // Stash the active canvas onto the archive list and clear active state. No
  // session deletion — the user may resume this project later. Empty active
  // canvases (no content, no session) are dropped instead of archived to
  // avoid spamming the menu with placeholders.
  archiveAndReset: () => {
    set((s) => {
      const hasContent = Object.values(s.turns).some(
        (t) => t.content.trim().length > 0,
      );
      const worth = hasContent || s.projectSessionId !== null;
      const nextArchive = worth
        ? [
            {
              id: s.activeProjectId,
              name: deriveProjectName(s.turns),
              sessionId: s.projectSessionId,
              turns: s.turns,
              savedAt: Date.now(),
            },
            ...s.archive,
          ]
        : s.archive;
      return {
        activeProjectId: makeProjectId(),
        turns: {},
        projectSessionId: null,
        archive: nextArchive,
        proposals: [],
        links: [],
      };
    });
  },

  // Resume an archived project: stash the current active canvas onto the
  // archive (so jumping away doesn't lose it) and swap the chosen archived
  // project into active. Returns false if the id wasn't found.
  resumeArchived: (archiveId) => {
    const cur = get();
    const target = cur.archive.find((a) => a.id === archiveId);
    if (!target) return false;
    const remaining = cur.archive.filter((a) => a.id !== archiveId);
    const hasContent = Object.values(cur.turns).some(
      (t) => t.content.trim().length > 0,
    );
    const worth = hasContent || cur.projectSessionId !== null;
    const nextArchive = worth
      ? [
          {
            id: cur.activeProjectId,
            name: deriveProjectName(cur.turns),
            sessionId: cur.projectSessionId,
            turns: cur.turns,
            savedAt: Date.now(),
          },
          ...remaining,
        ]
      : remaining;
    set({
      activeProjectId: target.id,
      turns: target.turns,
      projectSessionId: target.sessionId,
      archive: nextArchive,
      // Different canvas → different proposal + link sets. Resumed
      // projects don't currently carry their proposals or links; archived
      // projects predate that persistence. (Future: include both in the
      // ArchivedProject snapshot if it becomes worth carrying across.)
      proposals: [],
      links: [],
    });
    return true;
  },

  deleteArchived: (archiveId) => {
    set((s) => ({
      archive: s.archive.filter((a) => a.id !== archiveId),
    }));
  },

  renameArchived: (archiveId, name) => {
    set((s) => ({
      archive: s.archive.map((a) =>
        a.id === archiveId ? { ...a, name: name.trim() || a.name } : a,
      ),
    }));
  },

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
      partialize: (state) => ({
        activeProjectId: state.activeProjectId,
        turns: state.turns,
        projectSessionId: state.projectSessionId,
        archive: state.archive,
        proposals: state.proposals,
        links: state.links,
      }),
    },
  ),
);
