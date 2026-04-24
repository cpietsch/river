import 'dotenv/config';
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';

const PORT = Number(process.env.PORT ?? 4000);
const MAIN_MODEL = process.env.MAIN_MODEL ?? 'claude-sonnet-4-6';
const MIST_MODEL = process.env.MIST_MODEL ?? 'claude-haiku-4-5-20251001';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('ANTHROPIC_API_KEY missing in .env');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey });
const app = express();
app.use(express.json({ limit: '2mb' }));

const MAIN_SYSTEM = `You are the voice in a river-metaphor chat interface rendered as cards on an infinite canvas. HARD CONSTRAINT: ONE short sentence, under 20 words. No markdown, no lists, no asterisks, no headers. Plain prose only. If the user wants depth they will ask a follow-up.`;

const MIST_SYSTEM = `You are "mist" — you predict 2-4 diverse ways a user might continue what they are typing. Output ONLY a JSON array of objects with keys "label" (max 6 words, title-case) and "full" (the full continuation the user might say). No prose, no markdown fence. Just the array.`;

app.post('/api/generate', async (req, res) => {
  const { history = [], input = '' } = req.body ?? {};
  if (!input.trim()) {
    res.status(400).json({ error: 'input required' });
    return;
  }
  const messages = [
    ...history.filter((m) => m.role === 'user' || m.role === 'assistant'),
    { role: 'user', content: input },
  ];
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  try {
    const stream = anthropic.messages.stream({
      model: MAIN_MODEL,
      max_tokens: 180,
      system: MAIN_SYSTEM,
      messages,
    });
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        res.write(`data: ${JSON.stringify({ type: 'delta', text: event.delta.text })}\n\n`);
      }
    }
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: String(err?.message ?? err) })}\n\n`);
  } finally {
    res.end();
  }
});

app.post('/api/mist', async (req, res) => {
  const { history = [], input = '' } = req.body ?? {};
  if (!input.trim()) {
    res.json({ candidates: [] });
    return;
  }
  try {
    const response = await anthropic.messages.create({
      model: MIST_MODEL,
      max_tokens: 400,
      system: MIST_SYSTEM,
      messages: [
        ...history.filter((m) => m.role === 'user' || m.role === 'assistant'),
        {
          role: 'user',
          content: `I am currently typing: """${input}"""\n\nSuggest 2-4 diverse continuations as a JSON array.`,
        },
      ],
    });
    const raw = response.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) {
      res.json({ candidates: [] });
      return;
    }
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(parsed)) {
      res.json({ candidates: [] });
      return;
    }
    const candidates = parsed
      .filter((x) => x && typeof x.label === 'string' && typeof x.full === 'string')
      .slice(0, 4);
    res.json({ candidates });
  } catch (err) {
    console.error('mist failed:', err?.message);
    res.json({ candidates: [] });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, model: MAIN_MODEL }));

app.listen(PORT, () => {
  console.log(`river-2 api on :${PORT}  main=${MAIN_MODEL}  mist=${MIST_MODEL}`);
});
