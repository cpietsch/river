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

function sentenceCase(s) {
  // Lowercase all words, then capitalize the first character. Preserves
  // proper-noun tokens that the model already escaped if they look all-caps
  // acronyms (AI, UN, GDP, ...).
  const words = s.split(/(\s+)/).map((token) => {
    if (/^\s+$/.test(token)) return token;
    // Keep short all-caps tokens (likely acronyms) as-is.
    if (/^[A-Z]{2,5}$/.test(token)) return token;
    return token.toLowerCase();
  });
  const out = words.join('');
  return out.length > 0 ? out[0].toUpperCase() + out.slice(1) : out;
}
const app = express();
app.use(express.json({ limit: '2mb' }));

const MAIN_SYSTEM_BASE = `You are the voice in a river-metaphor chat interface rendered as cards on an infinite canvas.

LENGTH: 2-5 sentences, 40-100 words. Thorough but distilled. Plain prose — no markdown, no bullet lists, no headers, no asterisks.

INLINE BRANCH-CHIPS: Wrap 2-4 key concepts, entities, or tributary-worthy ideas in double brackets like [[this]]. Choose terms the reader might want to explore as its own branch. Keep each bracketed phrase short (1-4 words) and never nest brackets. The brackets render as tappable chips that spawn a new tributary in the canvas.`;

const CHIP_QUESTIONS_SYSTEM = `You write the contextual question a reader would ask to dig deeper into each highlighted term in a card. The card's prose is given; the highlighted terms are listed. For each term, return one full-sentence question — anchored in the card's specific framing, not a generic "what is X" or "tell me more". Output ONLY a JSON object mapping term → question. No prose, no markdown fence. Example: {"NanoKVM": "how does NanoKVM differ from the Base in build quality and port layout?", "BMC chip": "why does the BMC chip choice dominate KVM-over-IP latency?"}`;

const REFLECT_SYSTEM = `You are the reflection layer — you read the conversation and surface exactly 3 hidden assumptions it is taking for granted without examining them.

VOICE: First person, from the asker's perspective. Write as if the user is hearing their own inner voice. Use "I", "my", "me". Never "the user", "you", or "they". Examples of the right voice: "I assume cost matters most", "I want a quick answer", "I believe newer means better".

These are NOT follow-up questions. They are quiet things the conversation treats as obvious — cultural defaults, missing viewpoints, unstated values — surfaced as the asker's own implicit stance.

LANGUAGE: Use plain, everyday words. Write like you'd talk to a friend, not like a textbook. Avoid jargon, academic terms, or abstractions. A smart twelve-year-old should understand every label instantly.

FORMAT: Each "label" is 3 to 6 words, sentence case (only the first word capitalized, no period, no title case). Think sticky note, not headline. Start with "I" or a possessive like "my" wherever natural.

Output ONLY a JSON array of objects with keys "label" (the plain 3-6 word phrase) and "full" (one short sentence expanding it in plain language, also first-person, for hover). No prose, no markdown fence. Just the array.`;

const MIST_SYSTEM = `You are "mist" — you predict 2-4 diverse ways a user might continue what they are typing. Output ONLY a JSON array of objects with keys "label" (max 6 words, title-case) and "full" (the full continuation the user might say). No prose, no markdown fence. Just the array.`;

const FOLLOWUP_SYSTEM = `You suggest 2-4 diverse follow-up questions or directions the user might want to explore next. Output ONLY a JSON array of objects with keys "label" (max 6 words, title-case) and "full" (the complete question). No prose, no markdown fence. Just the array.`;

