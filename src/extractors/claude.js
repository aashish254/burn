import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { repoFromDir } from "../util.js";

export const label = "claude-code";

// Claude Code keeps one JSONL transcript per session under:
//   ~/.claude/projects/<encoded-project>/<session-id>.jsonl
// Assistant turns carry a `message.usage` block with token counts (no dollars).
//
// Normalized event shape emitted by every extractor:
// { agent, sessionId, model, repo, dir, date, tokens:{input,output,cacheWrite,cacheRead,reasoning}, storedCost }

function claudeRoot() {
  return process.env.BURN_CLAUDE_DIR || path.join(os.homedir(), ".claude", "projects");
}
export const rootPath = claudeRoot;

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
    return fs.statSync(claudeRoot()).isDirectory();
  } catch {
    return false;
  }
}

export function* extract() {
  if (!available()) return;
  const files = walkJsonl(claudeRoot(), []);
  for (const file of files) {
    const sessionId = path.basename(file, ".jsonl");
    let buf;
    try {
      buf = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of buf.split("\n")) {
      if (!line.trim()) continue;
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        continue; // tolerate any malformed line
      }
      if (d.type !== "assistant") continue;
      const msg = d.message || {};
      const usage = msg.usage;
      if (!usage) continue;
      const model = msg.model || "unknown";
      if (model === "<synthetic>") continue;
      yield {
        agent: "claude-code",
        sessionId,
        model,
        dir: d.cwd || null,
        repo: repoFromDir(d.cwd),
        gitBranch: d.gitBranch || null, // native attribution
        ts: d.timestamp ? Date.parse(d.timestamp) : null, // ms epoch, for range joins
        date: (d.timestamp || "").slice(0, 10) || "unknown",
        tokens: {
          input: usage.input_tokens || 0,
          output: usage.output_tokens || 0,
          cacheWrite: usage.cache_creation_input_tokens || 0,
          cacheRead: usage.cache_read_input_tokens || 0,
          reasoning: usage.output_tokens_details?.thinking_tokens || 0,
        },
        storedCost: null, // Claude transcripts store tokens, not dollars
      };
    }
  }
}
