// SPEC-2 §B — Work attribution: every event resolves to exactly one WorkUnit,
// with a confidence ladder: native (explicit or source-recorded branch) >
// joined (timestamp↔git, done by git.js for range blame) > guess (repo
// fallback) > unattributed. Resolution is total: Σ workUnit costs == totals.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function attributesPath() {
  return process.env.BURN_ATTRIBUTES || path.join(os.homedir(), ".burn", "attributes.json");
}

export function loadAttributes() {
  try {
    const p = attributesPath();
    if (!fs.statSync(p).isFile()) return {};
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {}; // unreadable/malformed → attribution falls through the ladder, never fatal
  }
}

export function saveAttribute(session, unitName) {
  const p = attributesPath();
  let attrs = {};
  try {
    if (fs.statSync(p).isFile()) attrs = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    /* start fresh on unreadable file */
  }
  attrs[session] = unitName;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(attrs, null, 2) + "\n");
  return p;
}

// Resolution order per SPEC-2 §B.1
export function resolveUnit(ev, attrs) {
  const explicit =
    (attrs && attrs[`${ev.agent}:${ev.sessionId}`]) || (attrs && attrs[ev.sessionId]) || null;
  if (explicit) return { kind: "unit", name: String(explicit), confidence: "native" };
  if (ev.gitBranch) return { kind: "branch", name: ev.gitBranch, confidence: "native" };
  if (ev.repo && ev.repo !== "(unknown)") return { kind: "repo", name: ev.repo, confidence: "guess" };
  return { kind: "unattributed", name: "(unattributed)", confidence: "unattributed" };
}
