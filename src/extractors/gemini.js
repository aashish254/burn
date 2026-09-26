import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { repoFromDir } from "../util.js";

export const label = "gemini-cli";

// Gemini CLI (github.com/google-gemini/gemini-cli) records chats as JSONL under:
//   ~/.gemini/tmp/<projectSlug>/chats/session-<ts>-<id8>.jsonl
// Root is $GEMINI_CONFIG_DIR else ~/.gemini (storage.ts:getProjectTempDir).
// Format verified against core/src/services/chatRecording*.ts: first line is a
// ConversationRecord (sessionId + workspace `directories`); later lines are
// MessageRecords with an optional `tokens` block from the API usageMetadata.
// No dollars and no git branch are stored, so cost is estimated and attribution
// falls back to the repo (from `directories`) — never a fabricated branch.
//
// Normalized event shape (SPEC §5):
// { agent, sessionId, model, repo, dir, date, tokens:{...}, gitBranch:null, ts, storedCost:null }

function geminiRoot() {
  if (process.env.BURN_GEMINI_DIR) return process.env.BURN_GEMINI_DIR;
  const base = process.env.GEMINI_CONFIG_DIR || path.join(os.homedir(), ".gemini");
  return path.join(base, "tmp");
}
export const rootPath = geminiRoot;

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
    return fs.statSync(geminiRoot()).isDirectory();
  } catch {
    return false;
  }
}

function usageTokens(t) {
  // Gemini reports `input` as the full prompt count INCLUDING `cached`, so the
  // billable fresh-input slice is input − cached; `tool` tokens bill at the
  // input rate on top. Map without double counting.
  const cached = t.cached || 0;
  return {
    input: Math.max(0, (t.input || 0) - cached) + (t.tool || 0),
    output: t.output || 0,
    cacheWrite: 0, // Gemini's usageMetadata has no explicit cache-write bucket
    cacheRead: cached,
    reasoning: t.thoughts || 0,
  };
}

export function* extract() {
  if (!available()) return;
  const files = walkJsonl(geminiRoot(), []);
  for (const file of files) {
    const fallbackId = path.basename(file, ".jsonl").replace(/^session-/, "");
    let buf;
    try {
      buf = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let sessionId = fallbackId;
    let dir = null;
    let repo = "(unknown)";
    for (const line of buf.split("\n")) {
      if (!line.trim()) continue;
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        continue; // tolerate any malformed line
      }
      // ConversationRecord metadata: seed session id + workspace directory.
      if (d.sessionId || d.directories) {
        if (d.sessionId) sessionId = d.sessionId;
        const dirs = d.directories;
        if (Array.isArray(dirs) && dirs.length) {
          dir = dirs[0];
          repo = repoFromDir(dir);
        }
        continue;
      }
      // MessageRecord: only assistant turns carry a tokens block.
      const tokens = d.tokens;
      if (!tokens) continue;
      const model = d.model || "unknown";
      const ts = d.timestamp ? Date.parse(d.timestamp) : null;
      yield {
        agent: "gemini-cli",
        sessionId,
        model,
        dir,
        repo,
        gitBranch: null, // not persisted by Gemini CLI — do not invent one
        ts,
        date: (d.timestamp || "").slice(0, 10) || "unknown",
        tokens: usageTokens(tokens),
        storedCost: null,
      };
    }
  }
}
