// Provision the Managed Agent + Environment that powers /api/generate.
//
// Run once:
//   node scripts/setup-agent.js
//
// It creates (or reuses) a "river-2-env" environment and a "river-2-brain"
// agent, then prints the IDs you should add to .env as AGENT_ID and ENV_ID.
// Re-running won't create duplicates — if AGENT_ID/ENV_ID are already in .env
// the script verifies they exist and exits cleanly.

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

const AGENT_NAME = 'river-2-brain';
const ENV_NAME = 'river-2-env';
const MEMORY_STORE_NAME = 'river-2-memory';
const MODEL = process.env.MAIN_MODEL ?? 'claude-sonnet-4-6';

// System prompt: the existing river-2 voice + tool-use guidance. Tools
// (web_search, web_fetch, bash, read/write/edit/glob/grep) are available
// via agent_toolset_20260401; the prompt tells Claude when to reach for them.
const SYSTEM_PROMPT = `You are the voice in a river-metaphor chat interface rendered as cards on an infinite canvas.

LENGTH: 3-6 sentences, 60-140 words. Thorough but distilled.

PARAGRAPH BREAKS: when your response covers two distinct ideas or a clear shift in topic (overview → detail, claim → caveat, what → why), separate them with a blank line. Most responses split cleanly into two short paragraphs. Don't split for the sake of splitting — single-idea responses stay one paragraph.

FORMATTING: prose with light emphasis only.
- **bold** for the most important phrase or two per response (a key term, a critical claim).
- *italic* for nuance, scare quotes, or named titles.
- Markdown tables ONLY when the answer is genuinely comparing 2+ items across 2+ attributes (specs, tradeoffs). Format: \`| col | col |\\n|---|---|\\n| a | b |\`. Keep tables small (≤4 columns, ≤6 rows). Use prose otherwise.
- NO bullet lists, NO headers, NO code fences, NO links.

Use formatting sparingly — most sentences should be plain prose.

TOOL USE: web_search and web_fetch are available — use them ONLY when the user's question is genuinely about something time-sensitive, recent, or where you'd otherwise be guessing at facts. Don't search for things you already know. bash, read, write, edit, glob, grep are available for analysis or computation when materially helpful. Most responses don't need any tools — reach for them only when they meaningfully improve the answer.

GRAPH INTROSPECTION: the conversation is a tree the user branches from — you only see one linear path in CONVERSATION SO FAR. Two custom tools let you peek at the full graph:
- get_graph_summary() returns every turn (id, role, parentId, 240-char preview, emphasis flag) so you can orient.
- get_card(card_id) returns the full content of one turn.
Use these when the user asks about exploration ("what have I tried?", "summarize my branches", "compare these directions"). Don't call them on every turn — only when the question is genuinely about the conversation's shape.

BRANCH SUGGESTIONS: you can also propose new branches the user might explore. Call create_branch(parent_id, prompt) when you see a genuinely unexplored angle — a question their reasoning leaves open, a comparison they haven't made, a counterpoint worth examining. The user sees it as a draft they can accept or dismiss; accepting starts a new branch with that prompt as the user's question. Use sparingly: 0 proposals on most turns, at most 1-2 on turns that genuinely open new doors. Skip it for trivial follow-ups (those belong in your prose). Skip it when the user is mid-thread and just wants the answer. Pick parent_id from the graph — usually the current leaf, sometimes an earlier card if the angle relates more to that.

PERSISTENT MEMORY: a /mnt/memory/${MEMORY_STORE_NAME}/ directory is mounted into your container — files there persist across sessions and across "+ new" conversations. Use the read / write / edit / glob / grep tools to interact with it. At the start of a session, glob the memory dir to see what you remember. Write notes when you learn something durably useful: user preferences, recurring topics, project context, conclusions worth keeping. Don't store secrets, tokens, or one-off chatter. Path each memory deliberately (e.g. /mnt/memory/${MEMORY_STORE_NAME}/preferences/tone.md, /mnt/memory/${MEMORY_STORE_NAME}/topics/kvm-research.md) so future-you can find it.

The user is reading on a card; the conversation is a graph they can branch from. Write so any response stands on its own — they may read it out of order.`;

const client = new Anthropic();

async function ensureEnv() {
  const existingId = process.env.ENV_ID;
  if (existingId) {
    try {
      const env = await client.beta.environments.retrieve(existingId);
      console.log(`✓ Reusing env: ${env.id} (${env.name})`);
      return env.id;
    } catch (err) {
      console.warn(`! ENV_ID ${existingId} not found (${err?.message}); creating fresh.`);
    }
  }
  const env = await client.beta.environments.create({
    name: ENV_NAME,
    config: {
      type: 'cloud',
      // Unrestricted networking: the agent can reach any host. If you want to
      // lock egress, switch to package_managers_and_custom + allowed_hosts.
      networking: { type: 'unrestricted' },
    },
  });
  console.log(`✓ Created env: ${env.id} (${env.name})`);
  return env.id;
}

