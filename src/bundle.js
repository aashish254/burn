import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { aggregateEvents } from "./aggregate.js";

// SPEC-2 §E: teams without a backend. A bundle is the §6 document plus
// identity and (unless --compact) the raw events needed for merge fidelity.
// Distribution is out of scope by design: git or any file share carries the
// file; there is no server, and burn never touches the network.

export function deviceId() {
  const p = process.env.BURN_ID_FILE || path.join(os.homedir(), ".burn", "id");
  try {
    const s = fs.readFileSync(p, "utf8").trim();
    if (s) return s;
  } catch {
    // falls through to first-run generation
  }
  const id = crypto.randomUUID();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, id + "\n");
  } catch {
    // unwritable home still yields a stable-per-process id; export degrades honestly
  }
  return id;
}

// Display-only: SHA-256 of the hostname truncated to 8 hex chars. Never the
// hostname itself (v1 §9 privacy carries into bundles).
export function hostnameHash() {
  return crypto.createHash("sha256").update(os.hostname()).digest("hex").slice(0, 8);
}

// §F event shape: UsageEvent + cost + `attribution` instead of the internal
// `unit`. `dir` (a full path) is stripped — bundles are shareable files.
export function bundleEvents(events) {
  return events.map(({ unit, dir, __device, ...rest }) => ({
    ...rest,
    attribution: unit ? { kind: unit.kind, ref: unit.name, confidence: unit.confidence } : null,
  }));
}

export function toBundle(ledger, { supportedAgents, compact = false, pricingHash = null }) {
  const doc = {
    specVersion: "2.0",
    generatedAt: new Date().toISOString(),
    deviceId: deviceId(),
    hostnameHash: hostnameHash(),
    // SPEC-3-5 §V5.C: reproducible-estimates anchor. null is the stable
    // "no pricing table applied to this ledger" marker, never a hash of nothing.
    pricingHash,
    supportedAgents, // §F: [{ id, storePath?, status: "ready"|"planned" }] — caller owns the truth
    ...ledger,
  };
  if (compact) delete doc.events;
  else if (doc.events) doc.events = bundleEvents(doc.events);
  return doc;
}

export function readBundle(file) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`burn merge: cannot read/parse bundle ${file}: ${e.message}`);
  }
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.events)) {
    throw new Error(`burn merge: ${file} has no events[] — merge needs full bundles (export without --compact)`);
  }
  return doc;
}

// SPEC-2 §E.2, normative and order-independent:
// identity = (deviceId, agent, sessionId, index-within-session); sets UNION;
// identical inputs are idempotent; buckets RECOMPUTE, never sum.
export function mergeBundles(docs, options = {}) {
  const byIdentity = new Map();
  for (const doc of docs) {
    const dev = doc.deviceId || "unknown-device";
    const counters = new Map();
    for (const ev of doc.events) {
      const sk = `${dev}|${ev.agent}|${ev.sessionId}`;
      const idx = counters.get(sk) || 0;
      counters.set(sk, idx + 1);
      const id = `${sk}|${idx}`;
      if (!byIdentity.has(id)) {
        const { attribution, ...rest } = ev;
        void attribution; // units re-resolve on THIS machine (§B ladder, local attributes)
        byIdentity.set(id, { ...rest, __device: dev });
      }
    }
  }
  const ledger = aggregateEvents([...byIdentity.values()], { ...options, includeEvents: true });
  ledger.deviceIds = [...new Set(docs.map((d) => d.deviceId || "unknown-device"))].sort();
  return ledger;
}

// Copied ~/.burn/id files make two humans claim one deviceId — the union would
// silently drop the second human's identical-index events. --audit finds it.
export function auditBundles(docs) {
  const filesByDevice = new Map();
  for (const d of docs) {
    const id = d.deviceId || "unknown-device";
    if (!filesByDevice.has(id)) filesByDevice.set(id, []);
    filesByDevice.get(id).push(d.__file || "(stream)");
  }
  const duplicates = [...filesByDevice.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([deviceId, files]) => ({ deviceId, files }));
  return {
    bundles: docs.length,
    distinctDevices: filesByDevice.size,
    duplicates,
    ok: duplicates.length === 0,
  };
}

export function loadRoster() {
  const p = process.env.BURN_ROSTER || path.join(os.homedir(), ".burn", "roster.json");
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    return {}; // roster is optional by spec; its absence never fails a command
  }
}

// §E.3: per-human totals from merged events (deviceId is the human; names only
// via the local roster.json), plus per-repo totals.
export function teamView(merged, roster) {
  const byDevice = new Map();
  for (const ev of merged.events) {
    const dev = ev.__device || "unknown-device";
    if (!byDevice.has(dev)) {
      byDevice.set(dev, {
        deviceId: dev,
        label: roster[dev] || dev.slice(0, 8),
        events: 0,
        cost: 0,
        tokens: { input: 0, output: 0 },
        repos: new Set(),
      });
    }
    const row = byDevice.get(dev);
    row.events++;
    if (ev.costSource !== "unpriced") row.cost += ev.cost;
    row.tokens.input += ev.tokens.input || 0;
    row.tokens.output += ev.tokens.output || 0;
    row.repos.add(ev.repo);
  }
  const humans = [...byDevice.values()]
    .map((r) => ({ ...r, repos: r.repos.size }))
    .sort((a, b) => b.cost - a.cost);
  return { humans, repos: merged.repos, totals: merged.totals };
}
