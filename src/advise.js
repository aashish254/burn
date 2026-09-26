import { estimateCost } from "./pricing.js";
import { commitCount } from "./git.js";

// Forward-looking money and advice — pure arithmetic over the
// recorded ledger. No LLM, no vibes, no invented prices: every number here is
// either recorded, or table pricing applied to recorded tokens.

const DAY = 86400000;
const turnTokens = (t) => (t.input || 0) + (t.output || 0);

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ---------- forecast ----------

// Least-squares line + last-7-day mean over a fixed-size daily series.
// Exported for snapshot tests: same input, same numbers, forever.
export function forecastSeries(series) {
  const n = series.length;
  const sum = series.reduce((a, b) => a + b, 0);
  const mean = n ? sum / n : 0;
  const last7 = series.slice(Math.max(0, n - 7));
  const last7Mean = last7.length ? last7.reduce((a, b) => a + b, 0) / last7.length : 0;
  let slope = 0;
  if (n > 1) {
    const xm = (n - 1) / 2;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      num += (i - xm) * (series[i] - mean);
      den += (i - xm) * (i - xm);
    }
    slope = den ? num / den : 0;
  }
  const intercept = mean - slope * ((n - 1) / 2);
  const predict = (j) => Math.max(0, slope * j + intercept);
  let linearNext7 = 0;
  let linearNext30 = 0;
  for (let k = 1; k <= 7; k++) linearNext7 += predict(n - 1 + k);
  for (let k = 1; k <= 30; k++) linearNext30 += predict(n - 1 + k);
  return {
    slope,
    windowCost: sum,
    linearNext7,
    linearNext30,
    last7MeanNext7: last7Mean * 7,
  };
}

function dailySeries(costByDate, end, windowDays) {
  const endMs = Date.parse(end + "T00:00:00Z");
  const out = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    out.push(costByDate.get(isoDate(endMs - i * DAY)) || 0);
  }
  return out;
}

// events: rawEvents from collect (date, cost, costSource, repo, tokens).
// Priced events only; unpriced tokens are reported separately, never $-ized.
export function forecast(events, { windowDays = 30 } = {}) {
  const totalByDate = new Map();
  const repoByDate = new Map(); // repo -> Map(date -> cost)
  let unpricedTokens = 0;
  let end = null;
  for (const ev of events) {
    if (ev.date && ev.date !== "unknown" && (!end || ev.date > end)) end = ev.date;
    if (ev.costSource === "unpriced") {
      unpricedTokens += turnTokens(ev.tokens);
      continue;
    }
    if (!ev.date || ev.date === "unknown" || ev.cost == null) continue;
    totalByDate.set(ev.date, (totalByDate.get(ev.date) || 0) + ev.cost);
    if (!repoByDate.has(ev.repo)) repoByDate.set(ev.repo, new Map());
    const m = repoByDate.get(ev.repo);
    m.set(ev.date, (m.get(ev.date) || 0) + ev.cost);
  }
  if (!totalByDate.size) {
    return { label: "est-forecast", windowDays: 0, daysWithData: 0, end: null, total: null, byRepo: [], unpricedTokens };
  }
  const series = dailySeries(totalByDate, end, windowDays);
  const byRepo = [...repoByDate.entries()]
    .map(([repo, m]) => ({ repo, ...forecastSeries(dailySeries(m, end, windowDays)) }))
    .sort((a, b) => b.linearNext30 - a.linearNext30)
    .slice(0, 10);
  return {
    label: "est-forecast",
    windowDays,
    daysWithData: series.filter((x) => x > 0).length,
    end,
    total: forecastSeries(series),
    byRepo,
    unpricedTokens,
  };
}

// ---------- plan ----------

