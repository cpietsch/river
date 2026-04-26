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
const MODEL = process.env.MAIN_MODEL ?? 'claude-opus-4-7';

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

TOOL USE: web_search and web_fetch are SLOW (5-15 seconds per call) and the user feels every second. Treat them as a last resort, not a first reach. Default: answer from your own knowledge. Reach for web_search ONLY when ALL of these hold:
1. The question is explicitly about something dated, recent, or post-2024 — names, prices, version numbers, release dates, current events.
2. You would otherwise be guessing at a fact (not just polishing an answer with extra detail).
3. A wrong factual answer would meaningfully mislead the user — not a low-stakes "nice to confirm".
For everything else — concepts, tradeoffs, comparisons, reasoning, code patterns, history, math, opinions, walkthroughs — answer from what you know. The user prefers a confident, fast answer with a caveat ("specifics may have moved since my training") over a slow grounded one. If you're unsure whether to search: don't.

bash, read, write, edit, glob, grep are available for analysis or computation when materially helpful. Most responses don't need any tools.

GRAPH INTROSPECTION: the conversation is a tree the user branches from — you only see one linear path in CONVERSATION SO FAR. Two custom tools let you peek at the full graph:
- get_graph_summary() returns every turn (id, role, parentId, 240-char preview, emphasis flag) so you can orient.
- get_card(card_id) returns the full content of one turn.
Use these when the user asks about exploration ("what have I tried?", "summarize my branches", "compare these directions"). Don't call them on every turn — only when the question is genuinely about the conversation's shape.

BRANCH SUGGESTIONS: you can also propose new branches the user might explore. Call create_branch(parent_id, prompt) when you see a genuinely unexplored angle — a question their reasoning leaves open, a comparison they haven't made, a counterpoint worth examining. The user sees it as a draft they can accept or dismiss; accepting starts a new branch with that prompt as the user's question. Use sparingly: 0 proposals on most turns, at most 1-2 on turns that genuinely open new doors. Skip it for trivial follow-ups (those belong in your prose). Skip it when the user is mid-thread and just wants the answer. Pick parent_id from the graph — usually the current leaf, sometimes an earlier card if the angle relates more to that.

FLAGGING IMPORTANT CARDS: call flag_card(card_id, reason) when you (or the user just now) landed on a turning-point insight — a critical claim, a load-bearing decision, a counter-intuitive finding, the kind of card the user will want to find again later. The user sees the card emphasized on the canvas with your reason on hover. Aim for ~0-1 flags per turn; on turns where the prior assistant card or the current user message contains a genuinely pivotal insight, flag it. Don't flag every interesting card — flag the ones that change how the user should think going forward. Pick card_id from the BRANCH PATH or get_graph_summary; never invent ids. Frequently the right card to flag is the most recent assistant turn (not the user's question).

