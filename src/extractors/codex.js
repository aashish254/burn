import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { repoFromDir } from "../util.js";

export const label = "codex";

// Codex CLI (github.com/openai/codex) writes one rollout JSONL per thread under:
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<threadId>.jsonl
//   (also ~/.codex/archived_sessions/; root is $CODEX_HOME else ~/.codex)
// Format verified against codex-rs source (rollout/src/recorder.rs,
// protocol/src/protocol.rs). Lines are tagged by "type"; usage arrives as an
// event_msg whose payload.type is "token_count". No dollars are stored — cost
// is estimated from the pricing table, and unpriced models report tokens only.
//
// Normalized event shape (extractor contract):
// { agent, sessionId, model, repo, dir, date, tokens:{...}, gitBranch, ts, storedCost }

function codexRoot() {
  if (process.env.BURN_CODEX_DIR) return process.env.BURN_CODEX_DIR;
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
}
export const rootPath = codexRoot;

function walkJsonl(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJsonl(p, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

export function available() {
  try {
    return fs.statSync(codexRoot()).isDirectory();
  } catch {
    return false;
  }
}

// Codex TokenUsage (protocol.rs:2239) follows OpenAI usage semantics:
// input_tokens is the FULL prompt count, with cached/write as subsets of it.
// Bill fresh input first so pricing never double-counts the cached slice.
function usageTokens(u) {
  const cached = u.cached_input_tokens || 0;
  const write = u.cache_write_input_tokens || 0;
  return {
    input: Math.max(0, (u.input_tokens || 0) - cached - write),
    output: u.output_tokens || 0,
    cacheWrite: write,
    cacheRead: cached,
    reasoning: u.reasoning_output_tokens || 0,
  };
}

export function* extract() {
  if (!available()) return;
  const files = walkJsonl(codexRoot(), []);
  for (const file of files) {
    const threadId = path.basename(file).replace(/^rollout-/, "").replace(/\.jsonl$/, "");
    let buf;
    try {
      buf = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // Session-scoped context gathered from earlier lines in file order.
    let sessionId = threadId;
    let dir = null;
    let repo = "(unknown)";
    let gitBranch = null;
    let model = "unknown";
    for (const line of buf.split("\n")) {
      if (!line.trim()) continue;
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        continue; // tolerate any malformed line
      }
      const payload = d.payload || {};
      if (d.type === "session_meta") {
        sessionId = payload.session_id || payload.id || sessionId;
        dir = payload.cwd || dir;
        if (dir) repo = repoFromDir(dir);
        const git = payload.git || (payload.history && payload.history.git) || null;
        if (git && git.branch) gitBranch = git.branch;
      } else if (d.type === "turn_context") {
        if (payload.model) model = payload.model;
        if (payload.cwd) {
          dir = payload.cwd;
          repo = repoFromDir(dir);
        }
      } else if (d.type === "event_msg" && payload.type === "token_count") {
        const info = payload.info || {};
        const usage = info.last_token_usage || info.total_token_usage;
        if (!usage) continue;
        const ts = d.timestamp ? Date.parse(d.timestamp) : null;
        yield {
          agent: "codex",
          sessionId,
          model,
          dir,
          repo,
          gitBranch, // native attribution when Codex recorded the branch
          ts,
          date: (d.timestamp || "").slice(0, 10) || "unknown",
          tokens: usageTokens(usage),
          storedCost: null, // Codex transcripts never store dollars
        };
      }
    }
  }
}
