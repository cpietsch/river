import 'dotenv/config';
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';

// Structured JSONL logging — one file per UTC day under ./logs/. Used to
// analyze sessions after the fact (which agents fire, how often the brain
// reaches for tools, average response length, branching patterns, errors).
// Each line is a self-describing JSON object: {ts, type, ...data}.
const LOG_DIR = path.resolve(process.cwd(), 'logs');
function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}
function logEvent(type, data = {}) {
  try {
    ensureLogDir();
    const ts = new Date().toISOString();
    const date = ts.slice(0, 10);
    const file = path.join(LOG_DIR, `${date}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ ts, type, ...data }) + '\n');
  } catch (err) {
    console.error('log failed:', err?.message);
  }
}

const PORT = Number(process.env.PORT ?? 4000);
const MAIN_MODEL = process.env.MAIN_MODEL ?? 'claude-sonnet-4-6';
const MIST_MODEL = process.env.MIST_MODEL ?? 'claude-haiku-4-5-20251001';
// Managed Agent IDs created by scripts/setup-agent.js. The brain (the main
// /api/generate response) runs as a Managed Agent session referencing these;
// the Haiku-based pill agents (assumption/skeptic/expander) stay on plain
// Messages API since they're stateless one-shot calls.
const AGENT_ID = process.env.AGENT_ID;
const ENV_ID = process.env.ENV_ID;
// Workspace-scoped memory the agent reads/writes across sessions. Mounted
// into the container at /mnt/memory/river-2-memory/ — the agent uses the
// regular file tools (read/write/edit/glob) to interact.
const MEMORY_STORE_ID = process.env.MEMORY_STORE_ID;

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('ANTHROPIC_API_KEY missing in .env');
  process.exit(1);
}
if (!AGENT_ID || !ENV_ID) {
  console.warn(
    '! AGENT_ID/ENV_ID missing — /api/generate will fail. Run `npm run setup-agent` to create them.',
  );
}
if (!MEMORY_STORE_ID) {
  console.warn(
    '! MEMORY_STORE_ID missing — sessions will run without persistent memory. Run `npm run setup-agent` to provision one.',
  );
}

const anthropic = new Anthropic({ apiKey });

function sentenceCase(s) {
  // Lowercase all words, then capitalize the first character. Preserves
  // proper-noun tokens that the model already escaped if they look all-caps
  // acronyms (AI, UN, GDP, ...) and the standalone first-person pronoun "I"
  // and its contractions (I'm, I've, I'll, I'd) so first-person voice reads
  // correctly.
  const I_RX = /^I('m|'ve|'ll|'d|'s)?$/i;
  const words = s.split(/(\s+)/).map((token) => {
    if (/^\s+$/.test(token)) return token;
    if (/^[A-Z]{2,5}$/.test(token)) return token;
    if (I_RX.test(token)) {
      // Normalize to "I" or "I'm" / "I've" / etc.
      const m = token.match(I_RX);
      const suffix = m && m[1] ? m[1].toLowerCase() : '';
      return 'I' + suffix;
    }
    return token.toLowerCase();
  });
  const out = words.join('');
  return out.length > 0 ? out[0].toUpperCase() + out.slice(1) : out;
}
const app = express();
app.use(express.json({ limit: '2mb' }));

const MAIN_SYSTEM_BASE = `You are the voice in a river-metaphor chat interface rendered as cards on an infinite canvas.

LENGTH: 3-6 sentences, 60-140 words. Thorough but distilled.

PARAGRAPH BREAKS: when your response covers two distinct ideas or a clear shift in topic (overview → detail, claim → caveat, what → why), separate them with a blank line (a literal \\n\\n). Most responses split cleanly into two short paragraphs. Don't split for the sake of splitting — single-idea responses stay one paragraph.

FORMATTING: prose with light emphasis only.
- **bold** for the most important phrase or two per response (a key term, a critical claim).
- *italic* for nuance, scare quotes, or named titles.
- Markdown tables ONLY when the answer is genuinely comparing 2+ items across 2+ attributes (specs, tradeoffs). Format: \`| col | col |\\n|---|---|\\n| a | b |\`. Keep tables small (≤4 columns, ≤6 rows). Use prose otherwise.
- NO bullet lists, NO headers, NO code fences, NO links.

Use formatting sparingly — most sentences should be plain prose.`;

// Each agent reads the conversation and produces a few "next-move" pills the
// user can toggle on. They share a voice (first-person, plain words, sticky-
// note labels) but bite at the conversation from different angles. Run in
// parallel server-side; results merge into a single AgentPrediction[].
const AGENT_SHARED_VOICE = `VOICE: first person, from the asker's perspective — write as if the user is hearing their own inner voice. Use "I", "my", "me"; never "the user", "you", or "they".

LANGUAGE: plain everyday words. Like talking to a friend, not a textbook. A smart twelve-year-old should understand every label instantly.

FORMAT: each "label" is 3 to 6 words, sentence case (only the first word capitalized, no period, no title case). Think sticky note, not headline. Start with "I" or "my" wherever natural.

Output ONLY a JSON array of objects with keys "label" and "full" (one short sentence expanding the label, also first-person, for hover). No prose, no markdown fence. Just the array.`;

const AGENTS = {
  assumption: {
    system: `You are the ASSUMPTION agent. Surface 2 implicit assumptions the conversation is taking for granted without examining them — quiet defaults, unstated values, scope or identity assumptions. NOT follow-up questions, NOT challenges. Pure framing the user is carrying.

Examples of the right slant: "I assume cost matters most", "I want a quick answer", "I believe newer means better".

${AGENT_SHARED_VOICE}`,
    userPrompt: 'Name 2 distinct implicit assumptions this conversation is carrying. Output the JSON array only.',
  },
  skeptic: {
    system: `You are the SKEPTIC agent. Surface 2 blind spots, counterpoints, or self-doubts the conversation hasn't faced. NOT generic challenges — pull on what was actually just said. Phrased as the user's own pushback at themselves.

Examples of the right slant: "I'm overlooking maintenance cost", "I haven't asked about durability", "What if I'm wrong about scale?".

${AGENT_SHARED_VOICE}`,
    userPrompt: 'Name 2 distinct blind spots or counterpoints this conversation has missed. Output the JSON array only.',
  },
  expander: {
    system: `You are the EXPANDER agent. Surface 2 directions the conversation could go deeper. Phrased as the user's own curiosity — what they'd want to dig into next.

Examples of the right slant: "I wonder how this scales", "What if I push further on speed?", "I want to understand the tradeoffs".

${AGENT_SHARED_VOICE}`,
    userPrompt: 'Name 2 distinct directions to go deeper from here. Output the JSON array only.',
  },
};

const MIST_SYSTEM = `You are "mist" — you predict 2-4 diverse ways a user might continue what they are typing. Output ONLY a JSON array of objects with keys "label" (max 6 words, title-case) and "full" (the full continuation the user might say). No prose, no markdown fence. Just the array.`;

const FOLLOWUP_SYSTEM = `You suggest 2-4 diverse follow-up questions or directions the user might want to explore next. Output ONLY a JSON array of objects with keys "label" (max 6 words, title-case) and "full" (the complete question). No prose, no markdown fence. Just the array.`;

/**
 * Build the kickoff user-message body that the Managed Agent session sees.
 * The conversation is a tree client-side, so we don't keep a long-lived
 * session per branch — instead, each turn opens a fresh session and embeds
 * the priors as text in one user.message: priority constraints, carried
 * assumptions, prior turns, then the current question.
 */
function buildKickoffMessage(history, input, emphasized, userContext) {
  const parts = [];
  const constraints = (Array.isArray(emphasized) ? emphasized : [])
    .filter((c) => typeof c === 'string' && c.trim())
    .map((c) => `- ${c.trim()}`)
    .join('\n');
  if (constraints) {
    parts.push(
      `PRIORITY CONSTRAINTS (the user emphasized these on the canvas — weight them heavily):\n${constraints}`,
    );
  }
  const ctx = (Array.isArray(userContext) ? userContext : [])
    .filter((c) => typeof c === 'string' && c.trim())
    .map((c) => `- ${c.trim()}`)
    .join('\n');
  if (ctx) {
    parts.push(
      `IMPLICIT ASSUMPTIONS the user is carrying (tapped pills — engage with these explicitly: examine, challenge, or accommodate, don't just restate):\n${ctx}`,
    );
  }
  const priors = (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim());
  if (priors.length) {
    const rendered = priors
      .map((m) => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${m.content.trim()}`)
      .join('\n\n');
    parts.push(`CONVERSATION SO FAR:\n${rendered}`);
  }
  parts.push(`CURRENT MESSAGE:\nUSER: ${input.trim()}`);
  return parts.join('\n\n---\n\n');
}

/**
 * Resolve a custom tool call from the agent against the conversation graph
 * snapshot the client sent with this request. Returns a JSON-stringified
 * result for the user.custom_tool_result event.
 */
function resolveGraphTool(name, input, graph) {
  const turns = graph?.turns ?? {};
  if (name === 'get_graph_summary') {
    const summary = Object.values(turns).map((t) => ({
      id: t.id,
      role: t.role,
      parentId: t.parentId ?? null,
      preview: (t.content ?? '').slice(0, 240),
      emphasis: t.emphasis ?? 1,
    }));
    return JSON.stringify({ turns: summary });
  }
  if (name === 'get_card') {
    const id = input?.card_id;
    const turn = id ? turns[id] : null;
    if (!turn) {
      return JSON.stringify({
        error: `No card with id ${id ?? '(missing)'}`,
      });
    }
    return JSON.stringify({
      id: turn.id,
      role: turn.role,
      parentId: turn.parentId ?? null,
      content: turn.content ?? '',
      emphasis: turn.emphasis ?? 1,
    });
  }
  return JSON.stringify({ error: `Unknown tool: ${name}` });
}

app.post('/api/generate', async (req, res) => {
  const {
    history = [],
    input = '',
    emphasized = [],
    userContext = [],
    graph = null,
  } = req.body ?? {};
  if (!input.trim()) {
    res.status(400).json({ error: 'input required' });
    return;
  }
  if (!AGENT_ID || !ENV_ID) {
    res.status(500).json({ error: 'agent not configured — run `npm run setup-agent`' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const text = buildKickoffMessage(history, input, emphasized, userContext);
  const startedAt = Date.now();
  logEvent('generate.start', {
    inputLen: input.length,
    historyLen: history.length,
    emphasizedCount: Array.isArray(emphasized) ? emphasized.length : 0,
    userContextCount: Array.isArray(userContext) ? userContext.length : 0,
    graphSize: graph?.turns ? Object.keys(graph.turns).length : 0,
  });

  let session;
  let sessionId = null;
  let totalChars = 0;
  let toolUses = 0;
  let customToolUses = 0;
  try {
    const sessionParams = {
      agent: AGENT_ID,
      environment_id: ENV_ID,
      title: input.trim().slice(0, 60),
    };
    if (MEMORY_STORE_ID) {
      sessionParams.resources = [
        {
          type: 'memory_store',
          memory_store_id: MEMORY_STORE_ID,
          access: 'read_write',
          instructions:
            'Long-term memory across all river-2 conversations. Read first; write durably useful learnings (preferences, recurring topics). Skip one-off chatter.',
        },
      ];
    }
    session = await anthropic.beta.sessions.create(sessionParams);
    sessionId = session.id;
    logEvent('generate.session_created', { sessionId });

    // Stream-first: open the SSE stream BEFORE sending the kickoff so we
    // don't miss early events. (See `shared/managed-agents-events.md` →
    // Stream-first ordering — the stream only delivers events emitted
    // after it opens.)
    const streamPromise = anthropic.beta.sessions.events.stream(session.id);
    await anthropic.beta.sessions.events.send(session.id, {
      events: [
        {
          type: 'user.message',
          content: [{ type: 'text', text }],
        },
      ],
    });
    const stream = await streamPromise;

    // Track which agent.message blocks we've already emitted so re-emitted
    // event versions (e.g. queued → processed) don't duplicate text.
    let lastEmitted = '';
    for await (const event of stream) {
      // Forward agent text. agent.message events carry full content arrays;
      // we emit the concatenated text as one delta per event.
      if (event.type === 'agent.message' && Array.isArray(event.content)) {
        const chunk = event.content
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('');
        if (chunk && chunk !== lastEmitted) {
          res.write(`data: ${JSON.stringify({ type: 'delta', text: chunk })}\n\n`);
          lastEmitted = chunk;
          totalChars = chunk.length;
        }
      }
      // Built-in tool use (web_search, web_fetch, bash, file ops...)
      if (event.type === 'agent.tool_use') {
        toolUses += 1;
        logEvent('generate.tool_use', {
          sessionId,
          tool: event.name,
        });
      }
      // Custom tool calls — resolve them locally against the graph snapshot
      // the client sent and reply with user.custom_tool_result. The session
      // goes idle (requires_action) until we send the result, then resumes.
      if (event.type === 'agent.custom_tool_use') {
        customToolUses += 1;
        logEvent('generate.custom_tool_use', {
          sessionId,
          tool: event.name,
          input: event.input ?? null,
        });
        const result = resolveGraphTool(event.name, event.input, graph);
        try {
          await anthropic.beta.sessions.events.send(session.id, {
            events: [
              {
                type: 'user.custom_tool_result',
                custom_tool_use_id: event.id,
                content: [{ type: 'text', text: result }],
              },
            ],
          });
        } catch (err) {
          console.error('failed to send custom_tool_result:', err?.message);
        }
        continue;
      }
      // Terminal break: idle with a non-action stop_reason, or terminated.
      // requires_action means the agent is awaiting our custom_tool_result —
      // skip the break, we just sent it (or are about to).
      if (event.type === 'session.status_terminated') break;
      if (
        event.type === 'session.status_idle' &&
        event.stop_reason?.type !== 'requires_action'
      ) {
        break;
      }
      if (event.type === 'session.error') {
        logEvent('generate.error', {
          sessionId,
          message: event.error?.message ?? 'session error',
        });
        res.write(
          `data: ${JSON.stringify({
            type: 'error',
            message: event.error?.message ?? 'session error',
          })}\n\n`,
        );
        break;
      }
    }
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    logEvent('generate.end', {
      sessionId,
      durationMs: Date.now() - startedAt,
      responseChars: totalChars,
      toolUses,
      customToolUses,
    });
  } catch (err) {
    logEvent('generate.error', {
      sessionId,
      durationMs: Date.now() - startedAt,
      message: String(err?.message ?? err),
    });
    res.write(
      `data: ${JSON.stringify({ type: 'error', message: String(err?.message ?? err) })}\n\n`,
    );
  } finally {
    res.end();
    // Best-effort cleanup. The post-idle status-write race (see
    // `shared/managed-agents-client-patterns.md` Pattern 6) means delete
    // can occasionally 400 if the session is still running — swallow that;
    // sessions auto-archive eventually.
    if (session) {
      try {
        await anthropic.beta.sessions.delete(session.id);
      } catch (_) {
        // ignore
      }
    }
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

async function runOneAgent(agentId, filteredHistory) {
  const agent = AGENTS[agentId];
  if (!agent) return [];
  try {
    const response = await anthropic.messages.create({
      model: MIST_MODEL,
      max_tokens: 400,
      system: agent.system,
      messages: [
        ...filteredHistory,
        { role: 'user', content: agent.userPrompt },
      ],
    });
    const raw = response.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('');
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) return [];
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x) => x && typeof x.label === 'string' && typeof x.full === 'string')
      .map((x) => ({
        agent: agentId,
        label: sentenceCase(x.label.trim()),
        full: x.full.trim(),
      }))
      .slice(0, 3);
  } catch (err) {
    console.error(`agent ${agentId} failed:`, err?.message);
    return [];
  }
}

app.post('/api/agents', async (req, res) => {
  const { history = [], agents } = req.body ?? {};
  const filteredHistory = history.filter(
    (m) => m.role === 'user' || m.role === 'assistant',
  );
  if (filteredHistory.length === 0) {
    res.json({ predictions: [] });
    return;
  }
  // Default: run all registered agents in parallel.
  const agentIds = Array.isArray(agents) && agents.length > 0
    ? agents.filter((a) => typeof a === 'string' && AGENTS[a])
    : Object.keys(AGENTS);
  const startedAt = Date.now();
  try {
    const results = await Promise.all(
      agentIds.map((id) => runOneAgent(id, filteredHistory)),
    );
    const flat = results.flat();
    logEvent('agents.complete', {
      durationMs: Date.now() - startedAt,
      historyLen: filteredHistory.length,
      predictionsByAgent: agentIds.reduce((acc, id, i) => {
        acc[id] = results[i].length;
        return acc;
      }, {}),
      total: flat.length,
    });
    res.json({ predictions: flat });
  } catch (err) {
    logEvent('agents.error', {
      durationMs: Date.now() - startedAt,
      message: String(err?.message ?? err),
    });
    console.error('agents failed:', err?.message);
    res.json({ predictions: [] });
  }
});

// Client-side event logging. The browser hits this with `client.*` events
// (chip toggles, sends, branches, deletes...) so the same JSONL file
// captures the full session trace alongside the server-side generate/agents
// events. Type prefix is enforced — clients can't masquerade as server.
app.post('/api/log', (req, res) => {
  const { type, ...rest } = req.body ?? {};
  if (typeof type !== 'string' || !type.startsWith('client.')) {
    res.status(400).json({ error: 'type must start with "client."' });
    return;
  }
  logEvent(type, rest);
  res.json({ ok: true });
});

app.get('/api/health', (_req, res) => res.json({ ok: true, model: MAIN_MODEL }));

app.listen(PORT, () => {
  console.log(`river-2 api on :${PORT}  main=${MAIN_MODEL}  mist=${MIST_MODEL}`);
});
 
