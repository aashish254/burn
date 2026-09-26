import { estimateCost } from "./pricing.js";
import { resolveUnit } from "./attribution.js";

// Resolve the dollar cost for one usage event without ever guessing a price.
//   store     -> the agent billed it (OpenCode session.cost)
//   estimate  -> model found in the pricing table (Claude Code)
//   unpriced  -> tokens counted, dollars withheld (unknown/free model)
function resolveCost(ev, pricing) {
  if (typeof ev.storedCost === "number" && Number.isFinite(ev.storedCost)) {
    return { cost: ev.storedCost, source: "store" };
  }
  const est = estimateCost(
    {
      model: ev.model,
      input: ev.tokens.input,
      output: ev.tokens.output,
      cacheWrite: ev.tokens.cacheWrite,
      cacheRead: ev.tokens.cacheRead,
    },
    pricing
  );
  if (est != null) return { cost: est, source: "estimate" };
  return { cost: null, source: "unpriced" };
}

function newBucket(key) {
  return {
    key,
    events: 0,
    cost: 0,
    store: 0,
    estimate: 0,
    unpricedEvents: 0,
    firstDate: null,
    lastDate: null,
    tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, reasoning: 0 },
  };
}

function bump(bucket, ev, cost) {
  bucket.events++;
  if (ev.date && ev.date !== "unknown") {
    if (!bucket.firstDate || ev.date < bucket.firstDate) bucket.firstDate = ev.date;
    if (!bucket.lastDate || ev.date > bucket.lastDate) bucket.lastDate = ev.date;
  }
  for (const k of Object.keys(ev.tokens)) bucket.tokens[k] += ev.tokens[k] || 0;
  if (cost.source === "unpriced") bucket.unpricedEvents++;
  else bucket.cost += cost.cost;
  if (cost.source === "store") bucket.store += cost.cost;
  if (cost.source === "estimate") bucket.estimate += cost.cost;
}

function cacheHitRate(tokens) {
  const prompt = tokens.cacheRead + tokens.cacheWrite + tokens.input;
  return prompt > 0 ? tokens.cacheRead / prompt : 0;
}

// Bucket a set of costed events into the ledger document. Pure over events —
// this is ALSO the recompute path for `burn merge` (SPEC-2 §E.2: buckets are
// rebuilt from the merged event set, never summed from pre-aggregated rows).
// events: normalized UsageEvent + { cost:number|null, costSource }.
export function aggregateEvents(events, options = {}) {
  const totals = newBucket("total");
  const byRepo = new Map();
  const byModel = new Map();
  const byAgent = new Map();
  const byDay = new Map();
  const byUnit = new Map();
  const sessions = new Map();
  const rawEvents = options.includeEvents ? [] : null;
  const sources = { store: 0, estimate: 0, unpriced: 0 };

  for (const ev of events) {
    const cost = { cost: ev.cost, source: ev.costSource };
    bump(totals, ev, cost);
    sources[cost.source]++;

    const scope = (map, key) => {
      if (!map.has(key)) map.set(key, newBucket(key));
      return map.get(key);
    };
    bump(scope(byRepo, ev.repo || "(unknown)"), ev, cost);
    bump(scope(byModel, ev.model || "unknown"), ev, cost);
    bump(scope(byAgent, ev.agent), ev, cost);
    bump(scope(byDay, ev.date), ev, cost);

    // SPEC-2 §B: total resolution — every event lands in exactly one unit,
    // so Σ units.cost == totals.cost by construction (H11 invariant).
    const unit = resolveUnit(ev, options.attributes);
    const uScope = scope(byUnit, `${unit.kind}:${unit.name}`);
    uScope.unit = unit;
    bump(uScope, ev, cost);

    if (rawEvents) rawEvents.push({ ...ev, unit });

    const skey = `${ev.agent}:${ev.sessionId}`;
    if (!sessions.has(skey)) {
      sessions.set(skey, {
        agent: ev.agent,
        sessionId: ev.sessionId,
        model: ev.model,
        repo: ev.repo,
        date: ev.date,
        cost: 0,
        tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, reasoning: 0 },
        source: cost.source,
      });
    }
    const s = sessions.get(skey);
    for (const k of Object.keys(ev.tokens)) s.tokens[k] += ev.tokens[k] || 0;
    if (cost.source !== "unpriced") s.cost += cost.cost;
  }

  const finalize = (b) => ({ ...b, cacheHit: cacheHitRate(b.tokens) });
  const totalTokens = totals.tokens.input + totals.tokens.output;

  return {
    totals: finalize(totals),
    cacheHit: cacheHitRate(totals.tokens),
    sources,
    totalTokens,
    repos: [...byRepo.values()].map(finalize).sort((a, b) => b.cost - a.cost),
    models: [...byModel.values()].map(finalize).sort((a, b) => b.cost - a.cost),
    agents: [...byAgent.values()].map(finalize).sort((a, b) => b.cost - a.cost),
    days: [...byDay.values()].map(finalize).sort((a, b) => a.key.localeCompare(b.key)),
    units: [...byUnit.values()]
      .map((b) => ({ ...finalize(b), unit: b.unit }))
      .sort((a, b) => b.cost - a.cost),
    sessions: [...sessions.values()].sort((a, b) => b.cost - a.cost),
    ...(rawEvents ? { events: rawEvents } : {}),
  };
}

// Extract and cost events WITHOUT bucketing — the input shape that
// `burn ingest` and (v4) history merge union against (SPEC §E.2 identity).
export async function costEvents(extractors, pricing, options = {}) {
  const since = options.since || null;
  const until = options.until || null; // exclusive upper bound (monthly report window)
  const costed = [];
  for (const mod of extractors) {
    for await (const ev of mod.extract()) {
      // SPEC §7: with --since, undated events cannot be proven in range → excluded.
      if (since && (ev.date === "unknown" || ev.date < since)) continue;
      if (until && (ev.date === "unknown" || ev.date >= until)) continue;
      const cost = resolveCost(ev, pricing);
      costed.push({ ...ev, cost: cost.cost, costSource: cost.source });
    }
  }
  return costed;
}

// Collect all events into a structured ledger.
// options: { since: "YYYY-MM-DD" | null, attributes: object|undefined, includeEvents: bool }
export async function collect(extractors, pricing, options = {}) {
  return aggregateEvents(await costEvents(extractors, pricing, options), options);
}
