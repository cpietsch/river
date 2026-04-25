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

async function ensureAgent() {
  const existingId = process.env.AGENT_ID;
  if (existingId) {
    try {
      const agent = await client.beta.agents.retrieve(existingId);
      console.log(`✓ Reusing agent: ${agent.id} (${agent.name}, v${agent.version})`);
      return agent.id;
    } catch (err) {
      console.warn(`! AGENT_ID ${existingId} not found (${err?.message}); creating fresh.`);
    }
  }
  const agent = await client.beta.agents.create({
    name: AGENT_NAME,
    model: MODEL,
    system: SYSTEM_PROMPT,
    tools: [
      // Full agent toolset: bash, read, write, edit, glob, grep, web_search,
      // web_fetch. The model decides which to use per the system prompt's
      // guidance.
      { type: 'agent_toolset_20260401', default_config: { enabled: true } },
    ],
  });
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
  const agentId = await ensureAgent();
  console.log(`\nAdd these to .env (or replace existing entries):\n`);
  console.log(`AGENT_ID=${agentId}`);
  console.log(`ENV_ID=${envId}`);
}

main().catch((err) => {
  console.error('setup failed:', err?.message ?? err);
  if (err?.error) console.error(err.error);
  process.exit(1);
});
