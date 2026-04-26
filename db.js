// Server-side persistent canvas state. SQLite single-file at ./data/river.db.
//
// Source of truth for: projects, their turns, links, and pending
// proposals. The active session id (Anthropic Managed Agent) lives on
// the project row alongside the canvas. The client mirrors active-canvas
// state into a zustand store for fast local reads + UI reactivity, and
// hydrates from the server on mount + per-mutation WebSocket broadcasts.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'river.db');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

ensureDataDir();
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Schema. Re-running is safe; CREATE TABLE IF NOT EXISTS is idempotent.
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT 'untitled canvas',
    agent_id TEXT,
    session_id TEXT,
    wake_intent TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS turns (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL DEFAULT '',
    parent_id TEXT,
    emphasis INTEGER NOT NULL DEFAULT 1,
    streaming INTEGER NOT NULL DEFAULT 0,
    meta TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_turns_project ON turns(project_id);
  CREATE INDEX IF NOT EXISTS idx_turns_parent ON turns(parent_id);

  CREATE TABLE IF NOT EXISTS links (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_links_project ON links(project_id);

  CREATE TABLE IF NOT EXISTS proposals (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    parent_id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    rationale TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_proposals_project ON proposals(project_id);
`);


// ── Project queries ──────────────────────────────────────────────────────

const stmtListProjects = db.prepare(
  `SELECT id, name, agent_id AS agentId, session_id AS sessionId,
          wake_intent AS wakeIntent,
          created_at AS createdAt, updated_at AS updatedAt
   FROM projects
   ORDER BY updated_at DESC`,
);

const stmtGetProject = db.prepare(
  `SELECT id, name, agent_id AS agentId, session_id AS sessionId,
          wake_intent AS wakeIntent,
          created_at AS createdAt, updated_at AS updatedAt
   FROM projects WHERE id = ?`,
);

const stmtSetProjectWakeIntent = db.prepare(
  `UPDATE projects SET wake_intent = ?, updated_at = ? WHERE id = ?`,
);

const stmtInsertProject = db.prepare(
  `INSERT INTO projects (id, name, agent_id, session_id, created_at, updated_at)
   VALUES (@id, @name, @agentId, @sessionId, @createdAt, @updatedAt)`,
);

const stmtSetProjectAgent = db.prepare(
  `UPDATE projects SET agent_id = ?, updated_at = ? WHERE id = ?`,
);

const stmtUpdateProject = db.prepare(
  `UPDATE projects SET name = @name, session_id = @sessionId,
          updated_at = @updatedAt
   WHERE id = @id`,
);

const stmtTouchProject = db.prepare(
  `UPDATE projects SET updated_at = ? WHERE id = ?`,
);

const stmtSetProjectSession = db.prepare(
  `UPDATE projects SET session_id = ?, updated_at = ? WHERE id = ?`,
);

const stmtSetProjectName = db.prepare(
  `UPDATE projects SET name = ?, updated_at = ? WHERE id = ?`,
);

const stmtDeleteProject = db.prepare(`DELETE FROM projects WHERE id = ?`);

// ── Turn queries ─────────────────────────────────────────────────────────

const stmtListTurns = db.prepare(
  `SELECT id, project_id AS projectId, role, content, parent_id AS parentId,
          emphasis, streaming, meta, created_at AS createdAt
   FROM turns WHERE project_id = ? ORDER BY created_at ASC`,
);

const stmtInsertTurn = db.prepare(
  `INSERT INTO turns (id, project_id, role, content, parent_id, emphasis,
                      streaming, meta, created_at)
   VALUES (@id, @projectId, @role, @content, @parentId, @emphasis,
           @streaming, @meta, @createdAt)`,
);

const stmtUpdateTurn = db.prepare(
  `UPDATE turns SET content = @content, emphasis = @emphasis,
          streaming = @streaming, meta = @meta WHERE id = @id`,
);

const stmtDeleteTurn = db.prepare(`DELETE FROM turns WHERE id = ?`);

// ── Link queries ─────────────────────────────────────────────────────────

const stmtListLinks = db.prepare(
  `SELECT id, project_id AS projectId, from_id AS fromId, to_id AS toId,
          kind, created_at AS createdAt
   FROM links WHERE project_id = ?`,
);

const stmtInsertLink = db.prepare(
  `INSERT INTO links (id, project_id, from_id, to_id, kind, created_at)
   VALUES (@id, @projectId, @fromId, @toId, @kind, @createdAt)`,
);

const stmtDeleteLink = db.prepare(`DELETE FROM links WHERE id = ?`);

// ── Proposal queries ─────────────────────────────────────────────────────

const stmtListProposals = db.prepare(
  `SELECT id, project_id AS projectId, parent_id AS parentId, prompt,
          rationale, created_at AS createdAt
   FROM proposals WHERE project_id = ?`,
);

const stmtInsertProposal = db.prepare(
  `INSERT INTO proposals (id, project_id, parent_id, prompt, rationale,
                          created_at)
   VALUES (@id, @projectId, @parentId, @prompt, @rationale, @createdAt)`,
);

const stmtDeleteProposal = db.prepare(`DELETE FROM proposals WHERE id = ?`);

// ── Public API ───────────────────────────────────────────────────────────

export function listProjects() {
  return stmtListProjects.all();
}

export function getProject(id) {
  return stmtGetProject.get(id);
}

export function createProject({ id, name, agentId = null, sessionId = null }) {
  const now = Date.now();
  stmtInsertProject.run({
    id,
    name: name ?? 'untitled canvas',
    agentId,
    sessionId,
    createdAt: now,
    updatedAt: now,
  });
  return getProject(id);
}

export function setProjectAgent(id, agentId) {
  stmtSetProjectAgent.run(agentId, Date.now(), id);
}

export function renameProject(id, name) {
  stmtSetProjectName.run(name, Date.now(), id);
}

export function setProjectSession(id, sessionId) {
  stmtSetProjectSession.run(sessionId, Date.now(), id);
}

export function setProjectWakeIntent(id, wakeIntent) {
  stmtSetProjectWakeIntent.run(wakeIntent ?? '', Date.now(), id);
}

export function touchProject(id) {
  stmtTouchProject.run(Date.now(), id);
}

export function deleteProject(id) {
  stmtDeleteProject.run(id);
}

export function listTurns(projectId) {
  const rows = stmtListTurns.all(projectId);
  return rows.map(rowToTurn);
}

export function getProjectState(id) {
  const project = getProject(id);
  if (!project) return null;
  return {
    project,
    turns: listTurns(id),
    links: stmtListLinks.all(id),
    proposals: stmtListProposals.all(id),
  };
}

export function upsertTurn(turn) {
  // INSERT OR REPLACE semantics — used both for fresh creation and edits.
  // updates touch the project's updatedAt timestamp.
  const meta = JSON.stringify(turn.meta ?? {});
  const existing = db.prepare(`SELECT id FROM turns WHERE id = ?`).get(turn.id);
  if (existing) {
    stmtUpdateTurn.run({
      id: turn.id,
      content: turn.content ?? '',
      emphasis: turn.emphasis ?? 1,
      streaming: turn.streaming ? 1 : 0,
      meta,
    });
  } else {
    stmtInsertTurn.run({
      id: turn.id,
      projectId: turn.projectId,
      role: turn.role,
      content: turn.content ?? '',
      parentId: turn.parentId ?? null,
      emphasis: turn.emphasis ?? 1,
      streaming: turn.streaming ? 1 : 0,
      meta,
      createdAt: turn.createdAt ?? Date.now(),
    });
  }
  if (turn.projectId) touchProject(turn.projectId);
}

export function deleteTurn(turnId, projectId) {
  stmtDeleteTurn.run(turnId);
  if (projectId) touchProject(projectId);
}

export function deleteSubtree(rootId, projectId) {
  // Cascading subtree delete keyed by parent_id. Walks the tree to find
  // descendants, then deletes in one transaction.
  const all = stmtListTurns.all(projectId);
  const children = new Map();
  for (const t of all) {
    if (!children.has(t.parentId)) children.set(t.parentId, []);
    children.get(t.parentId).push(t.id);
  }
  const removed = new Set();
  const queue = [rootId];
  while (queue.length) {
    const cur = queue.shift();
    if (removed.has(cur)) continue;
    removed.add(cur);
    for (const c of children.get(cur) ?? []) queue.push(c);
  }
  const tx = db.transaction((ids) => {
    for (const id of ids) stmtDeleteTurn.run(id);
  });
  tx(Array.from(removed));
  touchProject(projectId);
  return Array.from(removed);
}

export function addLink(link) {
  stmtInsertLink.run({
    id: link.id,
    projectId: link.projectId,
    fromId: link.fromId,
    toId: link.toId,
    kind: link.kind,
    createdAt: link.createdAt ?? Date.now(),
  });
  touchProject(link.projectId);
}

export function removeLink(linkId, projectId) {
  stmtDeleteLink.run(linkId);
  if (projectId) touchProject(projectId);
}

export function addProposal(proposal) {
  stmtInsertProposal.run({
    id: proposal.id,
    projectId: proposal.projectId,
    parentId: proposal.parentId,
    prompt: proposal.prompt,
    rationale: proposal.rationale ?? '',
    createdAt: proposal.createdAt ?? Date.now(),
  });
  touchProject(proposal.projectId);
}

export function removeProposal(proposalId, projectId) {
  stmtDeleteProposal.run(proposalId);
  if (projectId) touchProject(projectId);
}

function rowToTurn(row) {
  let meta = {};
  try {
    meta = JSON.parse(row.meta);
  } catch {
    meta = {};
  }
  return {
    id: row.id,
    projectId: row.projectId,
    role: row.role,
    content: row.content,
    parentId: row.parentId,
    emphasis: row.emphasis,
    streaming: row.streaming === 1,
    meta,
    createdAt: row.createdAt,
  };
}

export { db };