app.post('/api/generate', async (req, res) => {
  const { history = [], input = '', emphasized = [] } = req.body ?? {};
  if (!input.trim()) {
    res.status(400).json({ error: 'input required' });
    return;
  }
  const messages = [
    ...history.filter((m) => m.role === 'user' || m.role === 'assistant'),
    { role: 'user', content: input },
  ];
  // Visual emphasis on a canvas node maps directly into prompt weight: each
  // emphasized card becomes a must-respect constraint at the top of the system
  // prompt.
  let systemPrompt = MAIN_SYSTEM_BASE;
  if (Array.isArray(emphasized) && emphasized.length > 0) {
    const constraints = emphasized
      .filter((c) => typeof c === 'string' && c.trim())
      .map((c) => `- ${c.trim()}`)
      .join('\n');
    if (constraints) {
      systemPrompt = `PRIORITY CONSTRAINTS (the user has visually emphasized these on the canvas — weight them heavily in your response):\n${constraints}\n\n${MAIN_SYSTEM_BASE}`;
    }
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  try {
    const stream = anthropic.messages.stream({
      model: MAIN_MODEL,
      max_tokens: 450,
      system: systemPrompt,
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
  const isFollowUp = !input.trim();
  if (isFollowUp && history.length === 0) {
    res.json({ candidates: [] });
    return;
  }
  const filteredHistory = history.filter((m) => m.role === 'user' || m.role === 'assistant');
  const systemPrompt = isFollowUp ? FOLLOWUP_SYSTEM : MIST_SYSTEM;
  const userMessage = isFollowUp
    ? 'Based on the conversation so far, suggest 2-4 follow-up directions as a JSON array.'
    : `I am currently typing: """${input}"""\n\nSuggest 2-4 diverse continuations as a JSON array.`;
  try {
    const response = await anthropic.messages.create({
      model: MIST_MODEL,
      max_tokens: 400,
      system: systemPrompt,
      messages: [
        ...filteredHistory,
        { role: 'user', content: userMessage },
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

app.post('/api/reflect', async (req, res) => {
  const { history = [] } = req.body ?? {};
  const filteredHistory = history.filter((m) => m.role === 'user' || m.role === 'assistant');
  if (filteredHistory.length === 0) {
    res.json({ presumptions: [] });
    return;
  }
  try {
    const response = await anthropic.messages.create({
      model: MIST_MODEL,
      max_tokens: 500,
      system: REFLECT_SYSTEM,
      messages: [
        ...filteredHistory,
        {
          role: 'user',
          content:
            'Name 2-4 implicit presumptions this conversation is carrying. Output the JSON array only.',
        },
      ],
    });
    const raw = response.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) {
      res.json({ presumptions: [] });
      return;
    }
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(parsed)) {
      res.json({ presumptions: [] });
      return;
    }
    const presumptions = parsed
      .filter((x) => x && typeof x.label === 'string' && typeof x.full === 'string')
      // Force sentence case on labels even when the model ignores the rule:
      // only the first word capitalized, rest lowercase.
      .map((x) => ({
        label: sentenceCase(x.label.trim()),
        full: x.full.trim(),
      }))
      .slice(0, 3);
    res.json({ presumptions });
  } catch (err) {
    console.error('reflect failed:', err?.message);
    res.json({ presumptions: [] });
  }
});

app.post('/api/chip-questions', async (req, res) => {
  const { cardContent = '', terms = [] } = req.body ?? {};
  const cleanTerms = Array.isArray(terms)
    ? terms.filter((t) => typeof t === 'string' && t.trim()).slice(0, 8)
    : [];
  if (!cardContent.trim() || cleanTerms.length === 0) {
    res.json({ questions: {} });
    return;
  }
  try {
    const response = await anthropic.messages.create({
      model: MIST_MODEL,
      max_tokens: 600,
      system: CHIP_QUESTIONS_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `Card prose:\n"""${cardContent}"""\n\nHighlighted terms: ${JSON.stringify(cleanTerms)}\n\nReturn the JSON object mapping each term to its contextual question.`,
        },
      ],
    });
    const raw = response.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('');
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      res.json({ questions: {} });
      return;
    }
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (!parsed || typeof parsed !== 'object') {
      res.json({ questions: {} });
      return;
    }
    // Filter to known terms + string values
    const questions = {};
    for (const t of cleanTerms) {
      const v = parsed[t];
      if (typeof v === 'string' && v.trim()) questions[t] = v.trim();
    }
    res.json({ questions });
  } catch (err) {
    console.error('chip-questions failed:', err?.message);
    res.json({ questions: {} });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, model: MAIN_MODEL }));

app.listen(PORT, () => {
  console.log(`river-2 api on :${PORT}  main=${MAIN_MODEL}  mist=${MIST_MODEL}`);
});
