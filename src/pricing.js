// Transparent, editable pricing. USD per 1M tokens.
//
// burn NEVER invents a price. If a model is unknown it reports tokens only and
// marks the cell "unpriced" rather than guessing dollars. Add your real numbers
// in ~/.burn/pricing.json (merged over these defaults) to teach it more models.
//
// Cache fields follow Anthropic prompt-caching semantics:
//   cacheWrite = cost to CREATE cached prompt tokens  (base input * 1.25)
//   cacheRead  = cost to READ cached prompt tokens     (base input * 0.10)
// For providers without caching, leave those at the input price.

import crypto from "node:crypto";

const USD_PER_M = 1_000_000;

export const DEFAULT_PRICING = {
  anthropic: {
    "claude-opus-4-1": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
    "claude-opus-4": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
    "claude-opus-5": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
    "claude-sonnet-4": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
    "claude-sonnet-4-5": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
    "claude-haiku-4-5": { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
    "claude-3-5-haiku": { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
  },
  openai: {
    "gpt-5": { input: 1.25, output: 10, cacheWrite: 1.25, cacheRead: 0.125 },
    "gpt-5-mini": { input: 0.25, output: 2, cacheWrite: 0.25, cacheRead: 0.025 },
    "gpt-4.1": { input: 2, output: 8, cacheWrite: 2, cacheRead: 0.5 },
    "o3": { input: 2, output: 8, cacheWrite: 2, cacheRead: 0.5 },
  },
  google: {
    "gemini-2.5-pro": { input: 1.25, output: 10, cacheWrite: 1.25, cacheRead: 0.3125 },
    "gemini-2.5-flash": { input: 0.3, output: 2.5, cacheWrite: 0.3, cacheRead: 0.075 },
  },
};

function flatten(table) {
  const out = new Map();
  for (const provider of Object.values(table)) {
    for (const [model, price] of Object.entries(provider)) {
      out.set(model, price);
    }
  }
  return out;
}

// Load pricing merged with any user overrides from ~/.burn/pricing.json.
// Override shape: { "<model>": { input, output, cacheWrite, cacheRead } }
export async function loadPricing(overrides = {}) {
  const map = flatten(DEFAULT_PRICING);
  for (const [model, price] of Object.entries(overrides || {})) {
    map.set(model, { ...(map.get(model) || {}), ...price });
  }
  // Exact match, else the longest key whose remainder is a version
  // suffix ("-20260901"). Variant names (gpt-5-micro) never inherit a sibling's price.
  const isVersionSuffix = (rest) => rest === "" || /^[-.]\d/.test(rest);
  function resolve(modelId) {
    if (!modelId) return null;
    if (map.has(modelId)) return map.get(modelId);
    let best = null;
    for (const key of map.keys()) {
      if (modelId.startsWith(key) && isVersionSuffix(modelId.slice(key.length))) {
        if (!best || key.length > best.length) best = key;
      }
    }
    return best ? map.get(best) : null;
  }
  return {
    has(modelId) {
      return resolve(modelId) !== null;
    },
    lookup: resolve,
    size: () => map.size,
    // SHA-256 over the EFFECTIVE table (defaults merged with
    // user overrides), canonicalized: models sorted, fields sorted. Same
    // table + same tokens = same dollars, provable years later without
    // trusting the table owner. 12 hex is collision-safe at human scale
    // (~4 billion tables per birthday bound) and fits in a ledger line.
    tableHash() {
      const canon = [...map.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([m, p]) => `${m}{${Object.keys(p).sort().map((k) => `${k}=${p[k]}`).join(",")}}`)
        .join(";");
      return crypto.createHash("sha256").update(canon).digest("hex").slice(0, 12);
    },
  };
}

// Estimate USD for a usage record given resolved pricing.
// Returns a number, or null when the model is unpriced (never guess).
export function estimateCost(usage, pricing) {
  const price = pricing.lookup(usage.model);
  if (!price) return null;
  const g = (k) => Number(usage[k] || 0);
  const input = g("input");
  const output = g("output");
  const cacheWrite = g("cacheWrite");
  const cacheRead = g("cacheRead");
  const usd =
    (input * (price.input ?? 0) +
      output * (price.output ?? 0) +
      cacheWrite * (price.cacheWrite ?? price.input ?? 0) +
      cacheRead * (price.cacheRead ?? price.input ?? 0)) /
    USD_PER_M;
  return usd;
}
