export type ChatMessage = { role: 'user' | 'assistant'; content: string };

// Fire-and-forget client telemetry. Posted to /api/log where the server
// appends to ./logs/YYYY-MM-DD.jsonl alongside the server-side generate/
// agents events. `type` must start with "client." — the server enforces
// this so clients can't masquerade as server events. Errors are swallowed:
// logging never blocks UX.
export function logEvent(type: string, data: Record<string, unknown> = {}): void {
  try {
    void fetch('/api/log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type, ...data }),
    });
  } catch {
    // ignore
  }
}

// Each agent (assumption / skeptic / expander / …) produces predictions in
// the same shape, tagged with its own id. The pill row colors itself by
// `agent`, but toggling/sending is uniform across agents.
export type AgentId = 'assumption' | 'skeptic' | 'expander';
export type AgentPrediction = { agent: AgentId; label: string; full: string };

export async function fetchAgentPredictions(
  history: ChatMessage[],
  agents?: AgentId[],
): Promise<AgentPrediction[]> {
  try {
    const res = await fetch('/api/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ history, agents }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { predictions?: AgentPrediction[] };
    return data.predictions ?? [];
  } catch {
    return [];
  }
}

// A selectable span inside an assistant card's prose. The `phrase` appears
// verbatim in the text; `question` is the prompt the chip rides forward as
// when selected. Today both are computed locally by extractSpans (compromise
// NLP); in the future the question could be enriched by a Haiku call for
// richer hover tooltips.
export type ChipSpan = { phrase: string; question: string };

// Minimal snapshot of the conversation graph that the server passes through
// to custom-tool calls (get_graph_summary, get_card). Just the structural
// fields — no chip spans, no streaming flag, no agent predictions. Streaming
// turns are excluded so half-written assistant cards don't appear in the
// agent's view of the tree.
export type GraphSnapshotTurn = {
  id: string;
  role: 'user' | 'assistant';
  parentId: string | null;
  content: string;
  emphasis: number;
};
export type GraphSnapshot = { turns: Record<string, GraphSnapshotTurn> };

// Branch proposal forwarded from the server when the agent calls the
// `create_branch` custom tool. Ephemeral on the client — the UI renders it
// as a draft suggestion the user can accept (creates the branch + runs it)
// or dismiss.
export type BranchProposal = {
  proposalId: string;
  parentId: string;
  prompt: string;
  rationale: string;
};

// Card flag forwarded from the server when the agent calls the `flag_card`
// custom tool. The client applies it to the conversation store (sets
// emphasis=2 + records the reason on meta.agentFlagReason).
export type CardFlag = {
  cardId: string;
  reason: string;
};

// Card creation forwarded from the server when the agent calls the
// `create_card` custom tool. The id is generated server-side and reserved
// for this card so subsequent agent tool calls in the same stream can
// reference it. The client materializes a turn at exactly this id.
export type CardCreation = {
  id: string;
  parentId: string;
  role: 'user' | 'assistant';
  content: string;
  meta?: { label?: string };
};

// Pick-from options the agent attached to a card via the present_options
// custom tool. Rendered as tappable pills below the card's prose; tapping
// a pill submits the option as the next user turn.
export type CardOptions = {
  cardId: string;
  options: string[];
};

// In-place card rewrite forwarded from the server when the agent calls
// edit_card. The client replaces the card's content and re-derives chip
// spans against the new text.
export type CardEdit = {
  cardId: string;
  content: string;
};

// Lateral link between two cards forwarded from the server when the
// agent calls link_cards. The client materializes a Link record in the
// store; the syncer renders a dashed arrow on the canvas.
export type CardLink = {
  linkId: string;
  fromId: string;
  toId: string;
  kind: string;
};

/**
 * Streams the assistant response. `onDelta` is called for each text chunk;
 * `onSessionId` fires once with the session id (existing or newly minted)
 * before any deltas, so the caller can persist it for the next turn.
 * `onProposal` fires whenever the agent calls `create_branch`.
 * Returns the full concatenated text once the stream finishes.
 */
export async function streamGenerate(
  input: string,
  history: ChatMessage[],
  onDelta: (text: string) => void,
  opts: {
    signal?: AbortSignal;
    emphasized?: string[];
    userContext?: string[];
    graph?: GraphSnapshot | null;
    sessionId?: string | null;
    projectId?: string | null;
    pathIds?: string[];
    responseCardId?: string | null;
    onSessionId?: (id: string) => void;
    onProposal?: (p: BranchProposal) => void;
    onActivity?: (text: string) => void;
    onCardFlag?: (f: CardFlag) => void;
    onCardCreated?: (c: CardCreation) => void;
    onCardOptions?: (o: CardOptions) => void;
    onCardEdited?: (e: CardEdit) => void;
    onCardLinked?: (l: CardLink) => void;
  } = {},
): Promise<string> {
  const {
    signal,
    emphasized = [],
    userContext = [],
    graph = null,
    sessionId = null,
    projectId = null,
    pathIds = [],
    responseCardId = null,
    onSessionId,
    onProposal,
    onActivity,
    onCardFlag,
    onCardCreated,
    onCardOptions,
    onCardEdited,
    onCardLinked,
  } = opts;
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      input,
      history,
      emphasized,
      userContext,
      graph,
      sessionId,
      projectId,
      pathIds,
      responseCardId,
    }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`generate failed ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      try {
        const parsed = JSON.parse(trimmed.slice(5).trim());
        if (parsed.type === 'delta' && typeof parsed.text === 'string') {
          full += parsed.text;
          onDelta(parsed.text);
        } else if (
          parsed.type === 'activity' &&
          typeof parsed.text === 'string'
        ) {
          onActivity?.(parsed.text);
        } else if (
          parsed.type === 'session' &&
          typeof parsed.sessionId === 'string'
        ) {
          onSessionId?.(parsed.sessionId);
        } else if (
          parsed.type === 'branch_proposal' &&
          typeof parsed.proposalId === 'string' &&
          typeof parsed.parentId === 'string' &&
          typeof parsed.prompt === 'string'
        ) {
          onProposal?.({
            proposalId: parsed.proposalId,
            parentId: parsed.parentId,
            prompt: parsed.prompt,
            rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
          });
        } else if (
          parsed.type === 'card_flagged' &&
          typeof parsed.cardId === 'string' &&
          typeof parsed.reason === 'string'
        ) {
          onCardFlag?.({ cardId: parsed.cardId, reason: parsed.reason });
        } else if (
          parsed.type === 'card_created' &&
          typeof parsed.id === 'string' &&
          typeof parsed.parentId === 'string' &&
          typeof parsed.content === 'string'
        ) {
          onCardCreated?.({
            id: parsed.id,
            parentId: parsed.parentId,
            role: parsed.role === 'user' ? 'user' : 'assistant',
            content: parsed.content,
            meta: parsed.meta && typeof parsed.meta === 'object'
              ? { label: typeof parsed.meta.label === 'string' ? parsed.meta.label : undefined }
              : undefined,
          });
        } else if (
          parsed.type === 'options_presented' &&
          typeof parsed.cardId === 'string' &&
          Array.isArray(parsed.options)
        ) {
          onCardOptions?.({
            cardId: parsed.cardId,
            options: parsed.options.filter(
              (o: unknown): o is string => typeof o === 'string',
            ),
          });
        } else if (
          parsed.type === 'card_edited' &&
          typeof parsed.cardId === 'string' &&
          typeof parsed.content === 'string'
        ) {
          onCardEdited?.({
            cardId: parsed.cardId,
            content: parsed.content,
          });
        } else if (
          parsed.type === 'card_linked' &&
          typeof parsed.linkId === 'string' &&
          typeof parsed.fromId === 'string' &&
          typeof parsed.toId === 'string' &&
          typeof parsed.kind === 'string'
        ) {
          onCardLinked?.({
            linkId: parsed.linkId,
            fromId: parsed.fromId,
            toId: parsed.toId,
            kind: parsed.kind,
          });
        } else if (parsed.type === 'error') {
          throw new Error(String(parsed.message ?? 'stream error'));
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('stream error')) throw err;
      }
    }
  }
  return full;
}

/**
 * Best-effort delete of the project's Managed Agent session. Called on
 * "+ new" so the abandoned canvas's session log doesn't sit forever.
 */
export async function deleteSession(sessionId: string): Promise<void> {
  try {
    await fetch(`/api/session/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
  } catch {
    // ignore
  }
}

