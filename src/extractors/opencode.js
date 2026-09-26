import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { repoFromDir } from "../util.js";

export const label = "opencode";

// OpenCode persists everything in a single SQLite db:
//   ~/.local/share/opencode/opencode.db
// The `session` table already holds a real, billed `cost` plus a full token
// breakdown, so OpenCode is our ground-truth source (no estimation needed).

function dbPath() {
  return (
    process.env.BURN_OPENCODE_DB ||
    path.join(os.homedir(), ".local", "share", "opencode", "opencode.db")
  );
}
export const rootPath = dbPath;

export function available() {
  try {
    return fs.statSync(dbPath()).isFile();
  } catch {
    return false;
  }
}

function parseModel(raw) {
  if (!raw) return "unknown";
  try {
    const m = JSON.parse(raw);
    return m.id || m.model || raw;
  } catch {
    return raw;
  }
}

function day(ms) {
  const d = new Date(Number(ms));
  return Number.isNaN(d.getTime()) ? "unknown" : d.toISOString().slice(0, 10);
}

export async function* extract() {
  if (!available()) return;
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return; // node < 22.5 — degrade gracefully, opencode rows just won't appear
  }
  let db;
  try {
    db = new DatabaseSync(dbPath(), { readOnly: true });
  } catch {
    return; // locked or unreadable — skip rather than crash the whole ledger
  }
  try {
    const rows = db
      .prepare(
        `select id, directory, model, cost,
                tokens_input, tokens_output, tokens_reasoning,
                tokens_cache_read, tokens_cache_write, time_created
           from session`
      )
      .all();
    for (const r of rows) {
      yield {
        agent: "opencode",
        sessionId: r.id,
        model: parseModel(r.model),
        dir: r.directory || null,
        repo: repoFromDir(r.directory),
        gitBranch: null,
        ts: Number(r.time_created) || null,
        date: day(r.time_created),
        tokens: {
          input: r.tokens_input || 0,
          output: r.tokens_output || 0,
          cacheWrite: r.tokens_cache_write || 0,
          cacheRead: r.tokens_cache_read || 0,
          reasoning: r.tokens_reasoning || 0,
        },
        storedCost: Number.isFinite(r.cost) ? r.cost : null,
      };
    }
  } finally {
    db.close();
  }
}
