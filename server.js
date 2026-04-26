import 'dotenv/config';
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import yaml from 'yaml';
import { WebSocketServer } from 'ws';
import * as db from './db.js';

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
// into the container at /mnt/memory/river-memory/ — the agent uses the
// regular file tools (read/write/edit/glob) to interact.
const MEMORY_STORE_ID = process.env.MEMORY_STORE_ID;

// Per-project agent template — same YAML scripts/agent.yml that
// `npm run setup-agent` applies. We read it once at server start and
// re-use the parsed config when provisioning agents per-project on
// project creation.
const AGENT_YAML_PATH = path.resolve(process.cwd(), 'scripts/agent.yml');
let AGENT_TEMPLATE = null;
try {
  AGENT_TEMPLATE = yaml.parse(fs.readFileSync(AGENT_YAML_PATH, 'utf8'));
} catch (err) {
  console.warn(`! could not load ${AGENT_YAML_PATH}:`, err?.message);
}

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

const LABELS_SYSTEM = `You produce ultra-short classification tags for cards in a chat-as-graph UI. Each card is one user message or one assistant response. The tag floats above the card as an annotation — like a cartographer naming the region of a map.

Rules:
- 1-3 words per tag — closer to a topic name than a sentence
- Lowercase, no period, no punctuation other than necessary
- Name what the card is ABOUT, not what it says: "threat model", "option list", "hardware spec", "edit request", "synthesis", "rebuttal"
- For user cards: name the topic or the move ("comparison ask", "refinement", "follow-up question")
- For assistant cards: name the kind of output ("framing", "tradeoff analysis", "draft", "side note")
- No quotes, no emojis, no markdown
- Plain text only — these render as small typeset labels above each card

Output ONLY a JSON object whose keys are the card ids and values are the tags. No prose, no fence.`;

function renderConstraintsAndContext(emphasized, userContext) {
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
  return parts;
}

function renderBranchPath(pathIds) {
  const ids = (Array.isArray(pathIds) ? pathIds : []).filter(
    (id) => typeof id === 'string' && id.trim(),
  );
  if (!ids.length) return null;
  const chain = ids
    .map((id, i) => (i === ids.length - 1 ? `${id} (current)` : id))
    .join(' → ');
  // Header naming the chain so the agent has card ids ready (avoids a
  // round-trip via get_graph_summary just to find a valid parent_id for
  // create_branch).
  return `BRANCH PATH (root → leaf, real card ids you can pass to create_branch):\n${chain}`;
}

function renderResponseCard(responseCardId) {
  if (!responseCardId || typeof responseCardId !== 'string') return null;
  return `YOUR RESPONSE CARD: ${responseCardId} (this is the card your prose is streaming into; pass it as parent_id to create_card to put new cards beneath your response)`;
}

/**
 * Full kickoff for a *fresh* session: priors must be embedded as text since
 * the session has no event history yet. Used on the first turn of a canvas
 * (or after the session is lost / re-minted). Includes BRANCH PATH so the
 * agent has card ids available without calling get_graph_summary first.
 */
function buildFullKickoff(history, input, emphasized, userContext, pathIds, responseCardId) {
  const parts = [];
  const branchPath = renderBranchPath(pathIds);
  if (branchPath) parts.push(branchPath);
  const respCard = renderResponseCard(responseCardId);
  if (respCard) parts.push(respCard);
  parts.push(...renderConstraintsAndContext(emphasized, userContext));
  const priors = (Array.isArray(history) ? history : []).filter(
    (m) =>
      m &&
      (m.role === 'user' || m.role === 'assistant') &&
      typeof m.content === 'string' &&
      m.content.trim(),
  );
  if (priors.length) {
    const rendered = priors
      .map(
        (m) =>
          `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${m.content.trim()}`,
      )
      .join('\n\n');
    parts.push(`CONVERSATION SO FAR:\n${rendered}`);
  }
  parts.push(`CURRENT MESSAGE:\nUSER: ${input.trim()}`);
  return parts.join('\n\n---\n\n');
}

/**
 * Skinny kickoff for a *reused* session. The session's event log already
 * contains all prior user.message + agent.message events, so we don't
 * re-embed the conversation text — that doubles every turn into the
 * session's context and grows quadratically. Instead we send just enough
 * for the agent to (a) know which branch is active and (b) honor any
 * priority constraints / chip context that arrived this turn.
 */
function buildSkinnyKickoff(pathIds, input, emphasized, userContext, responseCardId) {
  const parts = [];
  const branchPath = renderBranchPath(pathIds);
  if (branchPath) parts.push(branchPath);
  const respCard = renderResponseCard(responseCardId);
  if (respCard) parts.push(respCard);
  parts.push(...renderConstraintsAndContext(emphasized, userContext));
  parts.push(`USER: ${input.trim()}`);
  return parts.join('\n\n---\n\n');
}

/**
 * Resolve a custom tool call from the agent against the conversation graph
 * snapshot the client sent with this request. Returns a JSON-stringified
 * result for the user.custom_tool_result event.
 */
// Plain-language description of a tool call, shown to the user in the
// streaming card so the wait feels purposeful. Trim long inputs so a
// pasted URL or shell command doesn't blow out the layout.
// Generate a tldraw-compatible shape id. Same shape as createShapeId() —
// "shape:" + a random alphanumeric body. Used server-side when the agent
// calls create_card: we generate the id, tell the client to materialize a
// turn with that id, and return it to the agent so it can chain.
function makeShapeId() {
  const a = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let body = '';
  for (let i = 0; i < 21; i++) body += a[Math.floor(Math.random() * a.length)];
  return `shape:${body}`;
}

function makeLinkId() {
  const a = '0123456789abcdefghijklmnopqrstuvwxyz';
  let body = '';
  for (let i = 0; i < 12; i++) body += a[Math.floor(Math.random() * a.length)];
  return `link_${body}`;
}

