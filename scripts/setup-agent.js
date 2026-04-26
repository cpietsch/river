// Provision the Managed Agent + Environment + Memory Store that powers
// /api/generate, applying scripts/agent.yml as the source of truth for
// the agent's model + system prompt + tools.
//
// Run:
//   npm run setup-agent
//
// What it does (idempotent):
//   1. Reuses the env at ENV_ID if present, otherwise creates "river-2-env".
//   2. Reuses the memory store at MEMORY_STORE_ID, otherwise creates
//      "river-2-memory".
//   3. Loads scripts/agent.yml, applies it to the agent at AGENT_ID
//      (creates one if missing). Each apply bumps the agent to a new
//      version; sessions reference latest by default.
//
// Edit the YAML to change the system prompt or tools. Use
// MAIN_MODEL=claude-sonnet-4-6 npm run setup-agent to override the model
// without editing the YAML.

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import yaml from 'yaml';
import Anthropic from '@anthropic-ai/sdk';

const SCRIPT_DIR = path.dirname(url.fileURLToPath(import.meta.url));
const AGENT_YAML = path.join(SCRIPT_DIR, 'agent.yml');
const ENV_NAME = 'river-2-env';
const MEMORY_STORE_NAME = 'river-2-memory';

const client = new Anthropic();

/**
 * Read scripts/agent.yml as the canonical agent config. Optional MAIN_MODEL
 * env override flips the model without editing the YAML — useful for
 * comparing Sonnet vs Opus side-by-side.
 */
function loadAgentConfig() {
  const raw = fs.readFileSync(AGENT_YAML, 'utf8');
  const parsed = yaml.parse(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`scripts/agent.yml did not parse to an object`);
  }
  if (process.env.MAIN_MODEL) {
    // Preserve the model object shape ({id, speed}) when overriding.
    if (parsed.model && typeof parsed.model === 'object') {
      parsed.model = { ...parsed.model, id: process.env.MAIN_MODEL };
    } else {
      parsed.model = process.env.MAIN_MODEL;
    }
  }
  return parsed;
}

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
      // Unrestricted networking: the agent can reach any host. If you want
      // to lock egress, switch to package_managers_and_custom + allowed_hosts.
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
      'Long-term memory for river: user preferences (tone, formatting, ' +
      'expertise), recurring topics the user explores, durable conclusions ' +
      'worth carrying across sessions. Read at the start of each session; ' +
      'write when something genuinely worth persisting comes up. Skip ' +
      'one-off chatter and never store secrets.',
  });
  console.log(`✓ Created memory store: ${store.id} (${store.name})`);
  return store.id;
}

async function ensureAgent(config) {
  const existingId = process.env.AGENT_ID;
  if (existingId) {
    try {
      const existing = await client.beta.agents.retrieve(existingId);
      // Always apply the YAML — re-running the script after editing
      // agent.yml bumps the agent to a new immutable version. Sessions
      // using the string-shorthand agent reference automatically pick up
      // the latest. agents.update requires the current `version` for
      // optimistic locking.
      const updated = await client.beta.agents.update(existing.id, {
        ...config,
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
  const agent = await client.beta.agents.create(config);
  console.log(`✓ Created agent: ${agent.id} (${agent.name}, v${agent.version})`);
  return agent.id;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY missing in .env');
    process.exit(1);
  }
  const config = loadAgentConfig();
  const modelDesc =
    typeof config.model === 'string'
      ? config.model
      : `${config.model?.id ?? '?'}${config.model?.speed ? ' · ' + config.model.speed : ''}`;
  console.log(`Setting up Managed Agent for river (${modelDesc})\n`);
  const envId = await ensureEnv();
  const memoryStoreId = await ensureMemoryStore();
  const agentId = await ensureAgent(config);
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