// ── Server-side canvas state  ─────────────────────────────────

export type ServerProject = {
  id: string;
  name: string;
  /**
   * Server-derived friendly name from the project's first user turn with
   * content. Present when `name` is the default "untitled canvas" and a
   * better label can be computed; absent otherwise. Use `derivedName ?? name`
   * for display.
   */
  derivedName?: string;
  sessionId: string | null;
  wakeIntent: string;
  createdAt: number;
  updatedAt: number;
};

export type ServerTurn = {
  id: string;
  projectId: string;
  role: 'user' | 'assistant';
  content: string;
  parentId: string | null;
  emphasis: number;
  streaming: boolean;
  meta: Record<string, unknown>;
  createdAt: number;
};

export type ServerLink = {
  id: string;
  projectId: string;
  fromId: string;
  toId: string;
  kind: string;
  createdAt: number;
};

export type ServerProposal = {
  id: string;
  projectId: string;
  parentId: string;
  prompt: string;
  rationale: string;
  createdAt: number;
};

export type ServerProjectState = {
  project: ServerProject;
  turns: ServerTurn[];
  links: ServerLink[];
  proposals: ServerProposal[];
};

/** List every project the server knows about. */
export async function fetchProjects(): Promise<ServerProject[]> {
  try {
    const res = await fetch('/api/projects');
    if (!res.ok) return [];
    const data = (await res.json()) as { projects?: ServerProject[] };
    return data.projects ?? [];
  } catch {
    return [];
  }
}

