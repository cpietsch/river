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

export type MistCandidate = { label: string; full: string };

// Each agent (assumption / skeptic / expander / …) produces predictions in
// the same shape, tagged with its own id. The pill row colors itself by
// `agent`, but toggling/sending is uniform across agents.
export type AgentId = 'assumption' | 'skeptic' | 'expander';
export type AgentPrediction = { agent: AgentId; label: string; full: string };

// Backwards-compat alias — the assumption agent's output IS the old
// Presumption shape (sans the `agent` tag).
export type Presumption = { label: string; full: string };

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

export async function fetchMist(input: string, history: ChatMessage[]): Promise<MistCandidate[]> {
  try {
    const res = await fetch('/api/mist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input, history }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { candidates?: MistCandidate[] };
    return data.candidates ?? [];
  } catch {
    return [];
  }
}

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

/**
 * Streams the assistant response. `onDelta` is called for each text chunk;
 * returns the full concatenated text once the stream finishes.
 */
export async function streamGenerate(
  input: string,
  history: ChatMessage[],
  onDelta: (text: string) => void,
  signal?: AbortSignal,
  emphasized: string[] = [],
  userContext: string[] = [],
  graph: GraphSnapshot | null = null,
): Promise<string> {
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input, history, emphasized, userContext, graph }),
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
 * Streams a navigational summary of the conversation graph. The server
 * renders every card as text and asks the main model to produce a 2-paragraph
 * map; card references in the prose use `[card:shape:xxx]` syntax which the
 * client parses into clickable affordances.
 */
export async function streamSummarize(
  graph: GraphSnapshot,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch('/api/summarize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ graph }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`summarize failed ${res.status}`);

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
        } else if (parsed.type === 'error') {
          throw new Error(String(parsed.message ?? 'summarize error'));
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('summarize error')) throw err;
      }
    }
  }
  return full;
}
