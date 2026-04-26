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
    pathIds?: string[];
    responseCardId?: string | null;
    onSessionId?: (id: string) => void;
    onProposal?: (p: BranchProposal) => void;
    onActivity?: (text: string) => void;
    onCardFlag?: (f: CardFlag) => void;
    onCardCreated?: (c: CardCreation) => void;
  } = {},
): Promise<string> {
  const {
    signal,
    emphasized = [],
    userContext = [],
    graph = null,
    sessionId = null,
    pathIds = [],
    responseCardId = null,
    onSessionId,
    onProposal,
    onActivity,
    onCardFlag,
    onCardCreated,
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

/**
 * Inspect the agent's persistent memory store. Returns a `{path: content}`
 * map of every file the agent has written under `/mnt/memory/`. Slow —
 * the server spins up a throwaway session to read the store, so expect
 * 5-15 seconds. Empty `files` object means the agent hasn't written
 * anything yet (or memory isn't configured).
 */
export async function fetchMemory(): Promise<{
  files: Record<string, string>;
  configured: boolean;
}> {
  try {
    const res = await fetch('/api/memory');
    if (!res.ok) return { files: {}, configured: false };
    const data = (await res.json()) as {
      files?: Record<string, string>;
      configured?: boolean;
    };
    return {
      files: data.files ?? {},
      configured: data.configured ?? false,
    };
  } catch {
    return { files: {}, configured: false };
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