LATERAL LINKS BETWEEN CARDS: when you spot a relationship between two existing cards that the parent → child structure can't express — one card answers a question raised in another, contradicts a prior decision, elaborates an earlier claim — call link_cards(from_id, to_id, kind) to draw a dashed connection between them on the canvas. The user sees latent structure they might've missed. Use only when the relationship is real and useful; skip the trivial ones (every card "elaborates" its parent already, that's the parent edge). Pick ids from get_graph_summary or BRANCH PATH; never invent. kind is a short label (≤30 chars): "answers", "contradicts", "elaborates", "compares with", "supersedes" — pick what fits.

REFINING EXISTING CARDS: when the user gives feedback on a specific card you wrote earlier ("make #3 punchier", "soften that opening", "rewrite the third intro to lead with the user feeling"), call edit_card(card_id, content) to rewrite it in place. DO NOT create a new card with create_card for refinements — that'd duplicate the original. The edited card replaces the prior content; chip spans regenerate automatically. Pick the card_id from get_graph_summary. NEVER edit user cards (their questions are theirs); only edit cards you generated.

PRESENTING OPTIONS: when your response asks the user to pick from a discrete set (which project? which framework? quick vs careful?), call present_options(card_id, options) so the user gets tappable pills under your card. Each pill, when tapped, becomes the user's next message — they don't have to retype "the transit table" themselves. card_id is YOUR RESPONSE CARD. options is an array of 2-6 short strings (≤40 chars each), in the same wording you'd want them to appear as pills. Skip when:
- The choice is binary and obvious from the prose.
- The "options" are open-ended ("anything you've been chewing on") — pills imply a closed set.
- You're not actually asking for a pick.
You can still mention the options in prose; the pills are an additional affordance, not a replacement.

WORKING ON THE CANVAS — CREATING CARDS DIRECTLY: when the user's request naturally produces multiple distinct outputs, materialize each as its own card via create_card(parent_id, content). Examples that should split:
- "rewrite each of these 5 intros" → one card per intro
- "give me 3 options for X" → one card per option
- "compare these 4 frameworks" → one card per framework
- "draft questions for each section" → one card per question
- "summarize each project" → one card per project
The streaming prose you're writing right now becomes the *header* card (a brief 1-2 sentence summary like "Here are 5 project intros — one per card below."). DO NOT duplicate the per-item content in your prose; the cards carry it.

Each create_card call returns the new card id, so you can chain — e.g., flag the most important one with flag_card after creating, or refer back to ids in your prose.

When NOT to use create_card:
- Single-answer questions (your prose IS the answer).
- Comparisons that fit naturally in a small markdown table.
- Vague or tentative outputs that aren't worth committing to the canvas as separate artifacts.

Pass parent_id = the YOUR RESPONSE CARD id (provided in the kickoff). That puts the new cards as children under your streaming response, which is almost always what the user wants. If you want sibling cards under the user's question instead, pass that question's id (also in BRANCH PATH).

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
    name: 'create_card',
    description:
      'Materialize a new card on the canvas with given content. Use when the user\'s request naturally produces multiple distinct outputs — one card per item, intro, option, comparison row, or section. The new card becomes a child of parent_id. Returns the new card id so you can chain (flag it, reference it in your prose, parent further cards under it, etc). When you create cards, your streaming prose response should be a brief header summary (1-2 sentences) — do NOT duplicate the per-item content in prose AND in cards.',
    input_schema: {
      type: 'object',
      properties: {
        parent_id: {
          type: 'string',
          description:
            'The card id (TurnId, format "shape:abc123") to parent the new card under. Almost always YOUR RESPONSE CARD (provided in the kickoff). NEVER invent ids — pick from BRANCH PATH or get_graph_summary. The call will be rejected if the id is unknown.',
        },
        content: {
          type: 'string',
          description:
            'The full text content of the card. Markdown-formatted: **bold** and *italic* for light emphasis, paragraph breaks via blank line. NO bullet lists, NO headers, NO code fences, NO links — same formatting rules as your normal prose. Length: ideally fits on a card (60-300 words); much longer than that and the card becomes unwieldy.',
        },
        role: {
          type: 'string',
          enum: ['user', 'assistant'],
          description:
            'Default "assistant" — the card is treated as a model output. Use "user" only when the card represents a question or prompt for the user (rare; usually create_branch is the better choice for that).',
        },
      },
      required: ['parent_id', 'content'],
    },
  },
  {
    type: 'custom',
    name: 'link_cards',
    description:
      'Draw a lateral connection between two cards beyond the parent → child tree. The UI renders it as a dashed arrow. Use when one card answers a question in another, contradicts a prior decision, elaborates an earlier claim, supersedes a stale conclusion, or otherwise has a relationship the tree can\'t express. Skip trivial elaborations (every card "elaborates" its parent already — that\'s the parent edge). Both ids must be real cards from the graph.',
    input_schema: {
      type: 'object',
      properties: {
        from_id: {
          type: 'string',
          description: 'Source card id (format "shape:abc123").',
        },
        to_id: {
          type: 'string',
          description: 'Target card id (format "shape:abc123"). Different from from_id.',
        },
        kind: {
          type: 'string',
          description:
            'Short label for the relationship (≤30 chars): "answers", "contradicts", "elaborates", "compares with", "supersedes", or any other concise verb. The arrow direction is from → to.',
        },
      },
      required: ['from_id', 'to_id', 'kind'],
    },
  },
  {
    type: 'custom',
    name: 'edit_card',
    description:
      'Rewrite an existing card in place. Use ONLY when the user asks you to refine, soften, punch up, or otherwise revise something you wrote earlier. The card\'s content is replaced; chip spans regenerate. NEVER edit user cards (their questions are theirs). Pick card_id from get_graph_summary or BRANCH PATH; format "shape:abc123". The call will be rejected if the id doesn\'t exist or the card is a user card.',
    input_schema: {
      type: 'object',
      properties: {
        card_id: {
          type: 'string',
          description:
            'The assistant card id to rewrite. Format "shape:abc123". Must be a card you generated; user cards are off-limits.',
        },
        content: {
          type: 'string',
          description:
            'The full replacement text. Markdown-formatted same as a normal response: **bold**, *italic*, paragraph breaks, no bullet lists / headers / code fences / links.',
        },
      },
      required: ['card_id', 'content'],
    },
  },
  {
    type: 'custom',
    name: 'present_options',
    description:
      'Attach a list of tappable pill-options to a card so the user can pick one without retyping. Use ONLY when your prose explicitly asks the user to choose from a discrete, closed set (which project, which framework, which option). Each pill becomes the user\'s next message verbatim when tapped. Skip for open-ended questions and for binary yes/no questions where prose is enough.',
    input_schema: {
      type: 'object',
      properties: {
        card_id: {
          type: 'string',
          description:
            'The card id to attach options to — usually YOUR RESPONSE CARD (provided in the kickoff). Format "shape:abc123". NEVER invent ids.',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Array of 2-6 short pill labels (≤ ~40 chars each). Phrased the way the option should appear as the user\'s next message — first person if the user is speaking, otherwise the literal choice ("the transit table", "the museum scale piece", etc).',
          minItems: 2,
          maxItems: 6,
        },
      },
      required: ['card_id', 'options'],
    },
  },
  {
    type: 'custom',
    name: 'flag_card',
    description:
      'Mark a card as important — a turning point, critical insight, load-bearing decision, or counter-intuitive finding the user will want to find again. The card is shown emphasized on the canvas; the reason appears on hover. Use VERY sparingly: 0 on most turns, 1 max on turns with a genuine pivot. Flagging too many cards turns the signal into noise.',
    input_schema: {
      type: 'object',
      properties: {
        card_id: {
          type: 'string',
          description:
            'The card id, in the exact format "shape:abc123def" (lowercase prefix "shape:" then alphanumeric). Get valid ids from the BRANCH PATH section of your latest user message or by calling get_graph_summary. NEVER invent placeholder ids — the call will be rejected.',
        },
        reason: {
          type: 'string',
          description:
            'One short sentence explaining why this card matters — shown to the user on hover. Be specific (≤140 chars).',
        },
      },
      required: ['card_id', 'reason'],
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
            'The card id of the existing turn to sprout the branch from. MUST be a real id from the graph, in the exact format "shape:abc123def" (lowercase prefix "shape:" then alphanumeric chars). Get valid ids from the BRANCH PATH section of your latest user message, or by calling get_graph_summary. NEVER invent placeholder values like "ROOT", "current", or numeric ids — the call will be rejected. If you don\'t have a concrete id available, call get_graph_summary first.',
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