async function ensureMemoryStore() {
  const existingId = process.env.MEMORY_STORE_ID;
  if (existingId) {
    try {
      const store = await client.beta.memoryStores.retrieve(existingId);
      console.log(`✓ Reusing memory store: ${store.id} (${store.name})`);
      return store.id;
    } catch (err) {
      console.warn(`! MEMORY_STORE_ID ${existingId} not found (${err?.message}); creating fresh.`);
    }
  }
  const store = await client.beta.memoryStores.create({
    name: MEMORY_STORE_NAME,
    description:
      'Long-term memory for river-2: user preferences (tone, formatting, ' +
      'expertise), recurring topics the user explores, durable conclusions ' +
      'worth carrying across sessions. Read at the start of each session; ' +
      'write when something genuinely worth persisting comes up. Skip ' +
      'one-off chatter and never store secrets.',
  });
  console.log(`✓ Created memory store: ${store.id} (${store.name})`);
  return store.id;
}

// Custom tool definitions — graph introspection. The orchestrator (server.js)
// resolves these client-side from the graph snapshot the client sends with
// every /api/generate request.
const CUSTOM_TOOLS = [
  {
    type: 'custom',
    name: 'get_graph_summary',
    description:
      'Returns the full structure of the user\'s conversation as a tree. Each turn lists its id, role (user|assistant), parentId, a 240-character content preview, and emphasis flag. Use this when the user asks about their broader exploration — "what have I tried", "summarize my branches", "compare these directions". You only see one linear path in CONVERSATION SO FAR; this tool reveals branches the user may have explored elsewhere.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    type: 'custom',
    name: 'get_card',
    description:
      'Returns the full content of a single turn (card) by its id. Use after get_graph_summary to fetch the verbatim text of a specific turn the user is asking about.',
    input_schema: {
      type: 'object',
      properties: {
        card_id: {
          type: 'string',
          description: 'The TurnId returned by get_graph_summary.',
        },
      },
      required: ['card_id'],
    },
  },
  {
    type: 'custom',
    name: 'create_branch',
    description:
      'Propose a new branch the user might explore from a specific card. The user sees this as a small draft suggestion they can accept (starts a new branch with that prompt as the user\'s question) or dismiss. Use sparingly — 0 proposals on most turns, at most 1-2 on turns that genuinely open new doors. Skip for trivial follow-ups; skip when the user is mid-thread and just wants the answer. Pick parent_id from the conversation graph; usually the current leaf, sometimes an earlier card if the angle relates more to that.',
    input_schema: {
      type: 'object',
      properties: {
        parent_id: {
          type: 'string',
          description:
            'The card id (TurnId) the new branch should sprout from.',
        },
        prompt: {
          type: 'string',
          description:
            'The branch prompt — phrased as the user\'s next question or move (first person, like a sticky-note label or one short question, ≤120 chars).',
        },
        rationale: {
          type: 'string',
          description:
            'Optional one-line reason for the suggestion, shown to the user as hover. Keep brief.',
        },
      },
      required: ['parent_id', 'prompt'],
    },
  },
];

function buildAgentConfig() {
  return {
    name: AGENT_NAME,
    model: MODEL,
    system: SYSTEM_PROMPT,
    tools: [
      // Full agent toolset: bash, read, write, edit, glob, grep, web_search,
      // web_fetch. The model decides which to use per the system prompt's
      // guidance.
      { type: 'agent_toolset_20260401', default_config: { enabled: true } },
      ...CUSTOM_TOOLS,
    ],
  };
}

async function ensureAgent() {
  const existingId = process.env.AGENT_ID;
  if (existingId) {
    try {
      const existing = await client.beta.agents.retrieve(existingId);
      // Always update — re-running the script after editing the system prompt
      // or tool list should bump the agent to a new version. agents.update
      // requires `version` (optimistic lock against the current state) and
      // appends an immutable new version; sessions using the string-shorthand
      // agent reference automatically pick up the latest.
      const updated = await client.beta.agents.update(existing.id, {
        ...buildAgentConfig(),
        version: existing.version,
      });
      console.log(
        `✓ Updated agent: ${updated.id} (${updated.name}, v${updated.version})`,
      );
      return updated.id;
    } catch (err) {
      console.warn(`! AGENT_ID ${existingId} not found (${err?.message}); creating fresh.`);
    }
  }
  const agent = await client.beta.agents.create(buildAgentConfig());
  console.log(`✓ Created agent: ${agent.id} (${agent.name}, v${agent.version})`);
  return agent.id;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY missing in .env');
    process.exit(1);
  }
  console.log(`Setting up Managed Agent for river-2 (model: ${MODEL})\n`);
  const envId = await ensureEnv();
  const memoryStoreId = await ensureMemoryStore();
  const agentId = await ensureAgent();
  console.log(`\nAdd these to .env (or replace existing entries):\n`);
  console.log(`AGENT_ID=${agentId}`);
  console.log(`ENV_ID=${envId}`);
  console.log(`MEMORY_STORE_ID=${memoryStoreId}`);
}

main().catch((err) => {
  console.error('setup failed:', err?.message ?? err);
  if (err?.error) console.error(err.error);
  process.exit(1);
});