// "Can I afford X months at Y dollars?" — linear-series math only: the same
// least-squares daily forecast, accumulated over the horizon. The
// exhaustion date is a property of an INCREASING series; anything else says
// null rather than inventing a date.
export function plan(events, { repo, budgetUsd, months, windowDays = 30 }) {
  const costByDate = new Map();
  let pricedEvents = 0;
  let end = null;
  for (const ev of events) {
    if (!ev.date || ev.date === "unknown" || ev.costSource === "unpriced" || ev.cost == null) continue;
    if (repo && (ev.repo || "(unknown)") !== repo) continue;
    pricedEvents++;
    if (ev.date > (end || "")) end = ev.date;
    costByDate.set(ev.date, (costByDate.get(ev.date) || 0) + ev.cost);
  }
  if (!costByDate.size) return { found: false, pricedEvents, reason: "no-priced-history" };
  const series = dailySeries(costByDate, end, windowDays);
  const f = forecastSeries(series);
  const n = series.length;
  const intercept = f.windowCost / n - f.slope * ((n - 1) / 2);
  const predict = (j) => Math.max(0, f.slope * j + intercept);
  const horizonDays = months * 30;
  const increasing = f.slope > 0;
  let cum = 0;
  let exhaustionDate = null;
  for (let k = 1; k <= horizonDays; k++) {
    cum += predict(n - 1 + k);
    if (increasing && exhaustionDate === null && cum > budgetUsd) {
      exhaustionDate = isoDate(Date.parse(end + "T00:00:00Z") + k * DAY);
    }
  }
  return {
    found: true, repo, budgetUsd, months, windowDays, end, pricedEvents,
    slopePerDay: f.slope,
    projectedCost: cum,
    affordable: cum <= budgetUsd,
    increasing,
    exhaustionDate: increasing ? exhaustionDate : null,
  };
}

// ---------- counterfactual ----------

// Replays every recorded token of `events` at routeModel's list price.
// Unpriced target ⇒ null ⇒ the honest answer is "—", never a guess.
export function replayAt(events, pricing, routeModel) {
  const tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  for (const ev of events) for (const k of Object.keys(tokens)) tokens[k] += ev.tokens[k] || 0;
  return estimateCost({ model: routeModel, ...tokens }, pricing);
}

export function counterfactual(events, pricing, routeModel) {
  let billed = 0;
  let estimated = 0;
  for (const ev of events) {
    if (ev.costSource === "store") billed += ev.cost;
    else if (ev.costSource === "estimate") estimated += ev.cost;
  }
  const asItHappened = billed + estimated;
  const replay = replayAt(events, pricing, routeModel);
  return {
    label: "estimate-of-estimate",
    route: routeModel,
    asItHappened,
    billed,
    estimated,
    replay,
    delta: replay == null ? null : asItHappened - replay,
    unpriceable: replay == null,
  };
}

// ---------- doctor — rules R-1..R-6, deterministic ----------

const OPUS_TIER = /^claude-opus/;
const CHEAP_ROUTE = "claude-sonnet-4"; // R-2's suggested downgrade target

function finding(rule, severity, scope, observation, suggested, estImpactClass, estImpactUsd) {
  return { rule, severity, scope, observation, suggested, estImpactClass, estImpactUsd: estImpactUsd ?? null };
}

