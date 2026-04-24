export type ChatMessage = { role: 'user' | 'assistant'; content: string };

export type MistCandidate = { label: string; full: string };

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
): Promise<string> {
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input, history }),
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
