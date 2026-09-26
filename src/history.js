// SPEC-3-5 §V4.A — snapshots are ordinary ULP bundles in a known folder.
// Nothing custom: history IS bundles. A snapshot joins later reports through
// the same §E.2 union identity that merge and ingest already use, so
// transcript deletion stops being data deletion.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function historyDir() {
  return process.env.BURN_HISTORY_DIR || path.join(os.homedir(), ".burn", "history");
}

// UTC minute-resolution name; two snapshots in one minute collide on purpose —
// re-running `burn snapshot` overwrites, which is the idempotence §V4.A asks for.
export function snapshotName(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}-${p(d.getUTCMinutes())}.burn.json`
  );
}

export function writeSnapshot(doc) {
  const dir = historyDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, snapshotName());
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  return { file, events: (doc.events || []).length };
}

// Newer snapshots FIRST: mergeBundles is first-wins on identity collisions, so
// document order encodes the §V4.A tie-break (live > snapshot; new > old).
// Malformed files are skipped with a stderr note — history must never break
// a report.
export function loadSnapshots() {
  const dir = historyDir();
  const docs = [];
  const skipped = [];
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".burn.json"));
  } catch {
    return { docs, skipped }; // no history yet is the normal first-run case
  }
  const parsed = [];
  for (const f of names) {
    const file = path.join(dir, f);
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      skipped.push({ file: f, reason: e.message });
      continue;
    }
    if (!doc || typeof doc !== "object" || !Array.isArray(doc.events)) {
      skipped.push({ file: f, reason: "no events[] — compact or foreign document" });
      continue;
    }
    parsed.push({ file: f, doc, generatedAt: String(doc.generatedAt || f) });
  }
  parsed.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  for (const p of parsed) docs.push(Object.assign(p.doc, { __file: p.file }));
  return { docs, skipped };
}

export function listSnapshots() {
  const dir = historyDir();
  const rows = [];
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".burn.json"));
  } catch {
    return rows;
  }
  for (const f of names.sort()) {
    const row = { file: f, generatedAt: null, events: 0, cost: 0, readable: true };
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      row.generatedAt = doc.generatedAt || null;
      row.events = Array.isArray(doc.events) ? doc.events.length : 0;
      row.cost = (doc.totals && typeof doc.totals.cost === "number" && Number.isFinite(doc.totals.cost))
        ? doc.totals.cost
        : doc.events.reduce((s, e) => s + (e.costSource !== "unpriced" && typeof e.cost === "number" ? e.cost : 0), 0);
    } catch {
      row.readable = false;
    }
    rows.push(row);
  }
  return rows;
}

// The only destructive command in burn: it must confirm, and it will delete
// nothing outside the history folder.
const SNAPSHOT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}\.burn\.json$/;

export function dropSnapshot(name, { yes = false } = {}) {
  if (!yes) throw new Error("burn history drop: deletion requires explicit confirmation — re-run with --yes");
  const base = path.basename(String(name));
  if (!SNAPSHOT_RE.test(base)) {
    throw new Error(`burn history drop: "${base}" is not a snapshot filename (YYYY-MM-DDTHH-mm.burn.json)`);
  }
  const dir = path.resolve(historyDir());
  const file = path.resolve(dir, base);
  if (path.dirname(file) !== dir || !fs.existsSync(file)) {
    throw new Error(`burn history drop: no snapshot named ${base}`);
  }
  fs.unlinkSync(file);
  return file;
}