function describeTool(name, input) {
  const trim = (s, n = 70) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  };
  switch (name) {
    case 'web_search': {
      const q = trim(input?.query);
      return q ? `searching the web · "${q}"` : 'searching the web';
    }
    case 'web_fetch': {
      const url = trim(input?.url, 80);
      return url ? `fetching · ${url}` : 'fetching a page';
    }
    case 'bash': {
      const cmd = trim(input?.command, 80);
      return cmd ? `running · ${cmd}` : 'running a shell command';
    }
    case 'glob': {
      const p = trim(input?.pattern);
      return p ? `looking for files · ${p}` : 'listing files';
    }
    case 'grep': {
      const p = trim(input?.pattern);
      return p ? `searching files · "${p}"` : 'searching files';
    }
    case 'read': {
      const p = trim(input?.path);
      return p ? `reading · ${p}` : 'reading a file';
    }
    case 'write': {
      const p = trim(input?.path);
      return p ? `writing · ${p}` : 'writing a file';
    }
    case 'edit': {
      const p = trim(input?.path);
      return p ? `editing · ${p}` : 'editing a file';
    }
    case 'get_graph_summary':
      return 'looking at the canvas structure';
    case 'get_card':
      return `looking at a specific card`;
    case 'create_branch':
      return 'proposing a branch';
    case 'flag_card':
      return 'flagging an important card';
    case 'create_card':
      return 'creating a card on the canvas';
    case 'create_cards':
      return 'creating cards on the canvas';
    case 'present_options':
      return 'presenting choices for you to pick from';
    case 'edit_card':
      return 'refining an earlier card';
    case 'link_cards':
      return 'linking two cards on the canvas';
    default:
      return `using ${name}`;
  }
}

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
    sessionId: incomingSessionId = null,
    projectId = null,
    pathIds = [],
    responseCardId = null,
  } = req.body ?? {};

  // lazily ensure the project row exists server-side so
  // subsequent agent mutations (create_card / edit_card / flag_card /
  // link_cards / create_branch) can be persisted to the DB.
  if (projectId && !db.getProject(projectId)) {
    try {
      db.createProject({
        id: projectId,
        name: input.trim().slice(0, 60) || 'untitled canvas',
        sessionId: incomingSessionId,
      });
      logEvent('project.created', { projectId });
    } catch (err) {
      logEvent('project.create_failed', { projectId, message: err?.message });
    }
  }

  // Persist the user turn (the message the client just sent) and the
  // assistant turn shell (responseCardId, marked streaming) so the DB
  // mirrors the canvas as the conversation grows. The user turn is the
  // last id in pathIds; its parent is the second-to-last (or null for the
  // root turn).
  if (projectId && db.getProject(projectId)) {
    try {
      const ids = Array.isArray(pathIds) ? pathIds : [];
      const userTurnId = ids[ids.length - 1];
      const userParentId = ids.length >= 2 ? ids[ids.length - 2] : null;
      if (userTurnId) {
        const userTurn = {
          id: userTurnId,
          projectId,
          role: 'user',
          content: input,
          parentId: userParentId,
          emphasis: 1,
          streaming: false,
          meta: {},
        };
        db.upsertTurn(userTurn);
        broadcast(projectId, { type: 'turn_upsert', turn: userTurn });
      }
      if (responseCardId) {
        const respShell = {
          id: responseCardId,
          projectId,
          role: 'assistant',
          content: '',
          parentId: userTurnId ?? null,
          emphasis: 1,
          streaming: true,
          meta: {},
        };
        db.upsertTurn(respShell);
        broadcast(projectId, { type: 'turn_upsert', turn: respShell });
      }
    } catch (err) {
      logEvent('db.turn_seed_error', { projectId, message: err?.message });
    }
  }
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

  // Skinny when the session is being reused (its event log already has the
  // conversation), full when we're about to mint a fresh session.
  const buildKickoff = () =>
    incomingSessionId
      ? buildSkinnyKickoff(pathIds, input, emphasized, userContext, responseCardId)
      : buildFullKickoff(history, input, emphasized, userContext, pathIds, responseCardId);
  let text = buildKickoff();
  const startedAt = Date.now();
  logEvent('generate.start', {
    inputLen: input.length,
    historyLen: history.length,
    emphasizedCount: Array.isArray(emphasized) ? emphasized.length : 0,
    userContextCount: Array.isArray(userContext) ? userContext.length : 0,
    graphSize: graph?.turns ? Object.keys(graph.turns).length : 0,
    sessionReused: !!incomingSessionId,
    kickoffChars: text.length,
  });

  // Inject the responseCardId into the graph snapshot so create_card /
  // flag_card calls that pass it as parent_id pass validation. The client
  // omits streaming turns from buildGraphSnapshot, so without this the
  // agent's own response card wouldn't be a valid parent. parentId of the
  // response card is the last id in pathIds (the user turn that triggered
  // this response).
  if (responseCardId && graph?.turns && !graph.turns[responseCardId]) {
    const userId = Array.isArray(pathIds) && pathIds.length > 0
      ? pathIds[pathIds.length - 1]
      : null;
    graph.turns[responseCardId] = {
      id: responseCardId,
      role: 'assistant',
      parentId: userId,
      content: '',
      emphasis: 1,
    };
  }

  let sessionId = incomingSessionId;
  let totalChars = 0;
  let toolUses = 0;
  let customToolUses = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    // No pre-flight retrieve — Managed Agent sessions don't expire on
    // their own (only manual delete or explicit termination), so checking
    // is wasted overhead. If the id is genuinely bad the events.send call
    // below will throw and we fall back into a fresh-session retry.
    if (!sessionId) {
      // Prefer the project's per-project agent_id; fall back to the env
      // AGENT_ID for projects created before per-project provisioning.
      const projectRow = projectId ? db.getProject(projectId) : null;
      const agentForSession = projectRow?.agentId || AGENT_ID;
      const sessionParams = {
        agent: agentForSession,
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
              'Long-term memory across all river conversations. Read first; write durably useful learnings (preferences, recurring topics). Skip one-off chatter.',
          },
        ];
      }
      const created = await anthropic.beta.sessions.create(sessionParams);
      sessionId = created.id;
      logEvent('generate.session_created', { sessionId });
    }
    // Mirror the session id onto the project row so DB-side state matches
    // what the client knows. (Server-side workers will need this to reach
    // the right session after the autonomous-wake refactor.)
    if (projectId && db.getProject(projectId)) {
      db.setProjectSession(projectId, sessionId);
    }
    // Tell the client the session id (it may be the same id they sent, or a
    // freshly minted one). The store persists it so subsequent turns reuse.
    res.write(
      `data: ${JSON.stringify({ type: 'session', sessionId })}\n\n`,
    );

    // Stream-first: open the SSE stream BEFORE sending the kickoff so we
    // don't miss early events. (See `shared/managed-agents-events.md` →
    // Stream-first ordering — the stream only delivers events emitted
    // after it opens.) If the session id is stale (deleted out-of-band),
    // the stream open or the send will throw — recover by minting a fresh
    // session, switching to the full kickoff, and retrying once.
    let streamPromise;
    try {
      streamPromise = anthropic.beta.sessions.events.stream(sessionId);
      await anthropic.beta.sessions.events.send(sessionId, {
        events: [
          { type: 'user.message', content: [{ type: 'text', text }] },
        ],
      });
    } catch (err) {
      logEvent('generate.session_lost', {
        sessionId,
        message: err?.message,
      });
      // Fall back: mint a new session, swap to the full kickoff (the new
      // session has no history), tell the client.
      const projectRow = projectId ? db.getProject(projectId) : null;
      const agentForSession = projectRow?.agentId || AGENT_ID;
      const sessionParams = { agent: agentForSession, environment_id: ENV_ID, title: input.trim().slice(0, 60) };
      if (MEMORY_STORE_ID) {
        sessionParams.resources = [
          { type: 'memory_store', memory_store_id: MEMORY_STORE_ID, access: 'read_write', instructions: 'Long-term memory across all river conversations.' },
        ];
      }
      const created = await anthropic.beta.sessions.create(sessionParams);
      sessionId = created.id;
      if (projectId && db.getProject(projectId)) {
        db.setProjectSession(projectId, sessionId);
      }
      text = buildFullKickoff(history, input, emphasized, userContext, pathIds, responseCardId);
      res.write(
        `data: ${JSON.stringify({ type: 'session', sessionId })}\n\n`,
      );
      streamPromise = anthropic.beta.sessions.events.stream(sessionId);
      await anthropic.beta.sessions.events.send(sessionId, {
        events: [
          { type: 'user.message', content: [{ type: 'text', text }] },
        ],
      });
    }
    const stream = await streamPromise;

    // Track which agent.message blocks we've already emitted so re-emitted
    // event versions (e.g. queued → processed) don't duplicate text.
    let lastEmitted = '';
    let assistantBuffer = '';
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
          // Accumulate so we can persist the final assistant content to
          // DB on stream end (server now mirrors the canvas).
          assistantBuffer += chunk;
        }
      }
      // Built-in tool use (web_search, web_fetch, bash, file ops...) — emit
      // a plain-language activity line so the streaming card can show what
      // the agent is doing while it waits on the tool.
      if (event.type === 'agent.tool_use') {
        toolUses += 1;
        const desc = describeTool(event.name, event.input);
        res.write(
          `data: ${JSON.stringify({ type: 'activity', text: desc })}\n\n`,
        );
        logEvent('generate.tool_use', {
          sessionId,
          tool: event.name,
        });
      }
      // Per-model-request token usage. Aggregated for end-of-turn telemetry.
      if (event.type === 'span.model_request_end') {
        const usage = event.usage ?? event.model_usage ?? null;
        if (usage) {
          inputTokens += usage.input_tokens ?? 0;
          outputTokens += usage.output_tokens ?? 0;
        }
      }
      // Custom tool calls — resolve them locally against the graph snapshot
      // the client sent and reply with user.custom_tool_result. The session
      // goes idle (requires_action) until we send the result, then resumes.
      if (event.type === 'agent.custom_tool_use') {
        customToolUses += 1;
        // Activity line for the streaming card. Shown briefly until the
        // agent's response text starts streaming back in.
        res.write(
          `data: ${JSON.stringify({
            type: 'activity',
            text: describeTool(event.name, event.input),
          })}\n\n`,
        );
        logEvent('generate.custom_tool_use', {
          sessionId,
          tool: event.name,
          input: event.input ?? null,
        });
        let result;
        if (event.name === 'link_cards') {
          // Lateral connection between two cards. Validate both endpoints
          // exist + differ; generate a link id; forward as SSE so the
          // client materializes a Link in the store + the syncer renders
          // a dashed arrow.
          const fromId = event.input?.from_id;
          const toId = event.input?.to_id;
          const kind = (event.input?.kind ?? '').toString().trim().slice(0, 30);
          const turns = graph?.turns ?? {};
          if (!fromId || !turns[fromId]) {
            result = JSON.stringify({
              ok: false,
              error: `from_id ${fromId ?? '(missing)'} is not a card in the current graph`,
            });
          } else if (!toId || !turns[toId]) {
            result = JSON.stringify({
              ok: false,
              error: `to_id ${toId ?? '(missing)'} is not a card in the current graph`,
            });
          } else if (fromId === toId) {
            result = JSON.stringify({
              ok: false,
              error: 'from_id and to_id must differ — cards cannot link to themselves',
            });
          } else if (!kind) {
            result = JSON.stringify({
              ok: false,
              error: 'kind is required (short label like "answers", "contradicts")',
            });
          } else {
            const linkId = makeLinkId();
            res.write(
              `data: ${JSON.stringify({
                type: 'card_linked',
                linkId,
                fromId,
                toId,
                kind,
              })}\n\n`,
            );
            if (projectId && db.getProject(projectId)) {
              try {
                db.addLink({ id: linkId, projectId, fromId, toId, kind });
                broadcast(projectId, {
                  type: 'link_added',
                  link: { id: linkId, projectId, fromId, toId, kind },
                });
              } catch (err) {
                logEvent('db.link_error', { projectId, message: err?.message });
              }
            }
            result = JSON.stringify({
              ok: true,
              link_id: linkId,
              status: `link drawn from ${fromId} to ${toId} (${kind})`,
            });
          }
        } else if (event.name === 'edit_card') {
          // Rewrite an existing card in place. Validate the id exists in
          // the graph and that it's an assistant card (user cards are
          // off-limits — their questions belong to the user). Forward
          // SSE so the client applies setContent + re-derives chip spans.
          const cardId = event.input?.card_id;
          const newContent = (event.input?.content ?? '').toString();
          const turns = graph?.turns ?? {};
          const target = cardId ? turns[cardId] : null;
          if (!cardId || !target) {
            result = JSON.stringify({
              ok: false,
              error: `card_id ${cardId ?? '(missing)'} is not a card in the current graph`,
            });
          } else if (target.role !== 'assistant') {
            result = JSON.stringify({
              ok: false,
              error: `card ${cardId} is a user card; only assistant cards can be edited`,
            });
          } else if (!newContent.trim()) {
            result = JSON.stringify({
              ok: false,
              error: 'content is required',
            });
          } else {
            res.write(
              `data: ${JSON.stringify({
                type: 'card_edited',
                cardId,
                content: newContent.slice(0, 8000),
              })}\n\n`,
            );
            // Update in-flight snapshot so subsequent calls see new text.
            target.content = newContent;
            if (projectId && db.getProject(projectId)) {
              try {
                // Edit propagates as an upsert with the existing role
                // (assistant — we already validated). Meta is preserved.
                const editedTurn = {
                  id: cardId,
                  projectId,
                  role: target.role,
                  content: newContent,
                  parentId: target.parentId ?? null,
                  emphasis: target.emphasis ?? 1,
                  streaming: false,
                  meta: target.meta ?? {},
                };
                db.upsertTurn(editedTurn);
                broadcast(projectId, {
                  type: 'turn_upsert',
                  turn: editedTurn,
                });
              } catch (err) {
                logEvent('db.edit_error', { projectId, message: err?.message });
              }
            }
            result = JSON.stringify({
              ok: true,
              status: 'card rewritten in place',
            });
          }
        } else if (event.name === 'present_options') {
          // Attach a list of pick-from pills to a card. Forwards an SSE
          // event the client applies to meta.options; ACKs the agent
          // immediately so it never blocks.
          const cardId = event.input?.card_id;
          const rawOptions = Array.isArray(event.input?.options)
            ? event.input.options
            : [];
          const cleaned = rawOptions
            .filter((o) => typeof o === 'string')
            .map((o) => o.trim())
            .filter((o) => o.length > 0)
            .slice(0, 6);
          const turns = graph?.turns ?? {};
          if (!cardId || !turns[cardId]) {
            result = JSON.stringify({
              ok: false,
              error: `card_id ${cardId ?? '(missing)'} is not a card in the current graph`,
            });
          } else if (cleaned.length < 2) {
            result = JSON.stringify({
              ok: false,
              error: 'present_options needs at least 2 options',
            });
          } else {
            res.write(
              `data: ${JSON.stringify({
                type: 'options_presented',
                cardId,
                options: cleaned,
              })}\n\n`,
            );
            result = JSON.stringify({
              ok: true,
              status: 'options shown to user as pills',
            });
          }
        } else if (event.name === 'create_card') {
          // Agent-driven card creation: generate the new id server-side,
          // forward to the client as an SSE event so the store materializes
          // a turn at exactly that id, and ACK the agent with the id so it
          // can chain (flag it, reference in prose, parent further cards
          // under it, etc).
          const parentId = event.input?.parent_id;
          const content = (event.input?.content ?? '').toString();
          const annotation = (event.input?.annotation ?? '').toString().trim();
          const role = event.input?.role === 'user' ? 'user' : 'assistant';
          const turns = graph?.turns ?? {};
          if (!parentId || !turns[parentId]) {
            result = JSON.stringify({
              ok: false,
              error: `parent_id ${parentId ?? '(missing)'} is not a card in the current graph`,
            });
          } else if (!content.trim()) {
            result = JSON.stringify({ ok: false, error: 'content is required' });
          } else if (!annotation) {
            result = JSON.stringify({ ok: false, error: 'annotation is required (1-3 word classification tag)' });
          } else {
            const newId = makeShapeId();
            const meta = { label: annotation.slice(0, 60) };
            res.write(
              `data: ${JSON.stringify({
                type: 'card_created',
                id: newId,
                parentId,
                role,
                content: content.slice(0, 8000),
                meta,
              })}\n\n`,
            );
            // Optimistically extend the in-flight graph snapshot so any
            // subsequent create_card / flag_card calls in this same stream
            // can reference the just-created id.
            if (graph && graph.turns) {
              graph.turns[newId] = {
                id: newId,
                role,
                parentId,
                content,
                emphasis: 1,
              };
            }
            if (projectId && db.getProject(projectId)) {
              try {
                const newTurn = {
                  id: newId,
                  projectId,
                  role,
                  content,
                  parentId,
                  emphasis: 1,
                  streaming: false,
                  meta,
                };
                db.upsertTurn(newTurn);
                broadcast(projectId, { type: 'turn_upsert', turn: newTurn });
              } catch (err) {
                logEvent('db.create_card_error', { projectId, message: err?.message });
              }
            }
            result = JSON.stringify({
              ok: true,
              card_id: newId,
              status: `card created and shown to user (id: ${newId})`,
            });
          }
        } else if (event.name === 'create_cards') {
          // Batched card creation. One tool round-trip materializes N
          // cards; emits N SSE events back-to-back; ACKs the agent with
          // the array of new ids in input order. Saves N-1 round-trips
          // vs N sequential create_card calls (5-15s each).
          const cardsIn = Array.isArray(event.input?.cards)
            ? event.input.cards
            : [];
          const turns = graph?.turns ?? {};
          if (cardsIn.length === 0) {
            result = JSON.stringify({
              ok: false,
              error: 'cards array is required and must be non-empty',
            });
          } else if (cardsIn.length > 20) {
            result = JSON.stringify({
              ok: false,
              error: 'too many cards in one batch (max 20)',
            });
          } else {
            const ids = [];
            const errors = [];
            for (let i = 0; i < cardsIn.length; i++) {
              const c = cardsIn[i];
              const parentId = c?.parent_id;
              const content = (c?.content ?? '').toString();
              const annotation = (c?.annotation ?? '').toString().trim();
              const role = c?.role === 'user' ? 'user' : 'assistant';
              if (!parentId || !turns[parentId]) {
                errors.push(`#${i}: parent_id ${parentId ?? '(missing)'} not in graph`);
                ids.push(null);
                continue;
              }
              if (!content.trim()) {
                errors.push(`#${i}: content is required`);
                ids.push(null);
                continue;
              }
              if (!annotation) {
                errors.push(`#${i}: annotation is required`);
                ids.push(null);
                continue;
              }
              const newId = makeShapeId();
              const meta = { label: annotation.slice(0, 60) };
              ids.push(newId);
              res.write(
                `data: ${JSON.stringify({
                  type: 'card_created',
                  id: newId,
                  parentId,
                  role,
                  content: content.slice(0, 8000),
                  meta,
                })}\n\n`,
              );
              if (graph && graph.turns) {
                graph.turns[newId] = {
                  id: newId,
                  role,
                  parentId,
                  content,
                  emphasis: 1,
                };
              }
              if (projectId && db.getProject(projectId)) {
                try {
                  const newTurn = {
                    id: newId,
                    projectId,
                    role,
                    content,
                    parentId,
                    emphasis: 1,
                    streaming: false,
                    meta,
                  };
                  db.upsertTurn(newTurn);
                  broadcast(projectId, { type: 'turn_upsert', turn: newTurn });
                } catch (err) {
                  logEvent('db.create_cards_error', { projectId, message: err?.message });
                }
              }
            }
            const created = ids.filter(Boolean);
            result = JSON.stringify({
              ok: errors.length === 0,
              card_ids: ids,
              created: created.length,
              errors: errors.length > 0 ? errors : undefined,
              status: `${created.length} of ${cardsIn.length} cards created`,
            });
          }
        } else if (event.name === 'flag_card') {
          // flag_card: forward to the client as an SSE event the UI applies
          // to the store (sets emphasis=2 + records the reason). ACK the
          // agent immediately so it can keep going.
          const cardId = event.input?.card_id;
          const reason = (event.input?.reason ?? '').toString().trim();
          const turns = graph?.turns ?? {};
          if (!cardId || !turns[cardId]) {
            result = JSON.stringify({
              ok: false,
              error: `card_id ${cardId ?? '(missing)'} is not a card in the current graph`,
            });
          } else if (!reason) {
            result = JSON.stringify({ ok: false, error: 'reason is required' });
          } else {
            res.write(
              `data: ${JSON.stringify({
                type: 'card_flagged',
                cardId,
                reason: reason.slice(0, 240),
              })}\n\n`,
            );
            // Reflect the flag on the DB row: emphasis = 2 + meta.agentFlagReason.
            const target = (graph?.turns ?? {})[cardId];
            if (target && projectId && db.getProject(projectId)) {
              try {
                const flaggedTurn = {
                  id: cardId,
                  projectId,
                  role: target.role,
                  content: target.content ?? '',
                  parentId: target.parentId ?? null,
                  emphasis: 2,
                  streaming: false,
                  meta: { ...(target.meta ?? {}), agentFlagReason: reason.slice(0, 240) },
                };
                db.upsertTurn(flaggedTurn);
                broadcast(projectId, { type: 'turn_upsert', turn: flaggedTurn });
              } catch (err) {
                logEvent('db.flag_error', { projectId, message: err?.message });
              }
            }
            result = JSON.stringify({
              ok: true,
              status: 'card flagged for the user',
            });
          }
        } else if (event.name === 'create_branch') {
          // create_branch: forward the proposal to the client as an SSE event
          // the UI renders as a draft suggestion. Acknowledge to the agent
          // immediately so it can continue — the agent doesn't need to wait
          // on the user; accept/dismiss happens out-of-band.
          const parentId = event.input?.parent_id;
          const prompt = (event.input?.prompt ?? '').toString().trim();
          const rationale = (event.input?.rationale ?? '').toString().trim();
          const turns = graph?.turns ?? {};
          if (!parentId || !turns[parentId]) {
            result = JSON.stringify({
              ok: false,
              error: `parent_id ${parentId ?? '(missing)'} is not a card in the current graph`,
            });
          } else if (!prompt) {
            result = JSON.stringify({ ok: false, error: 'prompt is required' });
          } else {
            res.write(
              `data: ${JSON.stringify({
                type: 'branch_proposal',
                proposalId: event.id,
                parentId,
                prompt: prompt.slice(0, 240),
                rationale: rationale.slice(0, 240),
              })}\n\n`,
            );
            if (projectId && db.getProject(projectId)) {
              try {
                const newProposal = {
                  id: event.id,
                  projectId,
                  parentId,
                  prompt: prompt.slice(0, 240),
                  rationale: rationale.slice(0, 240),
                };
                db.addProposal(newProposal);
                broadcast(projectId, {
                  type: 'proposal_added',
                  proposal: newProposal,
                });
              } catch (err) {
                logEvent('db.proposal_error', { projectId, message: err?.message });
              }
            }
            result = JSON.stringify({
              ok: true,
              status: 'shown to user as a draft branch suggestion',
            });
          }
        } else {
          result = resolveGraphTool(event.name, event.input, graph);
        }
        try {
          await anthropic.beta.sessions.events.send(sessionId, {
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
    // Stream is done. Finalize the assistant turn in DB with the full
    // content + streaming=false so the next reload reflects the
    // completed response.
    if (projectId && responseCardId && db.getProject(projectId)) {
      try {
        const finalTurn = {
          id: responseCardId,
          projectId,
          role: 'assistant',
          content: assistantBuffer,
          parentId:
            Array.isArray(pathIds) && pathIds.length > 0
              ? pathIds[pathIds.length - 1]
              : null,
          emphasis: 1,
          streaming: false,
          meta: {},
        };
        db.upsertTurn(finalTurn);
        broadcast(projectId, { type: 'turn_upsert', turn: finalTurn });
      } catch (err) {
        logEvent('db.assistant_finalize_error', {
          projectId,
          message: err?.message,
        });
      }
    }
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    logEvent('generate.end', {
      sessionId,
      durationMs: Date.now() - startedAt,
      responseChars: totalChars,
      toolUses,
      customToolUses,
      inputTokens,
      outputTokens,
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
    // No session.delete — the project owns the session for the canvas's
    // lifetime. The client clears it on "+ new" (which calls
    // DELETE /api/session/:id below).
  }
});

/**
 * Dump the agent's persistent memory store as `{path: content}` JSON.
 * Spins up a throwaway session attached to the same memory store, asks
 * the agent to list and read every file under /mnt/memory/<name>/, and
 * parses the JSON response. Throwaway so it doesn't pollute the project
 * session's event log.
 */
app.get('/api/memory', async (req, res) => {
  if (!AGENT_ID || !ENV_ID || !MEMORY_STORE_ID) {
    res.json({ files: {}, configured: false });
    return;
  }
  const startedAt = Date.now();
  let session;
  try {
    session = await anthropic.beta.sessions.create({
      agent: AGENT_ID,
      environment_id: ENV_ID,
      title: 'memory-inspect',
      resources: [
        {
          type: 'memory_store',
          memory_store_id: MEMORY_STORE_ID,
          access: 'read_only',
          instructions: 'Read-only inspection of the persistent memory store.',
        },
      ],
    });
    const streamPromise = anthropic.beta.sessions.events.stream(session.id);
    await anthropic.beta.sessions.events.send(session.id, {
      events: [
        {
          type: 'user.message',
          content: [
            {
              type: 'text',
              text: `INSPECTION MODE — internal request, not from a user. Do NOT call create_branch / flag_card / web_search.

Use bash and read tools to list every file under /mnt/memory/ (recursively). For each file, capture its absolute path and its full text contents.

Output ONLY a single JSON object whose keys are the absolute file paths and whose values are the file contents (string). No prose, no markdown fences, no commentary. If the directory is empty or missing, output {}.`,
            },
          ],
        },
      ],
    });
    const stream = await streamPromise;
    let textOut = '';
    for await (const event of stream) {
      if (event.type === 'agent.message' && Array.isArray(event.content)) {
        const chunk = event.content
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('');
        if (chunk) textOut = chunk;
      }
      if (event.type === 'session.status_terminated') break;
      if (
        event.type === 'session.status_idle' &&
        event.stop_reason?.type !== 'requires_action'
      ) {
        break;
      }
      if (event.type === 'session.error') break;
    }
    const start = textOut.indexOf('{');
    const end = textOut.lastIndexOf('}');
    let files = {};
    if (start !== -1 && end !== -1 && end > start) {
      try {
        const parsed = JSON.parse(textOut.slice(start, end + 1));
        if (parsed && typeof parsed === 'object') {
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === 'string') files[k] = v;
          }
        }
      } catch (err) {
        logEvent('memory.parse_error', { message: err?.message });
      }
    }
    logEvent('memory.complete', {
      durationMs: Date.now() - startedAt,
      fileCount: Object.keys(files).length,
    });
    res.json({ files, configured: true });
  } catch (err) {
    logEvent('memory.error', {
      durationMs: Date.now() - startedAt,
      message: String(err?.message ?? err),
    });
    res.status(500).json({ error: String(err?.message ?? err) });
  } finally {
    if (session) {
      try {
        await anthropic.beta.sessions.delete(session.id);
      } catch (_) {
        // ignore
      }
    }
  }
});

// Best-effort session deletion. Used by the client when the user starts a
// new canvas — the prior project session and all its event history are no
// longer referenced. 30-day container-checkpoint TTL means dormant sessions
// also lose container state, but event history persists until deleted.
app.delete('/api/session/:id', async (req, res) => {
  const id = req.params.id;
  // Real session ids look like "sesn_011Ca…" — guard against accidental
  // path traversal / empty params, but don't be picky about the exact
  // prefix Anthropic uses (it's been "sesn_" historically).
  if (!id || !/^sesn?_[A-Za-z0-9]+$/.test(id)) {
    res.status(400).json({ error: 'invalid session id' });
    return;
  }
  try {
    await anthropic.beta.sessions.delete(id);
    logEvent('session.deleted', { sessionId: id });
    res.json({ ok: true });
  } catch (err) {
    logEvent('session.delete_failed', {
      sessionId: id,
      message: String(err?.message ?? err),
    });
    // 200 anyway: best-effort, don't block the client UX.
    res.json({ ok: false, message: String(err?.message ?? err) });
  }
});

// ───────────────────── autonomous turns (wake) ─────────────────
//
// POST /api/projects/:id/wake fires a turn at a project's persistent
// session WITHOUT a user message. The agent reviews the canvas + memory
// and contributes one useful thing if it sees something — flags a card,
// drafts a follow-up via create_card, draws a link between cards in
// different branches — or ends its turn silently if nothing meaningful
// surfaces. Mutations land in the DB + broadcast via the WS channel,
// so any client connected to the project sees them live; offline users
// see them on next mount-time fetchProjectState.

const wakeInFlight = new Set(); // projectIds with an in-flight wake

function buildAutonomousKickoff(projectId, responseCardId, turns, wakeIntent) {
  const rendered = Object.values(turns)
    .map(
      (t) =>
        `[${t.id}] role=${t.role} parent=${t.parentId ?? 'none'}\n${(t.content ?? '').trim()}`,
    )
    .join('\n\n---\n\n');
  // Optional per-canvas direction the user wrote in the projects menu.
  // When present, treat it as the load-bearing instruction for THIS wake;
  // when absent, fall back to the generic survey-the-canvas behavior.
  const intentBlock = wakeIntent && wakeIntent.trim()
    ? `THE USER'S DIRECTION FOR THIS WAKE — what they want you to watch for between sessions:

${wakeIntent.trim()}

Take this as the focus. Choose a tending action that addresses this direction specifically. If nothing in the current canvas state genuinely earns an action under that direction, write a single short sentence saying so and end the turn — that's still useful, it's the keeper reporting back.

`
    : '';
  return `AUTONOMOUS WAKE — the user is NOT present right now. They will read what you do later.

${intentBlock}Look at the canvas (graph below) and your /mnt/memory/ store. Contribute ONE meaningful thing if you see something worth doing:
- flag a turning point you missed earlier (flag_card)
- draw a link between cards in different branches that touch the same idea (link_cards)
- draft a card that elaborates an open question or refines a vague conclusion (create_card under the right parent)
- edit a card you wrote that you can sharpen (edit_card)

If nothing genuinely useful comes to mind, write a single short sentence saying so and end your turn — better than noise.

DO NOT call create_branch (those need a user to accept; with no user here they'd just pile up).
DO NOT call present_options (no one to pick).

YOUR RESPONSE CARD: ${responseCardId} — your prose lands here. Reference it as parent_id for create_card if you want sub-cards.

Project: ${projectId}

CANVAS:

${rendered}

Begin.`;
}

/**
 * Run an autonomous wake for a project. Shared by the manual endpoint
 * (POST /api/projects/:id/wake) and the cron loop. Returns a result
 * object with status and stats; never throws — internal errors land in
 * `error` so callers can decide how to surface.
 */
async function runWakeForProject(projectId) {
  const project = db.getProject(projectId);
  if (!project) {
    return { ok: false, status: 'not_found', error: 'project not found' };
  }
  if (!project.sessionId) {
    return {
      ok: false,
      status: 'no_session',
      error: 'no session yet — the user must take at least one turn first',
    };
  }
  if (wakeInFlight.has(projectId)) {
    return { ok: false, status: 'in_flight', error: 'a wake is already in flight for this project' };
  }
  wakeInFlight.add(projectId);

  const startedAt = Date.now();
  let toolUses = 0;
  let customToolUses = 0;
  let assistantBuffer = '';
  let responseCardId = null;
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    const allTurns = db.listTurns(projectId);
    if (allTurns.length === 0) {
      res.status(400).json({ error: 'project has no turns to reflect on' });
      return;
    }
    // Parent the autonomous response under the most recent assistant card
    // (or the most recent turn if no assistants exist yet) so it shows up
    // in a sensible place on the canvas.
    const newest = [...allTurns].sort((a, b) => b.createdAt - a.createdAt);
    const parentTurn =
      newest.find((t) => t.role === 'assistant') ?? newest[0];

    responseCardId = makeShapeId();
    const respShell = {
      id: responseCardId,
      projectId,
      role: 'assistant',
      content: '',
      parentId: parentTurn.id,
      emphasis: 1,
      streaming: true,
      meta: {},
    };
    db.upsertTurn(respShell);
    broadcast(projectId, { type: 'turn_upsert', turn: respShell });

    // Build the graph snapshot the autonomous prompt + custom tool
    // resolvers will reference. Same shape as /api/generate's `graph`.
    const graphSnap = { turns: {} };
    for (const t of allTurns) {
      graphSnap.turns[t.id] = {
        id: t.id,
        role: t.role,
        parentId: t.parentId,
        content: t.content,
        emphasis: t.emphasis,
      };
    }
    graphSnap.turns[responseCardId] = {
      id: responseCardId,
      role: 'assistant',
      parentId: parentTurn.id,
      content: '',
      emphasis: 1,
    };

    const kickoff = buildAutonomousKickoff(
      projectId,
      responseCardId,
      graphSnap.turns,
      project.wakeIntent,
    );
    logEvent('wake.start', {
      projectId,
      sessionId: project.sessionId,
      kickoffChars: kickoff.length,
      turnCount: allTurns.length,
    });

    const streamPromise = anthropic.beta.sessions.events.stream(
      project.sessionId,
    );
    await anthropic.beta.sessions.events.send(project.sessionId, {
      events: [
        { type: 'user.message', content: [{ type: 'text', text: kickoff }] },
      ],
    });
    const stream = await streamPromise;

    let lastEmitted = '';
    for await (const event of stream) {
      if (event.type === 'agent.message' && Array.isArray(event.content)) {
        const chunk = event.content
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('');
        if (chunk && chunk !== lastEmitted) {
          lastEmitted = chunk;
          assistantBuffer += chunk;
        }
      }
      if (event.type === 'agent.tool_use') {
        toolUses += 1;
        logEvent('wake.tool_use', { projectId, tool: event.name });
      }
      if (event.type === 'span.model_request_end') {
        const usage = event.usage ?? event.model_usage ?? null;
        if (usage) {
          inputTokens += usage.input_tokens ?? 0;
          outputTokens += usage.output_tokens ?? 0;
        }
      }
      if (event.type === 'agent.custom_tool_use') {
        customToolUses += 1;
        logEvent('wake.custom_tool_use', {
          projectId,
          tool: event.name,
          input: event.input ?? null,
        });
        // Reuse the same custom-tool dispatch as /api/generate. The block
        // is large; rather than refactor mid-phase-1, inline the subset
        // we want autonomous turns to have:
        //   create_card, create_cards, edit_card, flag_card, link_cards.
        // create_branch + present_options are intentionally suppressed
        // (the kickoff already says skip them).
        let result;
        if (event.name === 'create_card') {
          const parentId = event.input?.parent_id;
          const content = (event.input?.content ?? '').toString();
          const annotation = (event.input?.annotation ?? '').toString().trim();
          const role =
            event.input?.role === 'user' ? 'user' : 'assistant';
          if (!parentId || !graphSnap.turns[parentId]) {
            result = JSON.stringify({
              ok: false,
              error: `parent_id ${parentId ?? '(missing)'} not in graph`,
            });
          } else if (!content.trim()) {
            result = JSON.stringify({ ok: false, error: 'content is required' });
          } else if (!annotation) {
            result = JSON.stringify({ ok: false, error: 'annotation is required (1-3 word classification tag)' });
          } else {
            const newId = makeShapeId();
            const newTurn = {
              id: newId,
              projectId,
              role,
              content,
              parentId,
              emphasis: 1,
              streaming: false,
              meta: { label: annotation.slice(0, 60) },
            };
            db.upsertTurn(newTurn);
            broadcast(projectId, { type: 'turn_upsert', turn: newTurn });
            graphSnap.turns[newId] = {
              id: newId,
              role,
              parentId,
              content,
              emphasis: 1,
            };
            result = JSON.stringify({ ok: true, card_id: newId });
          }
        } else if (event.name === 'create_cards') {
          const cardsIn = Array.isArray(event.input?.cards)
            ? event.input.cards
            : [];
          const ids = [];
          const errors = [];
          for (let i = 0; i < cardsIn.length; i++) {
            const c = cardsIn[i];
            const parentId = c?.parent_id;
            const content = (c?.content ?? '').toString();
            const annotation = (c?.annotation ?? '').toString().trim();
            const role = c?.role === 'user' ? 'user' : 'assistant';
            if (!parentId || !graphSnap.turns[parentId]) {
              errors.push(`#${i}: parent_id not in graph`);
              ids.push(null);
              continue;
            }
            if (!content.trim()) {
              errors.push(`#${i}: content required`);
              ids.push(null);
              continue;
            }
            if (!annotation) {
              errors.push(`#${i}: annotation required`);
              ids.push(null);
              continue;
            }
            const newId = makeShapeId();
            const newTurn = {
              id: newId,
              projectId,
              role,
              content,
              parentId,
              emphasis: 1,
              streaming: false,
              meta: { label: annotation.slice(0, 60) },
            };
            db.upsertTurn(newTurn);
            broadcast(projectId, { type: 'turn_upsert', turn: newTurn });
            graphSnap.turns[newId] = {
              id: newId,
              role,
              parentId,
              content,
              emphasis: 1,
            };
            ids.push(newId);
          }
          result = JSON.stringify({
            ok: errors.length === 0,
            card_ids: ids,
            errors: errors.length > 0 ? errors : undefined,
          });
        } else if (event.name === 'edit_card') {
          const cardId = event.input?.card_id;
          const newContent = (event.input?.content ?? '').toString();
          const target = graphSnap.turns[cardId];
          if (!target) {
            result = JSON.stringify({ ok: false, error: `card_id ${cardId ?? '(missing)'} not in graph` });
          } else if (target.role !== 'assistant') {
            result = JSON.stringify({ ok: false, error: 'cannot edit user cards' });
          } else if (!newContent.trim()) {
            result = JSON.stringify({ ok: false, error: 'content required' });
          } else {
            const editedTurn = {
              id: cardId,
              projectId,
              role: target.role,
              content: newContent,
              parentId: target.parentId ?? null,
              emphasis: target.emphasis ?? 1,
              streaming: false,
              meta: target.meta ?? {},
            };
            db.upsertTurn(editedTurn);
            broadcast(projectId, { type: 'turn_upsert', turn: editedTurn });
            target.content = newContent;
            result = JSON.stringify({ ok: true });
          }
        } else if (event.name === 'flag_card') {
          const cardId = event.input?.card_id;
          const reason = (event.input?.reason ?? '').toString().trim();
          const target = graphSnap.turns[cardId];
          if (!target) {
            result = JSON.stringify({ ok: false, error: `card_id ${cardId ?? '(missing)'} not in graph` });
          } else if (!reason) {
            result = JSON.stringify({ ok: false, error: 'reason required' });
          } else {
            const flaggedTurn = {
              id: cardId,
              projectId,
              role: target.role,
              content: target.content ?? '',
              parentId: target.parentId ?? null,
              emphasis: 2,
              streaming: false,
              meta: { ...(target.meta ?? {}), agentFlagReason: reason.slice(0, 240) },
            };
            db.upsertTurn(flaggedTurn);
            broadcast(projectId, { type: 'turn_upsert', turn: flaggedTurn });
            result = JSON.stringify({ ok: true });
          }
        } else if (event.name === 'link_cards') {
          const fromId = event.input?.from_id;
          const toId = event.input?.to_id;
          const kind = (event.input?.kind ?? '').toString().trim().slice(0, 30);
          if (!fromId || !graphSnap.turns[fromId]) {
            result = JSON.stringify({ ok: false, error: `from_id ${fromId ?? '(missing)'} not in graph` });
          } else if (!toId || !graphSnap.turns[toId]) {
            result = JSON.stringify({ ok: false, error: `to_id ${toId ?? '(missing)'} not in graph` });
          } else if (fromId === toId) {
            result = JSON.stringify({ ok: false, error: 'from and to must differ' });
          } else if (!kind) {
            result = JSON.stringify({ ok: false, error: 'kind required' });
          } else {
            const linkId = makeLinkId();
            const link = { id: linkId, projectId, fromId, toId, kind };
            db.addLink(link);
            broadcast(projectId, { type: 'link_added', link });
            result = JSON.stringify({ ok: true, link_id: linkId });
          }
        } else {
          // Suppress create_branch / present_options + delegate everything
          // else to the read-only graph resolvers.
          if (event.name === 'create_branch' || event.name === 'present_options') {
            result = JSON.stringify({
              ok: false,
              error: `${event.name} is disabled in autonomous mode (no user present)`,
            });
          } else {
            result = resolveGraphTool(event.name, event.input, graphSnap);
          }
        }
        try {
          await anthropic.beta.sessions.events.send(project.sessionId, {
            events: [
              {
                type: 'user.custom_tool_result',
                custom_tool_use_id: event.id,
                content: [{ type: 'text', text: result }],
              },
            ],
          });
        } catch (err) {
          console.error('wake: tool_result send failed:', err?.message);
        }
        continue;
      }
      if (event.type === 'session.status_terminated') break;
      if (
        event.type === 'session.status_idle' &&
        event.stop_reason?.type !== 'requires_action'
      ) {
        break;
      }
      if (event.type === 'session.error') {
        logEvent('wake.error', {
          projectId,
          message: event.error?.message ?? 'session error',
        });
        break;
      }
    }

    // Finalize the response card. If the agent wrote nothing meaningful,
    // delete the empty shell rather than leaving a phantom card.
    if (assistantBuffer.trim().length === 0) {
      db.deleteTurn(responseCardId, projectId);
      broadcast(projectId, {
        type: 'subtree_deleted',
        rootId: responseCardId,
        removed: [responseCardId],
      });
    } else {
      const finalTurn = {
        id: responseCardId,
        projectId,
        role: 'assistant',
        content: assistantBuffer,
        parentId: parentTurn.id,
        emphasis: 1,
        streaming: false,
        meta: {},
      };
      db.upsertTurn(finalTurn);
      broadcast(projectId, { type: 'turn_upsert', turn: finalTurn });
    }

    logEvent('wake.end', {
      projectId,
      durationMs: Date.now() - startedAt,
      responseChars: assistantBuffer.length,
      toolUses,
      customToolUses,
      inputTokens,
      outputTokens,
      kept: assistantBuffer.trim().length > 0,
    });

    return {
      ok: true,
      status: 'done',
      responseCardId: assistantBuffer.trim().length > 0 ? responseCardId : null,
      content: assistantBuffer,
      toolUses,
      customToolUses,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    logEvent('wake.error', {
      projectId,
      message: String(err?.message ?? err),
    });
    return {
      ok: false,
      status: 'error',
      error: String(err?.message ?? err),
    };
  } finally {
    wakeInFlight.delete(projectId);
  }
}

app.post('/api/projects/:id/wake', async (req, res) => {
  const result = await runWakeForProject(req.params.id);
  if (!result.ok) {
    const code =
      result.status === 'not_found'
        ? 404
        : result.status === 'in_flight'
          ? 429
          : result.status === 'no_session'
            ? 400
            : 500;
    res.status(code).json({ error: result.error });
    return;
  }
  res.json(result);
});

// ── Auto-wake loop (cron-like) ──────────────────────────────────────────
//
// When WAKE_INTERVAL_SEC is set, the server periodically picks projects
// that:
//   - have a sessionId (so the agent has somewhere to go)
//   - have been quiet for ≥ WAKE_MIN_QUIET_SEC (don't fire while the
//     user is mid-conversation)
//   - have been touched within WAKE_MAX_AGE_HOURS (don't burn API calls
//     on long-abandoned canvases)
//   - aren't already in-flight
// and fires runWakeForProject on each. Default off (interval=0).

const WAKE_INTERVAL_SEC = Number(process.env.WAKE_INTERVAL_SEC ?? 0);
const WAKE_MAX_AGE_HOURS = Number(process.env.WAKE_MAX_AGE_HOURS ?? 24);
const WAKE_MIN_QUIET_SEC = Number(process.env.WAKE_MIN_QUIET_SEC ?? 300);

if (WAKE_INTERVAL_SEC > 0) {
  console.log(
    `auto-wake: every ${WAKE_INTERVAL_SEC}s (max age ${WAKE_MAX_AGE_HOURS}h, min quiet ${WAKE_MIN_QUIET_SEC}s)`,
  );
  setInterval(() => {
    const now = Date.now();
    const maxAgeMs = WAKE_MAX_AGE_HOURS * 3600 * 1000;
    const quietMs = WAKE_MIN_QUIET_SEC * 1000;
    for (const project of db.listProjects()) {
      if (!project.sessionId) continue;
      const age = now - project.updatedAt;
      if (age > maxAgeMs) continue;
      if (age < quietMs) continue;
      if (wakeInFlight.has(project.id)) continue;
      logEvent('wake.cron_pick', {
        projectId: project.id,
        ageMs: age,
      });
      void runWakeForProject(project.id).catch((err) => {
        logEvent('wake.cron_error', {
          projectId: project.id,
          message: String(err?.message ?? err),
        });
      });
    }
  }, WAKE_INTERVAL_SEC * 1000);
}

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

/**
 * Batch-label a set of cards. Single Haiku call returns one label per card.
 * Used by the map menu's tree view: labels are computed once per card and
 * cached client-side so the map opens instantly. The client only sends
 * cards that don't yet have a label.
 */
app.post('/api/labels', async (req, res) => {
  const { cards = [] } = req.body ?? {};
  const filtered = (Array.isArray(cards) ? cards : [])
    .filter(
      (c) =>
        c &&
        typeof c.id === 'string' &&
        (c.role === 'user' || c.role === 'assistant') &&
        typeof c.content === 'string' &&
        c.content.trim(),
    )
    .slice(0, 60);
  if (filtered.length === 0) {
    res.json({ labels: {} });
    return;
  }

  const rendered = filtered
    .map(
      (c) =>
        `[${c.id}] role=${c.role}\n${c.content.trim().slice(0, 600)}`,
    )
    .join('\n\n---\n\n');

  const startedAt = Date.now();
  logEvent('labels.start', { count: filtered.length });
  try {
    const response = await anthropic.messages.create({
      model: MIST_MODEL,
      max_tokens: 600,
      system: LABELS_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `Produce a label for each card. Output ONLY a JSON object {id: label}. Cards:\n\n${rendered}`,
        },
      ],
    });
    const raw = response.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('');
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      logEvent('labels.error', {
        durationMs: Date.now() - startedAt,
        message: 'no JSON object in response',
      });
      res.json({ labels: {} });
      return;
    }
    const parsed = JSON.parse(raw.slice(start, end + 1));
    const labels = {};
    if (parsed && typeof parsed === 'object') {
      for (const c of filtered) {
        const v = parsed[c.id];
        if (typeof v === 'string' && v.trim()) {
          labels[c.id] = v.trim().slice(0, 80);
        }
      }
    }
    logEvent('labels.complete', {
      durationMs: Date.now() - startedAt,
      requested: filtered.length,
      returned: Object.keys(labels).length,
    });
    res.json({ labels });
  } catch (err) {
    logEvent('labels.error', {
      durationMs: Date.now() - startedAt,
      message: String(err?.message ?? err),
    });
    console.error('labels failed:', err?.message);
    res.json({ labels: {} });
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

/**
 * Live agent + environment info, surfaced in the projects menu footer.
 * Pulls the current agent's version + model from Anthropic so the UI can
 * show "v10 · opus 4.7 · sesn_…" without baking a stale value into the
 * client. Cached briefly on the client; ~once-per-mount fetch.
 */
app.get('/api/info', async (req, res) => {
  if (!AGENT_ID) {
    res.json({
      agentId: null,
      agentVersion: null,
      model: null,
      envId: ENV_ID ?? null,
      memoryStoreId: MEMORY_STORE_ID ?? null,
    });
    return;
  }
  try {
    const agent = await anthropic.beta.agents.retrieve(AGENT_ID);
    // model can be a bare string or {id, speed} object — normalize.
    const modelStr =
      typeof agent.model === 'string'
        ? agent.model
        : agent.model?.id ?? null;
    res.json({
      agentId: agent.id,
      agentVersion: agent.version ?? null,
      model: modelStr,
      envId: ENV_ID ?? null,
      memoryStoreId: MEMORY_STORE_ID ?? null,
    });
  } catch (err) {
    res.json({
      agentId: AGENT_ID,
      agentVersion: null,
      model: null,
      envId: ENV_ID ?? null,
      memoryStoreId: MEMORY_STORE_ID ?? null,
      error: String(err?.message ?? err),
    });
  }
});

// ───────────────────── Projects + canvas state API ─────────────────────
//
// server is now the source of truth for the canvas. Each project
// holds turns, links, and pending proposals; the agent's session id lives
// on the project row. Clients fetch on mount, write through the mutation
// endpoints, and  subscribe to a per-project WebSocket for
// live updates.

app.get('/api/projects', (_req, res) => {
  // For each project that's still using the default "untitled canvas"
  // name, derive a friendly label from the first user turn with content
  // and attach it as `derivedName`. The client picks `derivedName ||
  // name` for display so archived rows show the actual question rather
  // than a placeholder. Cheap: one O(turns) scan per project, run only
  // when the menu is opened.
  const projects = db.listProjects().map((p) => {
    if (p.name && p.name !== 'untitled canvas') return p;
    const turns = db.listTurns(p.id);
    const firstUser = turns.find(
      (t) => t.role === 'user' && (t.content ?? '').trim().length > 0,
    );
    if (!firstUser) return p;
    const raw = String(firstUser.content).replace(/\s+/g, ' ').trim();
    const derivedName = raw.length > 60 ? raw.slice(0, 60).trimEnd() + '…' : raw;
    return { ...p, derivedName };
  });
  res.json({ projects });
});

/**
 * Provision a fresh Anthropic agent for a new project. Uses scripts/agent.yml
 * as the template; overrides `name` to be project-scoped so agents are
 * distinguishable in dashboards. Returns the new agent id, or null if
 * provisioning failed (the project still gets created; subsequent turns
 * fall back to env AGENT_ID until a manual recovery).
 */
async function provisionProjectAgent(projectId) {
  if (!AGENT_TEMPLATE) return null;
  try {
    const config = {
      ...AGENT_TEMPLATE,
      name: `river · ${projectId}`,
    };
    const agent = await anthropic.beta.agents.create(config);
    logEvent('agent.provisioned', { projectId, agentId: agent.id });
    return agent.id;
  } catch (err) {
    logEvent('agent.provision_failed', {
      projectId,
      message: String(err?.message ?? err),
    });
    return null;
  }
}

function makeProjectId() {
  const a = '0123456789abcdefghijklmnopqrstuvwxyz';
  let body = '';
  for (let i = 0; i < 12; i++) body += a[Math.floor(Math.random() * a.length)];
  return `proj_${body}`;
}

app.post('/api/projects', async (req, res) => {
  const { id: incomingId, name } = req.body ?? {};
  let id = incomingId;
  if (id && (typeof id !== 'string' || !id.startsWith('proj_'))) {
    res.status(400).json({ error: 'id (proj_*) invalid' });
    return;
  }
  if (id && db.getProject(id)) {
    res.status(409).json({ error: 'project already exists' });
    return;
  }
  if (!id) id = makeProjectId();
  // Per-project agent provisioning happens on project create. The
  // resulting agent_id sits on the project row; /api/generate uses it
  // to scope sessions, so each canvas has its own immutable, versioned
  // agent config.
  const agentId = await provisionProjectAgent(id);
  const project = db.createProject({ id, name, agentId });
  res.json({ project });
});

app.get('/api/projects/:id/state', (req, res) => {
  const state = db.getProjectState(req.params.id);
  if (!state) {
    res.status(404).json({ error: 'project not found' });
    return;
  }
  res.json(state);
});

app.patch('/api/projects/:id', (req, res) => {
  const { name, sessionId, wakeIntent } = req.body ?? {};
  const proj = db.getProject(req.params.id);
  if (!proj) {
    res.status(404).json({ error: 'project not found' });
    return;
  }
  if (typeof name === 'string' && name.trim()) {
    db.renameProject(req.params.id, name.trim());
    broadcast(req.params.id, { type: 'project_renamed', name: name.trim() });
  }
  if (sessionId === null || typeof sessionId === 'string') {
    db.setProjectSession(req.params.id, sessionId);
    broadcast(req.params.id, { type: 'project_session_changed', sessionId });
  }
  if (typeof wakeIntent === 'string') {
    db.setProjectWakeIntent(req.params.id, wakeIntent);
    broadcast(req.params.id, {
      type: 'project_wake_intent_changed',
      wakeIntent,
    });
  }
  res.json({ project: db.getProject(req.params.id) });
});

app.delete('/api/projects/:id', async (req, res) => {
  const proj = db.getProject(req.params.id);
  if (!proj) {
    res.status(404).json({ error: 'project not found' });
    return;
  }
  // Best-effort: clean up the project's per-project agent + session on
  // Anthropic's side. Errors here don't block the local DB delete; the
  // user wants the canvas gone now and orphan agents are recoverable.
  if (proj.sessionId) {
    try { await anthropic.beta.sessions.delete(proj.sessionId); } catch (_) {}
  }
  if (proj.agentId && proj.agentId !== AGENT_ID) {
    try { await anthropic.beta.agents.delete(proj.agentId); } catch (_) {}
  }
  db.deleteProject(req.params.id);
  broadcast(req.params.id, { type: 'project_deleted', projectId: req.params.id });
  res.json({ ok: true });
});

// ── Mutations on canvas state. Each mutation is a single small endpoint so
//    server-side logic can broadcast it on a project channel later
//    without trying to interpret a generic "diff". ──

app.post('/api/projects/:id/turns', (req, res) => {
  const projectId = req.params.id;
  if (!db.getProject(projectId)) {
    res.status(404).json({ error: 'project not found' });
    return;
  }
  const turn = req.body?.turn;
  if (!turn || !turn.id || !turn.role) {
    res.status(400).json({ error: 'turn.id + turn.role required' });
    return;
  }
  db.upsertTurn({ ...turn, projectId });
  broadcast(projectId, { type: 'turn_upsert', turn: { ...turn, projectId } });
  res.json({ ok: true });
});

app.delete('/api/projects/:id/turns/:turnId', (req, res) => {
  const projectId = req.params.id;
  if (!db.getProject(projectId)) {
    res.status(404).json({ error: 'project not found' });
    return;
  }
  const removed = db.deleteSubtree(req.params.turnId, projectId);
  broadcast(projectId, {
    type: 'subtree_deleted',
    rootId: req.params.turnId,
    removed,
  });
  res.json({ ok: true, removed });
});

app.post('/api/projects/:id/links', (req, res) => {
  const projectId = req.params.id;
  if (!db.getProject(projectId)) {
    res.status(404).json({ error: 'project not found' });
    return;
  }
  const link = req.body?.link;
  if (!link || !link.id || !link.fromId || !link.toId) {
    res.status(400).json({ error: 'link.{id,fromId,toId} required' });
    return;
  }
  db.addLink({ ...link, projectId });
  broadcast(projectId, { type: 'link_added', link: { ...link, projectId } });
  res.json({ ok: true });
});

app.delete('/api/projects/:id/links/:linkId', (req, res) => {
  db.removeLink(req.params.linkId, req.params.id);
  broadcast(req.params.id, { type: 'link_deleted', linkId: req.params.linkId });
  res.json({ ok: true });
});

app.post('/api/projects/:id/proposals', (req, res) => {
  const projectId = req.params.id;
  if (!db.getProject(projectId)) {
    res.status(404).json({ error: 'project not found' });
    return;
  }
  const proposal = req.body?.proposal;
  if (!proposal || !proposal.id || !proposal.parentId || !proposal.prompt) {
    res.status(400).json({ error: 'proposal.{id,parentId,prompt} required' });
    return;
  }
  db.addProposal({ ...proposal, projectId });
  broadcast(projectId, {
    type: 'proposal_added',
    proposal: { ...proposal, projectId },
  });
  res.json({ ok: true });
});

app.delete('/api/projects/:id/proposals/:proposalId', (req, res) => {
  db.removeProposal(req.params.proposalId, req.params.id);
  broadcast(req.params.id, {
    type: 'proposal_removed',
    proposalId: req.params.proposalId,
  });
  res.json({ ok: true });
});

// One-shot migration from the client's localStorage shape into the server
// DB. Idempotent: skips projects whose id already exists. Body:
//   {
//     active?: { id, name?, sessionId?, turns: Record<id, Turn>,
//                links: Link[], proposals: BranchProposal[] },
//     archive?: ArchivedProject[]   // each {id, name, sessionId, turns}
//   }
app.get('/api/health', (_req, res) => res.json({ ok: true, model: MAIN_MODEL }));

// ───────────────────── WebSocket: per-project channels ────────────────
//
// Each connected client subscribes to one project at a time
// (the active canvas) and receives every mutation that lands on that
// project — agent-emitted (via /api/generate's tool resolvers) and
// user-emitted (via /api/projects/:id/* mutation endpoints). Multi-tab,
// multi-device, and the future background worker  all share
// this one fan-out point.
//
// We attach the WS to the same HTTP server so a single PORT serves both.

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const wsSubscriptions = new Map(); // projectId → Set<WebSocket>

httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const m = url.pathname.match(/^\/ws\/projects\/([^/]+)\/?$/);
  if (!m) {
    socket.destroy();
    return;
  }
  const projectId = m[1];
  wss.handleUpgrade(req, socket, head, (ws) => {
    let subs = wsSubscriptions.get(projectId);
    if (!subs) {
      subs = new Set();
      wsSubscriptions.set(projectId, subs);
    }
    subs.add(ws);
    logEvent('ws.connected', { projectId, subscribers: subs.size });
    ws.on('close', () => {
      subs.delete(ws);
      if (subs.size === 0) wsSubscriptions.delete(projectId);
      logEvent('ws.disconnected', { projectId, subscribers: subs.size });
    });
    // Send a hello so clients can confirm subscription.
    try {
      ws.send(JSON.stringify({ type: 'subscribed', projectId }));
    } catch (_) {
      // ignore
    }
  });
});

/**
 * Fan out an event to every connected WS on a project's channel. Best-
 * effort — no retry; clients reconnect and re-fetch state on disconnect.
 */
function broadcast(projectId, event) {
  if (!projectId) return;
  const subs = wsSubscriptions.get(projectId);
  if (!subs || subs.size === 0) return;
  let payload;
  try {
    payload = JSON.stringify(event);
  } catch (_) {
    return;
  }
  for (const ws of subs) {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(payload);
      } catch (_) {
        // ignore — closed sockets get cleaned in the close handler
      }
    }
  }
}

httpServer.listen(PORT, () => {
  console.log(`river api on :${PORT}  main=${MAIN_MODEL}  mist=${MIST_MODEL}`);
});
 

// noop Sun Apr 26 19:59:04 CEST 2026
