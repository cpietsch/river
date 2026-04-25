export type ChatMessage = { role: 'user' | 'assistant'; content: string };

export type MistCandidate = { label: string; full: string };

// Each agent (assumption / skeptic / expander / …) produces predictions in
// the same shape, tagged with its own id. The pill row colors itself by
// `agent`, but toggling/sending is uniform across agents. `chip` is a
// pseudo-agent: chip clicks inside assistant text pin themselves to the
// input as pills, sharing the same toggle pipeline.
export type AgentId = 'assumption' | 'skeptic' | 'expander' | 'chip';
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

export async function fetchChipQuestions(
  cardContent: string,
  terms: string[],
): Promise<Record<string, string>> {
  if (!terms.length) return {};
  try {
    const res = await fetch('/api/chip-questions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cardContent, terms }),
    });
    if (!res.ok) return {};
    const data = (await res.json()) as { questions?: Record<string, string> };
    return data.questions ?? {};
  } catch {
    return {};
  }
}

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
): Promise<string> {
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input, history, emphasized, userContext }),
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