export function doctor(events, pricing) {
  const findings = [];

  const byRepo = new Map();
  for (const ev of events) {
    if (!byRepo.has(ev.repo)) byRepo.set(ev.repo, []);
    byRepo.get(ev.repo).push(ev);
  }

  for (const [repo, evs] of byRepo) {
    const scope = `repo:${repo}`;

    // R-1 cache-starved: big prompts, cache barely used. Impact is a list-price
    // upper bound: what ALL fresh input tokens would cost less if they had
    // instead been served as cache reads at each event's own table prices.
    const prompt = evs.reduce((a, e) => a + (e.tokens.input || 0) + (e.tokens.cacheRead || 0) + (e.tokens.cacheWrite || 0), 0);
    const cacheRead = evs.reduce((a, e) => a + (e.tokens.cacheRead || 0), 0);
    const avgPrompt = evs.length ? prompt / evs.length : 0;
    const cacheHit = prompt > 0 ? cacheRead / prompt : 0;
    if (evs.length >= 20 && avgPrompt > 50_000 && cacheHit < 0.1) {
      let cap = 0;
      for (const e of evs) {
        const p = pricing.lookup(e.model);
        if (p && e.costSource === "estimate" && e.tokens.input > 0) {
          cap += (e.tokens.input * ((p.input ?? 0) - (p.cacheRead ?? p.input ?? 0))) / 1e6;
        }
      }
      findings.push(
        finding(
          "R-1 cache-starved",
          "high",
          scope,
          `avg ${Math.round(avgPrompt).toLocaleString()} prompt tokens/turn but only ${(cacheHit * 100).toFixed(0)}% served from cache over ${evs.length} turns`,
          "structure stable prefixes (system prompt, file context) first; Anthropic bills cache reads at ~0.1× input",
          "estimated",
          cap
        )
      );
    }

    // R-2 model overspend: opus-tier money on short answers. Delta is the same
    // counterfactual arithmetic burn counterfactual --route would show.
    const priced = evs.filter((e) => e.costSource !== "unpriced" && e.cost != null);
    const estTotal = priced.reduce((a, e) => (e.costSource === "estimate" ? a + e.cost : a), 0);
    const opusEvts = priced.filter((e) => e.costSource === "estimate" && OPUS_TIER.test(e.model || ""));
    const opusEst = opusEvts.reduce((a, e) => a + e.cost, 0);
    const outMed = median(evs.map((e) => e.tokens.output || 0));
    if (estTotal > 0 && opusEst / estTotal >= 0.6 && outMed < 400) {
      const replay = replayAt(opusEvts, pricing, CHEAP_ROUTE);
      findings.push(
        finding(
          "R-2 model overspend",
          "high",
          scope,
          `${((opusEst / estTotal) * 100).toFixed(0)}% of estimated spend is opus-tier while median output is ${outMed} tokens`,
          `route this repo cheaper — replaying its opus turns at ${CHEAP_ROUTE} list price: burn counterfactual (delta in --json)`,
          "estimated",
          replay == null ? null : opusEst - replay
        )
      );
    }
  }

  // R-3 silent migration: a model's weekly token share swings > 2× vs the
  // prior week. Both windows need ≥ 10k tokens — trends need a denominator.
  let end = null;
  for (const ev of events) if (ev.date && ev.date !== "unknown" && (!end || ev.date > end)) end = ev.date;
  if (end) {
    const endMs = Date.parse(end + "T00:00:00Z");
    const win = { now: new Map(), prev: new Map() };
    const winTotal = { now: 0, prev: 0 };
    for (const ev of events) {
      if (!ev.date || ev.date === "unknown") continue;
      const age = (endMs - Date.parse(ev.date + "T00:00:00Z")) / DAY;
      const w = age <= 6 ? "now" : age <= 13 ? "prev" : null;
      if (!w) continue;
      const t = turnTokens(ev.tokens);
      win[w].set(ev.model, (win[w].get(ev.model) || 0) + t);
      winTotal[w] += t;
    }
    if (winTotal.now >= 10_000 && winTotal.prev >= 10_000) {
      for (const [model, nowTok] of win.now) {
        const shareNow = nowTok / winTotal.now;
        const sharePrev = (win.prev.get(model) || 0) / winTotal.prev;
        if ((shareNow >= 0.05 && shareNow > 2 * sharePrev) || (sharePrev >= 0.05 && sharePrev > 2 * shareNow)) {
          findings.push(
            finding(
              "R-3 silent migration",
              "info",
              `model:${model}`,
              `weekly token share moved ${(sharePrev * 100).toFixed(0)}% → ${(shareNow * 100).toFixed(0)}% across the last two weeks`,
              "did your router change? burn reports the trend only — you decide if it was intended",
              "none"
            )
          );
        }
      }
    }
  }

  // R-4 unpriced drift: tokens nobody priced > 25% of the ledger.
  const allTok = events.reduce((a, e) => a + turnTokens(e.tokens), 0);
  const unpricedByModel = new Map();
  for (const ev of events) {
    if (ev.costSource === "unpriced") unpricedByModel.set(ev.model, (unpricedByModel.get(ev.model) || 0) + turnTokens(ev.tokens));
  }
  const unpricedTok = [...unpricedByModel.values()].reduce((a, b) => a + b, 0);
  if (allTok > 0 && unpricedTok / allTok > 0.25) {
    const top = [...unpricedByModel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m]) => m);
    findings.push(
      finding(
        "R-4 unpriced drift",
        "medium",
        "ledger",
        `${((unpricedTok / allTok) * 100).toFixed(0)}% of tokens have no price: ${top.join(", ")}`,
        "teach burn these models in ~/.burn/pricing.json or your ledger stays blind there",
        "none"
      )
    );
  }

  // R-5 spend runaway: the weekly ledger total jumps > 3× between two
  // consecutive weeks. One jump is a trend CANDIDATE, not a trend — hence
  // info severity and both weeks cited.
  if (end) {
    const endMs = Date.parse(end + "T00:00:00Z");
    let w0 = 0, w1 = 0, w0Billed = 0, w0Est = 0;
    for (const ev of events) {
      if (!ev.date || ev.date === "unknown" || ev.cost == null || ev.costSource === "unpriced") continue;
      const age = (endMs - Date.parse(ev.date + "T00:00:00Z")) / DAY;
      if (age <= 6) {
        w0 += ev.cost;
        if (ev.costSource === "store") w0Billed += ev.cost; else w0Est += ev.cost;
      } else if (age <= 13) w1 += ev.cost;
    }
    const wk = (lo, hi) => `${isoDate(endMs - Math.max(lo, hi) * DAY)} → ${isoDate(endMs - Math.min(lo, hi) * DAY)}`;
    if (w1 >= 1 && w0 > 3 * w1) {
      findings.push(
        finding(
          "R-5 spend runaway",
          "info",
          "ledger",
          `weekly spend $${w1.toFixed(2)} (${wk(13, 7)}) → $${w0.toFixed(2)} (${wk(6, 0)}) — ${(w0 / w1).toFixed(1)}× in one step`,
          "one week is a candidate, not a trend — check what changed (new repo, bigger model, longer sessions) before reacting",
          w0Billed >= w0Est ? "billed" : "estimated",
          w0 - w1
        )
      );
    }
  }

  // R-6 orphan spend: estimated dollars in a repo whose local checkout shows
  // ZERO commits over the same window. Read-only git, silent skip for
  // non-repos and for bundle events (no `dir` travels — privacy beats
  // coverage). Observation only; burn never guesses where the work went.
  const ORPHAN_MIN_USD = 5;
  for (const [repo, evs] of byRepo) {
    const est = evs.reduce((a, e) => (e.costSource === "estimate" && e.cost != null ? a + e.cost : a), 0);
    if (est <= ORPHAN_MIN_USD) continue;
    const dir = (evs.find((e) => e.dir) || {}).dir || null;
    let lo = null, hi = null;
    for (const e of evs)
      if (e.date && e.date !== "unknown") {
        if (!lo || e.date < lo) lo = e.date;
        if (!hi || e.date > hi) hi = e.date;
      }
    if (!dir || !lo) continue;
    const commits = commitCount(dir, lo, hi);
    if (commits === null || commits > 0) continue;
    findings.push(
      finding(
        "R-6 orphan spend",
        "medium",
        `repo:${repo}`,
        `$${est.toFixed(2)} of estimated spend ${lo} → ${hi} while the local checkout shows 0 commits in that window`,
        "paid for work that isn't landing? burn only reports what it saw",
        "estimated",
        est
      )
    );
  }

  const sevRank = { high: 0, medium: 1, info: 2 };
  return findings.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || a.rule.localeCompare(b.rule) || a.scope.localeCompare(b.scope));
}
