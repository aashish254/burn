// ULP 1.0 concretization: load the schema (data, not code),
// negotiate versions, and purify a burn bundle into a pure-core ULP document.
// The schema itself lives at ulp/schema-1.0.json at the repo root — portable
// to the standalone ULP home (M11) without touching burn code.

import fs from "node:fs";
import os from "node:os";
import { validate } from "./validate.js";

export const ULP_VERSION = "1.0";

let cachedSchema = null;
export function ulpSchema() {
  if (!cachedSchema) {
    const p = new URL("../../ulp/schema-1.0.json", import.meta.url);
    cachedSchema = JSON.parse(fs.readFileSync(p, "utf8"));
  }
  return cachedSchema;
}

// burn's ledger specVersion predates the protocol; the mapping is fixed:
// burn "2.0" and "1.0" documents both carry ULP 1.0-compatible core fields
// ("1.0" lacks v2 additions, which are all optional in the schema).
const BURN_TO_ULP = { "1.0": "1.0", "2.0": "1.0" };

export function ulpVersionOf(doc) {
  if (typeof doc?.ulpVersion === "string") return doc.ulpVersion;
  return BURN_TO_ULP[doc?.specVersion] || null;
}

// Version negotiation: major mismatch → {ok:false}; newer minor → warn and
// validate with unknown fields ignored; older equal → strict.
export function negotiate(doc) {
  const v = ulpVersionOf(doc);
  if (!v) {
    return { ok: false, relax: false, error: `unrecognized version ${JSON.stringify(doc?.specVersion ?? doc?.ulpVersion)} — no ULP mapping` };
  }
  const [major, minor] = v.split(".").map(Number);
  if (major !== 1) {
    return { ok: false, relax: false, error: `ULP major version ${major} is not supported (this tool speaks ULP ${ULP_VERSION})` };
  }
  if (minor > 1) {
    return { ok: true, relax: true, warn: `ULP 1.${minor} is newer than this tool's 1.0 core — ignoring unknown fields` };
  }
  return { ok: true, relax: false };
}

export function validateAgainstUlp(doc, options = {}) {
  return validate(doc, ulpSchema(), options);
}

// Absolute paths MUST NOT enter a shareable document (privacy P3). Home-based
// paths become tilde-form; anything outside home (env-overridden test stores)
// is omitted — no path is better than a leaked path.
export function tildePath(p) {
  if (typeof p !== "string") return p;
  const home = os.homedir();
  if (p === home) return "~";
  if (p.startsWith(home + "/")) return "~/" + p.slice(home.length + 1);
  return null;
}

function deepPurify(node) {
  if (Array.isArray(node)) return node.map(deepPurify);
  if (node !== null && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith("x-")) continue; // --ulp strips ALL extension fields
      out[k] = deepPurify(v);
    }
    return out;
  }
  return node;
}

// Pure-core ULP document from a burn bundle: ulpVersion stamped, units renamed
// to workUnits (the protocol name), x-* extensions stripped, store paths
// tilde-ified. What remains is exactly what ulp/schema-1.0.json describes.
export function toUlpDocument(bundle) {
  const doc = deepPurify(structuredClone(bundle));
  if (doc.units && !doc.workUnits) {
    doc.workUnits = doc.units;
    delete doc.units;
  }
  if (Array.isArray(doc.workUnits)) {
    // internal {kind, name, confidence} → protocol {kind, ref, confidence},
    // the same translation bundleEvents does for event attributions.
    doc.workUnits = doc.workUnits.map((w) =>
      w.unit ? { ...w, unit: { kind: w.unit.kind, ref: w.unit.name, confidence: w.unit.confidence } } : w
    );
  }
  doc.ulpVersion = ULP_VERSION;
  if (Array.isArray(doc.supportedAgents)) {
    for (const a of doc.supportedAgents) {
      if (!("storePath" in a)) continue;
      const t = tildePath(a.storePath);
      if (t === null) delete a.storePath;
      else a.storePath = t;
    }
  }
  return doc;
}
