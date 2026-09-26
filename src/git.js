// Read-only git joiner for commit-range blame.
// Only ever runs `git log` (never lock/fetch/write), silently skips anything
// that is not a readable repo, and never lets a ref look like a flag.

import { spawnSync } from "node:child_process";

const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._\/+@^{}~-]*$/;

export function revTime(dir, ref) {
  if (!dir || !SAFE_REF.test(ref)) return null;
  const r = spawnSync("git", ["-C", dir, "log", "-1", "--format=%ct", ref], {
    encoding: "utf8",
    timeout: 3000,
  });
  if (r.status !== 0) return null; // not a repo, unknown ref, no git — all silent skips
  const t = parseInt((r.stdout || "").trim(), 10);
  return Number.isFinite(t) ? t : null;
}

// Doctor R-6: how many commits a repo shows inside a date window.
// Read-only (`git log`), null on any failure (not a repo, no history, no git)
// so callers silently skip. Dates are validated to look like dates, never
// flags.
export function commitCount(dir, sinceDate, untilDate) {
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  if (!dir || !ISO.test(sinceDate) || !ISO.test(untilDate)) return null;
  const r = spawnSync("git", ["-C", dir, "log", "--oneline", `--since=${sinceDate}T00:00:00`, `--until=${untilDate}T23:59:59`], {
    encoding: "utf8",
    timeout: 3000,
  });
  if (r.status !== 0) return null;
  return r.stdout.trim() === "" ? 0 : r.stdout.trim().split("\n").length;
}
// Aggregate raw events whose timestamps fall in the (earlier, later] window of
// two revs inside their own repo. Confidence of every matched row: "joined".
export function blameRange(events, refA, refB) {
  const byDir = new Map();
  for (const ev of events) {
    if (!ev.dir || ev.ts == null) continue;
    if (!byDir.has(ev.dir)) byDir.set(ev.dir, []);
    byDir.get(ev.dir).push(ev);
  }
  const rows = [];
  for (const [dir, evs] of byDir) {
    const tA = revTime(dir, refA);
    const tB = revTime(dir, refB);
    if (tA == null || tB == null || tA === tB) continue;
    const [lo, hi] = tA < tB ? [tA, tB] : [tB, tA];
    const matched = evs.filter((e) => e.ts > lo * 1000 && e.ts <= hi * 1000);
    if (!matched.length) continue;
    const row = {
      repo: evs[0].repo,
      events: 0,
      cost: 0,
      tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, reasoning: 0 },
      confidence: "joined",
      window: [lo, hi],
    };
    for (const e of matched) {
      row.events++;
      if (typeof e.cost === "number") row.cost += e.cost;
      for (const k of Object.keys(row.tokens)) row.tokens[k] += e.tokens[k] || 0;
    }
    rows.push(row);
  }
  rows.sort((a, b) => b.cost - a.cost);
  return rows;
}