/** Full canvas state for one project. Returns null if the server hasn't
 *  heard of this project yet (e.g. fresh canvas pre-first-turn). */
export async function fetchProjectState(
  projectId: string,
): Promise<ServerProjectState | null> {
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`+'/state');
    if (res.status === 404) return null;
    if (!res.ok) return null;
    return (await res.json()) as ServerProjectState;
  } catch {
    return null;
  }
}

// ── Per-mutation client → server sync  ─────────────────────
//
// Each user-side mutation (toggleEmphasis, deleteCard, dismissProposal,
// archive operations, …) is mirrored to the server via these fire-and-
// forget POSTs. Errors are swallowed: the local zustand store is the
// optimistic source of truth; the server is the durable copy that other
// devices and the background worker  read from.

/** Upsert one turn server-side. Used after createTurn, setEmphasis,
 *  setContent (when content stops streaming), branchFrom, etc. No-op
 *  when projectId is null (active project not yet bootstrapped). */
export async function upsertTurnRemote(
  projectId: string | null,
  turn: {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    parentId: string | null;
    emphasis: number;
    streaming?: boolean;
    meta?: Record<string, unknown>;
  },
): Promise<void> {
  if (!projectId) return;
  try {
    await fetch(`/api/projects/${encodeURIComponent(projectId)}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ turn }),
    });
  } catch {
    // ignore
  }
}

/** Cascade-delete a subtree of turns. */
export async function deleteSubtreeRemote(
  projectId: string | null,
  turnId: string,
): Promise<void> {
  if (!projectId) return;
  try {
    await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/turns/${encodeURIComponent(turnId)}`,
      { method: 'DELETE' },
    );
  } catch {
    // ignore
  }
}

/** Drop a pending branch proposal server-side (after the user accepts
 *  or dismisses it). */
export async function removeProposalRemote(
  projectId: string | null,
  proposalId: string,
): Promise<void> {
  if (!projectId) return;
  try {
    await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/proposals/${encodeURIComponent(proposalId)}`,
      { method: 'DELETE' },
    );
  } catch {
    // ignore
  }
}

/** Drop a link server-side. */
export async function removeLinkRemote(
  projectId: string | null,
  linkId: string,
): Promise<void> {
  if (!projectId) return;
  try {
    await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/links/${encodeURIComponent(linkId)}`,
      { method: 'DELETE' },
    );
  } catch {
    // ignore
  }
}

/** Patch a project: rename, set/clear sessionId, set wakeIntent. */
export async function patchProjectRemote(
  projectId: string | null,
  patch: { name?: string; sessionId?: string | null; wakeIntent?: string },
): Promise<void> {
  if (!projectId) return;
  try {
    await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
  } catch {
    // ignore
  }
}

/** Trigger an autonomous turn on a project. The agent reads the canvas
 *  and contributes one useful thing if it sees something — flag, link,
 *  draft, edit — or ends silently. Mutations land via the WS broadcast
 *  channel; the caller doesn't need to consume the response shape, just
 *  watch the canvas update. */
export async function wakeProject(
  projectId: string | null,
): Promise<{ ok: boolean; content?: string; error?: string }> {
  if (!projectId) return { ok: false, error: 'no active project' };
  try {
    const res = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/wake`,
      { method: 'POST' },
    );
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    }
    const data = (await res.json()) as { content?: string };
    return { ok: true, content: data.content };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }
}

/** Cascade-delete a project (turns, links, proposals all go). */
export async function deleteProjectRemote(projectId: string | null): Promise<void> {
  if (!projectId) return;
  try {
    await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'DELETE',
    });
  } catch {
    // ignore
  }
}

// Live agent + environment metadata, shown in the projects menu footer.
export type AgentInfo = {
  agentId: string | null;
  agentVersion: number | null;
  model: string | null;
  envId: string | null;
  memoryStoreId: string | null;
};

export async function fetchInfo(): Promise<AgentInfo | null> {
  try {
    const res = await fetch('/api/info');
    if (!res.ok) return null;
    const data = await res.json();
    return {
      agentId: data.agentId ?? null,
      agentVersion: typeof data.agentVersion === 'number' ? data.agentVersion : null,
      model: data.model ?? null,
      envId: data.envId ?? null,
      memoryStoreId: data.memoryStoreId ?? null,
    };
  } catch {
    return null;
  }
}

// Card-label batch input. The client only sends cards lacking labels.
export type LabelCard = { id: string; role: 'user' | 'assistant'; content: string };

/**
 * Batch-label cards. Single Haiku round-trip; the server returns a
 * `{id: label}` map. Used by the map menu's tree view to render a
 * scannable summary of every card.
 */
export async function fetchLabels(
  cards: LabelCard[],
): Promise<Record<string, string>> {
  if (cards.length === 0) return {};
  try {
    const res = await fetch('/api/labels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cards }),
    });
    if (!res.ok) return {};
    const data = (await res.json()) as { labels?: Record<string, string> };
    return data.labels ?? {};
  } catch {
    return {};
  }
}

