// SPEC-3-5 §V3.C — the conformance kit runner. Vectors under
// ulp/conformance/vectors/ are pure JSON: {id, name, kind, bundle|bundles,
// expect} — any language can implement a runner against the schema + merge
// rules without reading a line of burn code (ulp-reader.py does exactly that).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateAgainstUlp } from "./ulp.js";
import { mergeBundles } from "../bundle.js";

export function vectorsDir() {
  return process.env.ULP_VECTORS_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "ulp", "conformance", "vectors");
}

export function loadVectors() {
  return fs.readdirSync(vectorsDir())
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ ...JSON.parse(fs.readFileSync(path.join(vectorsDir(), f), "utf8")), __file: f }));
}

function near(a, b, eps = 1e-9) {
  return Math.abs(a - b) < eps;
}

function checkTotals(merged, expect, notes) {
  const t = merged.totals;
  if (expect.events !== undefined && t.events !== expect.events) notes.push(`events ${t.events} != ${expect.events}`);
  if (expect.cost !== undefined && !near(t.cost, expect.cost)) notes.push(`cost ${t.cost} != ${expect.cost}`);
  if (expect.sources) {
    if (merged.sources.store !== expect.sources.store) notes.push(`sources.store ${merged.sources.store} != ${expect.sources.store}`);
    if (merged.sources.estimate !== expect.sources.estimate) notes.push(`sources.estimate ${merged.sources.estimate} != ${expect.sources.estimate}`);
    if (merged.sources.unpriced !== expect.sources.unpriced) notes.push(`sources.unpriced ${merged.sources.unpriced} != ${expect.sources.unpriced}`);
  }
  if (expect.repos) {
    for (const [repo, cost] of Object.entries(expect.repos)) {
      const b = merged.repos.find((r) => r.key === repo);
      const got = b ? b.cost : 0;
      if (!near(got, cost)) notes.push(`repos.${repo} ${got} != ${cost}`);
    }
    if (merged.repos.length !== Object.keys(expect.repos).length) {
      notes.push(`repos count ${merged.repos.length} != ${Object.keys(expect.repos).length}`);
    }
  }
  if (expect.cacheHit !== undefined && !near(merged.cacheHit, expect.cacheHit)) {
    notes.push(`cacheHit ${merged.cacheHit} != ${expect.cacheHit}`);
  }
}

export function runKit() {
  const results = [];
  for (const v of loadVectors()) {
    const notes = [];
    try {
      if (v.kind === "validate") {
        const errors = validateAgainstUlp(v.bundle);
        const ok = errors.length === 0;
        if (ok !== v.expect.ok) notes.push(`validate → ${ok ? "accepted" : "rejected"}, expected ${v.expect.ok ? "accepted" : "rejected"}`);
      } else if (v.kind === "validate-both") {
        const strict = validateAgainstUlp(v.bundle).length === 0;
        const relaxed = validateAgainstUlp(v.bundle, { relaxUnknown: true }).length === 0;
        if (strict !== v.expect.strictOk) notes.push(`strict validate → ${strict}, expected ${v.expect.strictOk}`);
        if (relaxed !== v.expect.relaxOk) notes.push(`relax validate → ${relaxed}, expected ${v.expect.relaxOk}`);
      } else if (v.kind === "merge") {
        checkTotals(mergeBundles(v.bundles, { attributes: {} }), v.expect.totals, notes);
        if (v.expectSameReversed) {
          const revNotes = [];
          checkTotals(mergeBundles([...v.bundles].reverse(), { attributes: {} }), v.expect.totals, revNotes);
          for (const n of revNotes) notes.push(`reversed order: ${n}`);
        }
      } else {
        notes.push(`unknown vector kind "${v.kind}"`);
      }
    } catch (e) {
      notes.push(`runner threw: ${e.message}`);
    }
    results.push({ id: v.id, file: v.__file, name: v.name, pass: notes.length === 0, notes });
  }
  return results;
}
