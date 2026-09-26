// SPEC-3-5 §V3.B — `burn ingest`: burn becomes a CONSUMER of any conformant
// ULP ledger, not just a reader of its own extractors. Files are validated
// (schema + provenance integrity) BEFORE they are trusted, then stored
// content-addressed under ~/.burn/ingest/ (the one place burn writes beyond
// its config files; trivially deletable). Merging into every command reuses
// the §E.2 union identity — foreign data is indistinguishable from a foreign
// device's export, and double-counting is impossible by construction.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { estimateCost } from "../pricing.js";
import { negotiate, validateAgainstUlp } from "./ulp.js";

export function ingestDir() {
  return process.env.BURN_INGEST_DIR || path.join(os.homedir(), ".burn", "ingest");
}

// Honest recomputation: an external bundle claims costSource "estimate" for a
// model WE can price → re-derive from the recorded tokens and compare. A
// mismatch is REPORTED, never repaired (§V3.B: their history, their number —
// we surface the disagreement, loudly, and let the human decide).
export function checkEstimatedCosts(events, pricing) {
  const mismatches = [];
  for (const ev of events) {
    if (ev.costSource !== "estimate" || !pricing.has(ev.model)) continue;
    const expect = estimateCost(
      {
        model: ev.model,
        input: ev.tokens.input,
        output: ev.tokens.output,
        cacheWrite: ev.tokens.cacheWrite,
        cacheRead: ev.tokens.cacheRead,
      },
      pricing
    );
    if (expect == null) continue;
    const got = typeof ev.cost === "number" ? ev.cost : 0;
    if (Math.abs(got - expect) > 1e-6) {
      mismatches.push({ model: ev.model, claimed: got, recomputed: expect, sessionId: ev.sessionId });
    }
  }
  return mismatches;
}

export function inspectDoc(doc, label, pricing) {
  if (!doc || typeof doc !== "object") throw new Error(`burn ingest: ${label} is not a JSON object`);
  const neg = negotiate(doc);
  if (!neg.ok) throw new Error(`burn ingest: ${label} — ${neg.error}`);
  const errors = validateAgainstUlp(doc, { relaxUnknown: neg.relax });
  if (errors.length) {
    const head = errors.slice(0, 5).map((e) => "  " + e).join("\n");
    throw new Error(
      `burn ingest: ${label} does not conform to ULP ${doc.ulpVersion ?? "1.0"} (${errors.length} schema error(s)):\n${head}`
    );
  }
  if (!Array.isArray(doc.events)) {
    throw new Error(`burn ingest: ${label} has no events[] — ingest needs merge-capable bundles`);
  }
  return { doc, warn: neg.warn || null, mismatches: checkEstimatedCosts(doc.events, pricing) };
}

export function inspectBundle(file, pricing, options = {}) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`burn ingest: cannot read/parse ${file}: ${e.message}`);
  }
  return inspectDoc(doc, file, pricing);
}

// Content-addressed store: ingesting the same file twice is a no-op (V21).
export function storeBundle(file) {
  return storeBundleBytes(fs.readFileSync(file));
}

export function storeBundleBytes(buf) {
  const hash = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
  const dest = path.join(ingestDir(), hash + ".json");
  const created = !fs.existsSync(dest);
  if (created) {
    fs.mkdirSync(ingestDir(), { recursive: true });
    fs.writeFileSync(dest, buf);
  }
  return { dest, hash, created };
}

// OTel-translated bundles are stored as their canonical ULP form, so a file
// ingested --otel twice (or exported back and ingested plain) is still a
// content-addressed no-op.
export function storeBundleDoc(doc) {
  return storeBundleBytes(Buffer.from(JSON.stringify(doc, null, 2) + "\n"));
}

// Every stored bundle as a merge doc (deviceId + events). Stored files were
// validated at ingest; if one has since been edited on disk, it is skipped
// with a warning — corrupt history must not poison a report.
export function loadIngestDocs(pricing) {
  const dir = ingestDir();
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return { docs: [], skipped: 0 };
  }
  const docs = [];
  let skipped = 0;
  for (const f of files) {
    try {
      const { doc } = inspectBundle(path.join(dir, f), pricing);
      docs.push(doc);
    } catch {
      skipped++;
    }
  }
  return { docs, skipped };
}

export function listIngested() {
  const dir = ingestDir();
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
  return files.map((f) => {
    const p = path.join(dir, f);
    let meta = { file: f, readable: false, events: 0, cost: 0, deviceId: null, generatedAt: null, ulpVersion: null };
    try {
      const doc = JSON.parse(fs.readFileSync(p, "utf8"));
      meta = {
        ...meta,
        readable: true,
        events: Array.isArray(doc.events) ? doc.events.length : 0,
        cost: doc.totals?.cost ?? 0,
        deviceId: doc.deviceId || null,
        generatedAt: doc.generatedAt || null,
        ulpVersion: doc.ulpVersion || null,
        ingestedAt: fs.statSync(p).mtime.toISOString(),
      };
    } catch { /* unreadable stays flagged */ }
    return meta;
  });
}
