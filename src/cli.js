#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadPricing } from "./pricing.js";
import { collect, costEvents, aggregateEvents } from "./aggregate.js";
import { loadAttributes, saveAttribute } from "./attribution.js";
import { blameRange } from "./git.js";
import { toBundle, readBundle, mergeBundles, auditBundles, loadRoster, teamView, deviceId } from "./bundle.js";
import { toUlpDocument, validateAgainstUlp, tildePath, ULP_VERSION } from "./ulp/ulp.js";
import { ingestDir, inspectBundle, inspectDoc, storeBundle, storeBundleDoc, loadIngestDocs, listIngested } from "./ulp/ingest.js";
import { runKit } from "./ulp/conformance.js";
import { toOtlp, fromOtlp } from "./ulp/otel.js";
import { historyDir, writeSnapshot, loadSnapshots, listSnapshots, dropSnapshot } from "./history.js";
import { forecast, counterfactual, doctor, plan } from "./advise.js";
import { palette as P, paint, fmtUSD, fmtTokens, bar, pad, truncate } from "./util.js";
import * as claude from "./extractors/claude.js";
import * as opencode from "./extractors/opencode.js";
import * as codex from "./extractors/codex.js";
import * as gemini from "./extractors/gemini.js";

const SOURCES = [claude, opencode, codex, gemini];
const SPEC_VERSION = "2.0"; // SPEC-2 §F: additive over v1's "1.0"

const HELP = `burn — a local ledger for where your AI budget actually goes

It reads the transcripts your coding agents already leave on disk (Claude Code,
OpenCode) and answers: which repo, which model, which agent, how many tokens,
how many dollars, and how much prompt caching saved you. No network, no account,
no telemetry.

usage: burn [command] [options]

commands
  (default)   overall summary + breakdowns
  repos       cost & tokens per repository   (where the money went)
  models      cost & tokens per model
  agents      cost & tokens per coding agent
  daily       day-by-day spend
  sessions    the individual priciest sessions
  work        cost per work unit — branch / commit-adjacent / repo (SPEC-2 §B)
  blame REF   what a branch or commit range cost (e.g. blame feature/pay or A..B)
  attribute SESSION --unit NAME   charge a session to a named unit (overrides git)
  sources     which agents were found, where, and how much data each gave
  budget      exit 3 when a repo's spend in a period exceeds --max (SPEC-2 §C.3)
  forecast    trend + last-7d-mean projection (est-forecast, priced events only)
  counterfactual --route MODEL   replay your ledger at one model's list price
  doctor      deterministic advice R-1..R-6 (advisory, exit 0)
  watch       print cost lines as new agent turns land on disk
  export      write a shareable bundle (deviceId + events; --compact = report-only)
                        --ulp = pure ULP 1.0 core document (schema-validated)
  ingest    accept any conformant ULP ledger (SPEC-3-5 §V3.B); --list, --strict, --otel
  export --otel            write OTLP/JSON to a file (offline transform, §V5.B)
  ingest --otel FILE.json  read OTLP/JSON back into the ledger (lossless-or-loud)
  conformance run the ULP conformance kit (pure-JSON vectors; exit 2 on fail)
  merge       union bundles from many machines into one ledger (recompute-not-sum)
  team        per-human totals from merged bundles
  snapshot    append the current ledger to local history (~/.burn/history, ULP bundles)
  history     ls | drop <file> --yes — inspect or delete local snapshots
  report      monthly markdown digest — tables, provenance, cache economics,
              doctor findings; --month YYYY-MM, -o file.md; safe to commit
  attest      one-page method statement for finance: provenance totals,
              pricingHash, versions, doctor state — explicitly NOT an invoice
  init --team serverless team scaffold: team/usage/ + CI workflow that only
              runs burn + git (its single network step is git push)
  plan        --repo LABEL --budget USD --months N — affordability from the
              linear series; exit 0 affordable / 3 not (budget's gate contract)

options
  --since <YYYY-MM-DD>   only count usage on/after a date
  --history / --no-history  fold local snapshots in via the union identity.
                        Default ON: report, budget --period month|all, forecast;
                        OFF elsewhere so v1/v2 output stays byte-stable (§V4.A)
  --yes                 explicit confirmation for destructive commands
  --month <YYYY-MM>     report window, default current UTC month
  --budget <usd>        plan ceiling in dollars
  --months <n>          plan horizon in (30-day) months, 1–24
  --repo <label>         repository to check (burn budget)
  --max <usd>            budget ceiling in dollars (burn budget)
  --period day|week|month|all   budget window, UTC, default month
  --route <model>        target model to replay at (burn counterfactual)
  --window <days>        forecast sample window, default 30
  --interval <sec>       watch poll interval, default 5
  --confidence <level>   filter work units: native|joined|guess|unattributed
  --only-repo <label>    export only one repository's events
  -o, --out <path>       write export/merge JSON to a file instead of stdout
  --compact              bundle without raw events (report-only transport)
  --ulp                  export: pure ULP 1.0 core document, schema-validated
                        (x-* extensions stripped, workUnits naming, tilde paths)
  --audit                merge: report duplicate deviceIds instead of merging
  --list                 ingest: show stored bundles and what each contributed
  --strict               ingest: estimated-cost mismatches against your pricing
                        table become exit 2 (default: reported, not fatal)
  --otel                 export/ingest speak OTLP/JSON via ulp/otel-mapping.md
                        (file only — burn never opens a collector socket)
  --json                 machine-readable output
  --pricing <path>       extra/override pricing table (JSON)
  -h, --help             this help
  -v, --version

how cost is labeled
  billed    the agent recorded the real dollar amount (OpenCode)
  est.      computed from a pricing table you control (Claude Code)
  unpriced  tokens counted, dollars withheld because the model has no price
`;

function parseArgs(argv) {
  const args = {
    command: "summary", since: null, json: false, pricing: null, unit: null,
    repo: null, max: null, period: "month", interval: 5, confidence: null, route: null, window: 30, until: null,
    out: null, compact: false, audit: false, onlyRepo: null, ulp: false, list: false, strict: false,
    history: null, yes: false, month: null, budget: null, months: null, otel: false, team: false, positional: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--since") args.since = argv[++i];
    else if (a.startsWith("--since=")) args.since = a.slice(8);
    else if (a === "--unit") args.unit = argv[++i];
    else if (a.startsWith("--unit=")) args.unit = a.slice(7);
    else if (a === "--repo") args.repo = argv[++i];
    else if (a.startsWith("--repo=")) args.repo = a.slice(7);
    else if (a === "--only-repo") args.onlyRepo = argv[++i];
    else if (a.startsWith("--only-repo=")) args.onlyRepo = a.slice(12);
    else if (a === "--max") args.max = argv[++i];
    else if (a.startsWith("--max=")) args.max = a.slice(6);
    else if (a === "--period") args.period = argv[++i];
    else if (a.startsWith("--period=")) args.period = a.slice(9);
    else if (a === "--interval") args.interval = argv[++i];
    else if (a.startsWith("--interval=")) args.interval = a.slice(11);
    else if (a === "--confidence") args.confidence = argv[++i];
    else if (a.startsWith("--confidence=")) args.confidence = a.slice(13);
    else if (a === "--route") args.route = argv[++i];
    else if (a.startsWith("--route=")) args.route = a.slice(8);
    else if (a === "--window") args.window = Number(argv[++i]);
    else if (a.startsWith("--window=")) args.window = Number(a.slice(9));
    else if (a === "--month") args.month = argv[++i];
    else if (a.startsWith("--month=")) args.month = a.slice(8);
    else if (a === "--budget") args.budget = argv[++i];
    else if (a.startsWith("--budget=")) args.budget = a.slice(9);
    else if (a === "--months") args.months = argv[++i];
    else if (a.startsWith("--months=")) args.months = a.slice(9);
    else if (a === "-o" || a === "--out") args.out = argv[++i];
    else if (a.startsWith("--out=")) args.out = a.slice(6);
    else if (a === "--compact") args.compact = true;
    else if (a === "--audit") args.audit = true;
    else if (a === "--ulp") args.ulp = true;
    else if (a === "--list") args.list = true;
    else if (a === "--strict") args.strict = true;
    else if (a === "--history") args.history = true;
    else if (a === "--no-history") args.history = false;
    else if (a === "--yes") args.yes = true;
    else if (a === "--otel") args.otel = true;
    else if (a === "--team") args.team = true;
    else if (a === "--json") args.json = true;
    else if (a === "--pricing") args.pricing = argv[++i];
    else if (a.startsWith("--pricing=")) args.pricing = a.slice(10);
    else if (a === "-h" || a === "--help") args.command = "help";
    else if (a === "-v" || a === "--version") args.command = "version";
    else if (!a.startsWith("-")) args.positional.push(a);
  }
  if (args.positional[0]) args.command = args.positional[0];
  return args;
}

// SPEC-2 §C.3: budget periods are UTC-aligned; "all" means no since filter.
function periodSince(period) {
  if (period === "all") return null;
  const now = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  if (period === "day") return `${now.toISOString().slice(0, 10)}`;
  if (period === "month") return `${now.toISOString().slice(0, 7)}-01`;
  if (period === "week") {
    const dow = (now.getUTCDay() + 6) % 7; // 0 = Monday
    const mon = new Date(now.getTime() - dow * 86400000);
    return `${mon.getUTCFullYear()}-${p2(mon.getUTCMonth() + 1)}-${p2(mon.getUTCDate())}`;
  }
  console.error(paint(P.red, `burn: --period must be day|week|month|all (got "${period}")`));
  process.exit(2);
}

function loadUserPricing(cliPath) {
  const candidates = [cliPath, path.join(os.homedir(), ".burn", "pricing.json")].filter(Boolean);
  for (const c of candidates) {
    let raw;
    try {
      if (!fs.statSync(c).isFile()) continue;
      raw = fs.readFileSync(c, "utf8");
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      console.error(paint(P.yellow, `burn: ignoring ${c}: expected an object of {model: prices}`));
    } catch {
      // SPEC §4: malformed overrides are warned about and ignored, never fatal.
      console.error(paint(P.yellow, `burn: ignoring malformed JSON at ${c}`));
    }
  }
  return {};
}

// SPEC-3-5 §V4.A: --history default is per-command. ON where the question is
// inherently historical; OFF elsewhere so v1/v2 consumers see stable numbers.
function historyOn(cmd, args) {
  if (args.history !== null) return args.history;
  if (cmd === "forecast" || cmd === "report" || cmd === "attest" || cmd === "plan") return true;
  if (cmd === "budget" && (args.period === "month" || args.period === "all")) return true;
  return false;
}

async function gather(args, extra = {}, useHistory = false) {
  const pricing = await loadPricing(loadUserPricing(args.pricing));
  const active = SOURCES.filter((m) => m.available());
  const attributes = loadAttributes();
  const live = await costEvents(active, pricing, { since: args.since, until: args.until });
  const { docs: ingestDocs } = loadIngestDocs(pricing);
  const { docs: historyDocs, skipped } = useHistory ? loadSnapshots() : { docs: [], skipped: [] };
  for (const s of skipped) {
    console.error(paint(P.yellow, `burn: ignoring unreadable snapshot ${s.file} (${s.reason})`));
  }
  let ledger;
  const others = [...historyDocs, ...ingestDocs];
  if (others.length) {
    // §V3.B/§E.2/§V4.A: external bundles join every command through the union
    // identity, and mergeBundles is FIRST-WINS — so document order IS the
    // tie-break: live first (live beats everything), snapshots newest-first
    // (newer beats older), then ingested bundles.
    const inWindow = (ev) =>
      (!args.since || (ev.date !== "unknown" && ev.date >= args.since)) &&
      (!args.until || (ev.date !== "unknown" && ev.date < args.until));
    const docs = [{ deviceId: deviceId(), events: live }, ...others.map((d) => ({ ...d, events: d.events.filter(inWindow) }))];
    ledger = mergeBundles(docs, { attributes });
    if (!extra.includeEvents) delete ledger.events;
  } else {
    ledger = aggregateEvents(live, { attributes, ...extra });
  }
  return { ledger, active, pricing };
}

function header(text) {
  console.log();
  console.log(text);
  console.log(paint(P.gray, "─".repeat(60)));
}

function provenance(src) {
  const parts = [];
  if (src.store) parts.push(`${src.store} billed`);
  if (src.estimate) parts.push(`${src.estimate} estimated`);
  if (src.unpriced) parts.push(`${src.unpriced} unpriced`);
  return paint(P.gray, "  " + parts.join(" · ") + " cost events");
}

function toRows(buckets) {
  const max = Math.max(1e-9, ...buckets.map((b) => b.cost));
  return buckets.map((b) => ({
    label: b.key,
    frac: b.cost / max,
    cost: b.cost,
    tokens: b.tokens.input + b.tokens.output,
    cacheHit: b.cacheHit,
  }));
}

function table(rows) {
  for (const r of rows) {
    console.log(
      `${pad(r.label, 24)} ${bar(r.frac)} ${paint(P.bold, pad(fmtUSD(r.cost), 10))} ` +
        `${paint(P.gray, pad(fmtTokens(r.tokens) + " tok", 11))}` +
        paint(P.gray, `cache ${(r.cacheHit * 100).toFixed(0)}%`)
    );
  }
}

function section(title, buckets, limit) {
  buckets = buckets.filter(
    (b) => (b.tokens.input + b.tokens.output) > 0 || b.cost > 0 || b.tokens.cacheRead > 0
  );
  if (!buckets.length) return;
  header(paint(P.bold + P.cyan, title));
  table(toRows(buckets.slice(0, limit)));
}

function empty() {
  console.error(
    paint(
      P.yellow,
      "burn: no supported agent data found.\n" +
        "  Looked for Claude Code under ~/.claude/projects and OpenCode at\n" +
        "  ~/.local/share/opencode/opencode.db. Point BURN_CLAUDE_DIR or\n" +
        "  BURN_OPENCODE_DB somewhere, or run an agent first.\n" +
        "  burn sources lists every path checked."
    )
  );
  process.exit(1);
}

function extractorMissing(ledger) {
  // With ingest (§V3.B) a machine with zero local transcripts can still hold a
  // real ledger — emptiness is about EVENTS, not about found extractors.
  return ledger.totals.events === 0;
}

function renderWork(units) {
  if (!units.length) return;
  header(paint(P.bold + P.cyan, "By work unit") + paint(P.gray, "  (SPEC-2 §B: explicit > branch > repo fallback)"));
  const max = Math.max(1e-9, ...units.map((u) => u.cost));
  for (const u of units) {
    console.log(
      `${pad(u.unit.name, 20)} ${pad(`[${u.unit.kind}]`, 10)} ${pad(u.unit.confidence, 11)} ` +
        `${bar(u.cost / max)} ${paint(P.bold, pad(fmtUSD(u.cost), 10))} ` +
        `${paint(P.gray, fmtTokens(u.tokens.input + u.tokens.output) + " tok")}`
    );
  }
}

function renderBlameBranch(ref, units) {
  const hits = units.filter(
    (u) => u.unit.kind === "branch" && (u.unit.name === ref || u.unit.name.includes(ref))
  );
  if (!hits.length) {
    console.error(paint(P.yellow, `burn blame: no branch work unit matches "${ref}".`));
    const branches = units.filter((u) => u.unit.kind === "branch").map((u) => u.unit.name);
    if (branches.length) console.error(paint(P.gray, `  known branches: ${branches.slice(0, 8).join(", ")}`));
    process.exit(1);
  }
  header(paint(P.bold + P.cyan, `Branch blame (native): ${ref}`));
  renderWork(hits);
}

function renderBlameRange(refA, refB, events) {
  const rows = blameRange(events, refA, refB);
  if (!rows.length) {
    console.error(
      paint(P.yellow, `burn blame: no usage joined to ${refA}..${refB} (needs dated events inside a readable git repo).`)
    );
    process.exit(1);
  }
  header(paint(P.bold + P.cyan, `Range blame (joined): ${refA}..${refB}`));
  const max = Math.max(1e-9, ...rows.map((r) => r.cost));
  for (const r of rows) {
    const win = r.window.map((s) => new Date(s * 1000).toISOString().slice(0, 16)).join(" → ");
    console.log(
      `${pad(r.repo, 20)} ${pad("[joined]", 10)} ${bar(r.cost / max)} ${paint(P.bold, pad(fmtUSD(r.cost), 10))} ` +
        `${paint(P.gray, `${r.events} evts · ${win}`)}`
    );
  }
}

function agentBucket(ledger, label) {
  return ledger.agents.find((a) => a.key === label) || null;
}

function costClasses(b) {
  const parts = [];
  if (b.store > 0) parts.push("billed");
  if (b.estimate > 0) parts.push("estimated");
  if (b.unpricedEvents > 0) parts.push("unpriced");
  return parts.join("+") || "—";
}

// SPEC-2 §A.2: every adapter reports its resolved path and what it yielded,
// including sources that were NOT found — this is "why is my number small".
function sourcesDoc(ledger) {
  return SOURCES.map((s) => {
    const b = agentBucket(ledger, s.label);
    return {
      agent: s.label,
      path: s.rootPath(),
      found: s.available(),
      events: b ? b.events : 0,
      firstDate: b ? b.firstDate : null,
      lastDate: b ? b.lastDate : null,
      cost: b ? b.cost : 0,
      costClasses: b ? costClasses(b) : "—",
    };
  });
}

function renderSources(ledger) {
  header(paint(P.bold + P.cyan, "Sources") + paint(P.gray, "  (SPEC-2 §A.2 — what burn found on this machine)"));
  for (const row of sourcesDoc(ledger)) {
    const mark = row.found ? paint(P.green, "✓") : paint(P.red, "✗");
    const span = row.firstDate ? `${row.firstDate} → ${row.lastDate}` : "no events";
    console.log(
      `${mark} ${pad(row.agent, 14)} ${pad(`${row.events} evts`, 10)} ` +
        `${paint(P.gray, pad(span, 26))} ${pad(fmtUSD(row.cost), 10)} ${paint(P.gray, row.costClasses)}`
    );
    console.log(paint(P.gray, `    ${row.path}${row.found ? "" : "  (not present)"}`));
  }
}

function runBudget(args, ledger) {
  let hits = ledger.repos.filter((r) => r.key === args.repo);
  let note = null;
  if (!hits.length) {
    const loose = ledger.repos.filter((r) => r.key.toLowerCase().includes(args.repo.toLowerCase()));
    if (loose.length === 1) {
      hits = loose;
      note = `matched "${loose[0].key}"`;
    } else {
      const candidates = (loose.length ? loose : ledger.repos).slice(0, 10).map((r) => r.key);
      console.error(
        paint(
          P.yellow,
          loose.length
            ? `burn budget: "${args.repo}" partially matches ${loose.length} repos — use an exact label.`
            : `burn budget: no repository matches "${args.repo}".`
        )
      );
      if (candidates.length) console.error(paint(P.gray, `  known repos: ${candidates.join(", ")}`));
      process.exit(2);
    }
  }
  if (hits.length > 1) {
    console.error(paint(P.red, `burn budget: "${args.repo}" is ambiguous (${hits.map((h) => h.key).join(", ")})`));
    process.exit(2);
  }
  const b = hits[0];
  const over = b.cost > args.max;
  const frac = args.max > 0 ? b.cost / args.max : 1;
  if (args.json) {
    console.log(
      JSON.stringify(
        {
          specVersion: SPEC_VERSION,
          repo: b.key,
          period: args.period,
          since: args.since,
          cost: b.cost,
          max: args.max,
          over,
          events: b.events,
          unpricedEvents: b.unpricedEvents,
          matchedLabel: b.key,
        },
        null,
        2
      )
    );
    process.exit(over ? 3 : 0);
  }
  header(
    paint(P.bold + P.cyan, `Budget check: ${b.key}`) +
      paint(P.gray, `  ${args.period}${args.since ? ` since ${args.since}` : ""} · priced events only`) +
      (note ? paint(P.yellow, `  (fuzzy ${note})`) : "")
  );
  console.log(
    `${bar(Math.min(frac, 1))} ${paint(P.bold, pad(fmtUSD(b.cost), 10))} of ${fmtUSD(args.max)} ` +
      (b.unpricedEvents ? paint(P.gray, `(${b.unpricedEvents} unpriced events counted as $0)`) : "")
  );
  console.log(
    over
      ? paint(P.bold + P.red, `OVER BUDGET by ${fmtUSD(b.cost - args.max)} — exit 3`)
      : paint(P.bold + P.green, `under budget — exit 0`)
  );
  process.exit(over ? 3 : 0);
}

// SPEC-2 §G: pure fs polling on an interval; never a daemon, never a SQLite
// write path — each cycle re-queries what the extractors already expose.
async function runWatch(args) {
  const interval = Number(args.interval);
  if (!Number.isFinite(interval) || interval < 1 || interval > 3600) {
    console.error(paint(P.red, "burn watch: --interval must be a sane number of seconds (1–3600)"));
    process.exit(2);
  }
  {
    const { ledger } = await gather(args, { includeEvents: true });
    if (extractorMissing(ledger)) return empty();
  }
  console.log(
    paint(P.green, "🔥 burn watch") +
      paint(P.gray, `  new agent turns every ${interval}s — Ctrl-C to stop. History is not replayed.`)
  );
  // Per-session watermark of reported turns. Extractors emit a session's
  // events in stable file order, so any turn past the watermark is brand new —
  // and two identical turns in one second are still reported separately.
  const pollMs = interval * 1000;
  let seen = new Map();
  let primed = false;
  for (;;) {
    const { ledger } = await gather(args, { includeEvents: true });
    const counts = new Map();
    for (const ev of ledger.events) {
      const k = `${ev.agent}:${ev.sessionId}`;
      const idx = counts.get(k) || 0;
      counts.set(k, idx + 1);
      if (primed && idx >= (seen.get(k) || 0)) {
        const when = ev.ts ? new Date(ev.ts).toISOString().slice(11, 19) : "--:--:--";
        const dollars = ev.cost != null ? paint(P.bold, `+${fmtUSD(ev.cost)}`) : paint(P.yellow, "unpriced");
        console.log(
          `${paint(P.gray, when)} ${pad(ev.agent, 12)} ${pad(truncate(ev.repo, 14), 15)} ` +
            `${pad(truncate(ev.model, 24), 25)} ${pad(dollars, 12)} ` +
            `${paint(P.gray, `${fmtTokens(ev.tokens.input + ev.tokens.output)} tok`)}`
        );
      }
    }
    seen = counts;
    primed = true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

function renderForecast(f) {
  header(paint(P.bold + P.cyan, "Forecast") + paint(P.gray, `  ${f.label} · priced events only · sample window ${f.windowDays}d ending ${f.end || "—"}`));
  if (!f.total) {
    console.log(paint(P.gray, "  no priced events to project; tokens may still be unpriced."));
  } else {
    console.log(
      `  next 7d  ${paint(P.bold, fmtUSD(f.total.linearNext7))} (trend)  ·  ${fmtUSD(f.total.last7MeanNext7)} (7d-mean)  ` +
        paint(P.gray, `|  next 30d  ${fmtUSD(f.total.linearNext30)}` + (f.total.slope >= 0 ? "  ↗" : "  ↘"))
    );
    if (f.byRepo.length > 1) {
      const max = Math.max(1e-9, ...f.byRepo.map((r) => Math.max(r.linearNext30, 0)));
      for (const r of f.byRepo.slice(0, 8)) {
        console.log(`${pad(r.repo, 24)} ${bar(Math.max(0, r.linearNext30) / max)} ${paint(P.bold, pad(fmtUSD(r.linearNext30), 10))} ${paint(P.gray, "30d")}`);
      }
    }
  }
  if (f.unpricedTokens > 0) {
    console.log(paint(P.yellow, `  + ${fmtTokens(f.unpricedTokens)} tokens unpriced — never projected into dollars`));
  }
}

function renderCounterfactual(cf) {
  header(paint(P.bold + P.cyan, `Counterfactual: replay at ${cf.route}`) + paint(P.gray, `  ${cf.label}`));
  console.log(
    `  as it happened  ${paint(P.bold, fmtUSD(cf.asItHappened))} ` +
      paint(P.gray, `(${fmtUSD(cf.billed)} billed · ${fmtUSD(cf.estimated)} estimated)`)
  );
  if (cf.unpriceable) {
    console.log(paint(P.yellow, `  replay          — (${cf.route} has no price in your table; burn will not claim savings it cannot compute)`));
  } else {
    console.log(
      `  replay          ${paint(P.bold, fmtUSD(cf.replay))} ` +
        paint(P.gray, `→ ${cf.delta >= 0 ? "would have saved " : "would have cost extra "}${fmtUSD(Math.abs(cf.delta))}`)
    );
  }
  console.log(paint(P.gray, "  estimate-of-estimate: replayed dollars are list-price arithmetic over recorded tokens, not a quote."));
}

function renderDoctor(findings) {
  header(paint(P.bold + P.cyan, "Doctor") + paint(P.gray, "  deterministic rules R-1..R-6 (SPEC-2 §D + SPEC-3-5 §V4.C) — advisory, exit 0"));
  if (!findings.length) {
    console.log(paint(P.green, "  no findings — cache discipline, model mix, drift and pricing all look healthy."));
    return;
  }
  const sevColor = { high: P.red, medium: P.yellow, info: P.cyan };
  for (const f of findings) {
    console.log(`${paint(sevColor[f.severity] || P.gray, `● ${f.rule}`)} ${paint(P.gray, `(${f.severity}) — ${f.scope}`)}`);
    console.log(`    ${f.observation}`);
    console.log(`    ${paint(P.gray, "→ " + f.suggested)}  ${paint(P.gray, `[impact: ${f.estImpactClass}${f.estImpactUsd != null ? " " + fmtUSD(f.estImpactUsd) : ""}]`)}`);
  }
}

// SPEC-2 §C/§D forward money. Shared by --json and text so both never diverge.
function forwardMoney(cmd, args, ledger, pricing) {
  const events = ledger.events || [];
  if (cmd === "forecast") {
    const f = forecast(events, { windowDays: args.window });
    if (args.json) return console.log(JSON.stringify({ specVersion: SPEC_VERSION, forecast: f }, null, 2));
    return renderForecast(f);
  }
  if (cmd === "counterfactual") {
    const cf = counterfactual(events, pricing, args.route);
    if (args.json) return console.log(JSON.stringify({ specVersion: SPEC_VERSION, counterfactual: cf }, null, 2));
    return renderCounterfactual(cf);
  }
  const findings = doctor(events, pricing);
  if (args.json) return console.log(JSON.stringify({ specVersion: SPEC_VERSION, findings }, null, 2));
  return renderDoctor(findings);
}

// SPEC-2 §E bundle commands.
// A bundle is a SHAREABLE file (P3): absolute store paths never travel,
// even in the non---ulp burn flavor — tilde-form or omit, always.
// SPEC-3-5 §V5.C: hash the table ONLY when it actually priced something;
// an all-billed/unpriced ledger gets the stable null marker, never a hash
// of nothing.
function pricingHashFor(ledger, pricing) {
  return ledger.sources.estimate > 0 ? pricing.tableHash() : null;
}

function shareableSupportedAgents() {
  return SOURCES.map((s) => {
    const t = tildePath(s.rootPath());
    return t === null ? { id: s.label, status: "ready" } : { id: s.label, storePath: t, status: "ready" };
  });
}

// SPEC-3-5 §V4.A: history is written as an ordinary, schema-valid ULP bundle.
function ulpSnapshotDoc(ledger, pricing) {
  const doc = toUlpDocument(
    toBundle(ledger, { supportedAgents: shareableSupportedAgents(), pricingHash: pricingHashFor(ledger, pricing) })
  );
  const errors = validateAgainstUlp(doc);
  if (errors.length) {
    console.error(paint(P.red, `burn snapshot: refusing to store a document that violates ulp/schema-1.0.json (${errors.length} errors):`));
    for (const e of errors.slice(0, 10)) console.error(paint(P.gray, "  " + e));
    process.exit(2);
  }
  return doc;
}

function runExport(args, ledger, pricing) {
  let events = ledger.events || [];
  if (args.onlyRepo) {
    events = events.filter((e) => e.repo === args.onlyRepo || e.repo.toLowerCase().includes(args.onlyRepo.toLowerCase()));
    if (!events.length) {
      console.error(paint(P.yellow, `burn export: no events for repo "${args.onlyRepo}".`));
      process.exit(1);
    }
    ledger = aggregateEvents(events, { attributes: loadAttributes(), includeEvents: true });
  }
  let doc = toBundle(ledger, {
    supportedAgents: shareableSupportedAgents(),
    compact: args.compact,
    pricingHash: pricingHashFor(ledger, pricing),
  });
  if (args.otel && args.compact) {
    console.error(paint(P.red, "burn export --otel: OTLP spans ARE the events — drop --compact"));
    process.exit(2);
  }
  if (args.ulp || args.otel) {
    // SPEC-3-5 §V3.A: a pure-core ULP document, validated against the schema
    // before it leaves the machine. If burn can't satisfy its own protocol,
    // that's a bug — refuse loudly instead of shipping a bad bundle.
    doc = toUlpDocument(doc);
    const errors = validateAgainstUlp(doc);
    if (errors.length) {
      console.error(paint(P.red, `burn export --ulp: generated document violates ulp/schema-1.0.json (${errors.length} errors):`));
      for (const e of errors.slice(0, 10)) console.error(paint(P.gray, "  " + e));
      process.exit(2);
    }
  }
  let json;
  if (args.otel) {
    // SPEC-3-5 §V5.B: pure offline transform to OTLP/JSON — a file, never a
    // socket. Lossless-or-loud: any unrepresentable field fails the command.
    const { otlp, summary } = toOtlp(doc);
    if (summary.dropped.length) {
      console.error(paint(P.red, `burn export --otel: LOSSY transform — these ULP fields have no OTel or ulp.* slot: ${summary.dropped.join(", ")}`));
      console.error(paint(P.gray, "  fix ulp/otel-mapping.md (and the pin) or refuse to export; silence is a conformance failure [28]"));
      process.exit(2);
    }
    json = JSON.stringify(otlp, null, 2);
    console.error(
      paint(P.gray, `OTLP/JSON: ${summary.spans} spans · ${summary.mapped.length} gen_ai.* attrs · ` +
        `${summary.namespaced.length} documented ulp.* attrs · 0 dropped · ${summary.buckets}`)
    );
  } else {
    json = JSON.stringify(doc, null, args.compact ? 0 : 2);
  }
  if (args.out) {
    fs.writeFileSync(args.out, json + "\n");
    console.log(paint(P.green, `burn: wrote ${args.otel ? "OTLP/JSON" : args.ulp ? "ULP bundle" : "bundle"} → ${args.out}`) + paint(P.gray, `  (${(Buffer.byteLength(json) / 1024).toFixed(0)} KB, ${doc.events ? doc.events.length : 0} events)`));
  } else {
    console.log(json);
  }
}

function loadBundles(files) {
  const docs = [];
  for (const f of files) {
    try {
      docs.push(Object.assign(readBundle(f), { __file: f }));
    } catch (e) {
      console.error(paint(P.red, e.message || String(e)));
      process.exit(2);
    }
  }
  return docs;
}

async function runMerge(args, files) {
  const docs = loadBundles(files);
  const merged = mergeBundles(docs, { attributes: loadAttributes() });
  if (args.audit) {
    const audit = auditBundles(docs);
    if (args.json) return console.log(JSON.stringify({ specVersion: SPEC_VERSION, audit }, null, 2));
    header(paint(P.bold + P.cyan, `Bundle audit — ${audit.bundles} bundle(s), ${audit.distinctDevices} device(s)`));
    if (audit.ok) return console.log(paint(P.green, "  no duplicate deviceIds — safe to merge."));
    for (const d of audit.duplicates) console.log(paint(P.red, `  ⚠ deviceId ${d.deviceId} appears in: ${d.files.join(", ")}`));
    console.log(paint(P.yellow, "  a copied ~/.burn/id means two humans share one id; their identical-index events would collide. Re-run export after fixing."));
    return;
  }
  if (args.json) {
    const pricing = await loadPricing(loadUserPricing(args.pricing));
    const doc = toBundle(merged, {
      supportedAgents: SOURCES.map((s) => ({ id: s.label, status: "ready" })),
      compact: args.compact,
      pricingHash: pricingHashFor(merged, pricing),
    });
    return console.log(JSON.stringify(doc, null, args.compact ? 0 : 2));
  }
  const t = merged.totals;
  console.log(paint(P.bold + P.green, "🔥 burn merge") + paint(P.gray, `  ${docs.length} bundle(s) from ${new Set(docs.map((d) => d.deviceId)).size} device(s) · ${t.events} events · recompute-not-sum`));
  const promptTok = t.tokens.cacheRead + t.tokens.cacheWrite + t.tokens.input;
  header(`${paint(P.bold + P.green, fmtUSD(t.cost))} merged · ${fmtTokens(t.tokens.input + t.tokens.output)} tok · cache ${((merged.cacheHit * 100) | 0)}% of ${fmtTokens(promptTok)}`);
  console.log(provenance(merged.sources));
  section("By repository (merged)", merged.repos, 15);
  section("By agent (merged)", merged.agents, 8);
}

function runTeam(args, files) {
  const docs = loadBundles(files);
  const merged = mergeBundles(docs, { attributes: loadAttributes() });
  const view = teamView(merged, loadRoster());
  if (args.json) return console.log(JSON.stringify({ specVersion: SPEC_VERSION, team: view }, null, 2));
  header(paint(P.bold + P.cyan, "Team totals") + paint(P.gray, "  (deviceId = a human; names only via local ~/.burn/roster.json)"));
  const max = Math.max(1e-9, ...view.humans.map((h) => h.cost));
  for (const h of view.humans) {
    console.log(
      `${pad(h.label, 18)} ${bar(h.cost / max)} ${paint(P.bold, pad(fmtUSD(h.cost), 10))} ` +
        paint(P.gray, `${h.events} evts · ${h.repos} repos`)
    );
  }
  section("By repository (team)", view.repos, 15);
}

// SPEC-3-5 §V3.B ingest command.
async function runIngest(args) {
  if (args.list) {
    const rows = listIngested();
    if (args.json) {
      console.log(JSON.stringify({ specVersion: SPEC_VERSION, ingestDir: ingestDir(), bundles: rows }, null, 2));
      return;
    }
    header(paint(P.bold + P.cyan, "Ingested ledgers") + paint(P.gray, `  (validated ULP bundles under ${ingestDir()})`));
    if (!rows.length) {
      console.log(paint(P.gray, "  nothing ingested yet — burn ingest <file|dir>"));
      return;
    }
    for (const r of rows) {
      const dev = r.deviceId ? r.deviceId.slice(0, 8) : "—";
      console.log(
        `${pad(r.file.replace(/\.json$/, ""), 18)} ${pad(dev, 10)} ${pad(r.generatedAt ? r.generatedAt.slice(0, 10) : "—", 12)} ` +
          `${pad(`${r.events} evts`, 10)} ${pad(fmtUSD(r.cost), 10)}` +
          (r.readable ? "" : paint(P.red, "  (unreadable — skipped in reports)"))
      );
    }
    return;
  }

  const targets = args.positional.slice(1);
  if (!targets.length) {
    console.error(paint(P.red, "usage: burn ingest <bundle.json|dir> [...] [--strict]"));
    process.exit(2);
  }
  const files = [];
  for (const t of targets) {
    let st;
    try {
      st = fs.statSync(t);
    } catch {
      console.error(paint(P.red, `burn ingest: cannot read ${t}`));
      process.exit(2);
    }
    if (st.isDirectory()) {
      files.push(...fs.readdirSync(t).filter((f) => f.endsWith(".json")).sort().map((f) => path.join(t, f)));
    } else files.push(t);
  }
  if (!files.length) {
    console.error(paint(P.red, "burn ingest: no .json bundles found in the given paths"));
    process.exit(2);
  }

  const pricing = await loadPricing(loadUserPricing(args.pricing));
  let totalEvents = 0;
  let totalMismatches = 0;
  let newBundles = 0;
  for (const f of files) {
    let inspected, stored;
    try {
      if (args.otel) {
        // SPEC-3-5 §V5.B inverse: OTLP/JSON file → ULP bundle, then the
        // EXACT same negotiate/validate/mismatch pipeline as plain ingest.
        const bundle = fromOtlp(JSON.parse(fs.readFileSync(f, "utf8")));
        inspected = inspectDoc(bundle, path.basename(f), pricing);
        stored = storeBundleDoc(inspected.doc);
      } else {
        inspected = inspectBundle(f, pricing);
        stored = storeBundle(f);
      }
    } catch (e) {
      console.error(paint(P.red, e.message || String(e)));
      process.exit(2); // validation failure = input problem (exit 2)
    }
    if (inspected.warn) console.error(paint(P.yellow, `burn ingest: ${path.basename(f)} — ${inspected.warn}`));
    const { hash, created } = stored;
    if (created) newBundles++;
    totalEvents += inspected.doc.events.length;
    const mm = inspected.mismatches;
    totalMismatches += mm.length;
    const status = created ? paint(P.green, "stored") : paint(P.gray, "already present");
    console.log(
      `${pad(path.basename(f), 28)} ${pad(`${inspected.doc.events.length} evts`, 10)} ` +
        `${pad(fmtUSD(inspected.doc.totals?.cost ?? 0), 10)} ${status} ${paint(P.gray, `→ ${hash}.json`)}`
    );
    if (mm.length) {
      console.error(
        paint(P.yellow, `  ⚠ ${mm.length} estimated-cost mismatch(es) against YOUR pricing table — recorded dollars are kept as-is; top: `) +
          mm.slice(0, 3).map((m) => `${m.model} (claims ${fmtUSD(m.claimed)}, table says ${fmtUSD(m.recomputed)})`).join(", ")
      );
      console.error(paint(P.gray, "  mismatch means their table, a reroute, or staleness differs from yours — burn never rewrites history it doesn't own."));
    }
  }
  console.log(
    paint(P.green, `burn: ${files.length} bundle(s) validated`) +
      paint(P.gray, ` · ${newBundles} new · ${totalEvents} events join every report via §E.2 union`) +
      (totalMismatches ? paint(P.yellow, ` · ${totalMismatches} cost mismatches reported`) : "")
  );
  if (args.strict && totalMismatches > 0) process.exit(2);
}

// ---------- report (SPEC-3-5 §V4.B) ----------

function mdBucketTable(title, buckets, labelHead) {
  const rows = buckets.filter((b) => b.events > 0);
  if (!rows.length) return [];
  const out = [`## ${title}`, "", `| ${labelHead} | events | cost | tokens | cache |`, "|---|---:|---:|---:|---:|"];
  for (const b of rows.slice(0, 20)) {
    out.push(
      `| ${b.key.replace(/\|/g, "\\|")} | ${b.events} | $${b.cost.toFixed(4)} | ` +
        `${(b.tokens.input + b.tokens.output).toLocaleString("en-US")} | ${(b.cacheHit * 100).toFixed(0)}% |`
    );
  }
  out.push("");
  return out;
}

function runReport(args, ledger, pricing) {
  const t = ledger.totals;
  const md = [];
  md.push(`# burn report — ${args.month}`);
  md.push("");
  md.push(`Window ${args.since} → ${args.until} (UTC, exclusive). ${t.events} events across ` +
    `${ledger.agents.length} agent(s), ${ledger.repos.length} repo(s).`);
  md.push("");
  md.push(`**Total: $${t.cost.toFixed(4)}** · ${(t.tokens.input + t.tokens.output).toLocaleString("en-US")} tokens`);
  md.push("");
  md.push(`Cost provenance: ${ledger.sources.store} billed (recorded by the agent) · ` +
    `${ledger.sources.estimate} estimated (local pricing table) · ` +
    `${ledger.sources.unpriced} unpriced (tokens counted, dollars withheld).`);
  md.push("");
  const promptTok = t.tokens.cacheRead + t.tokens.cacheWrite + t.tokens.input;
  md.push(`## Cache economics`, "");
  md.push(`- cache hit rate: **${(ledger.cacheHit * 100).toFixed(1)}%** ` +
    `(${t.tokens.cacheRead.toLocaleString("en-US")} cached of ${promptTok.toLocaleString("en-US")} prompt tokens)`);
  md.push("");
  md.push(...mdBucketTable("By repository", ledger.repos, "repo"));
  md.push(...mdBucketTable("By model", ledger.models, "model"));
  md.push(...mdBucketTable("By agent", ledger.agents, "agent"));
  const unitRows = ledger.units.map((u) => ({ ...u, key: `${u.unit.name} \`${u.unit.kind}/${u.unit.confidence}\`` }));
  md.push(...mdBucketTable("By work unit", unitRows, "unit"));
  const findings = doctor(ledger.events || [], pricing);
  md.push("## Doctor", "");
  if (!findings.length) md.push("No findings — cache discipline, model mix, drift and pricing all look healthy.", "");
  for (const f of findings) {
    md.push(`- **${f.rule}** (${f.severity}, ${f.scope}): ${f.observation}`);
    md.push(`  - suggested: ${f.suggested}`);
  }
  md.push("");
  md.push(`_Generated locally by burn — no network, no paths, no session content; safe to commit._`);
  const text = md.join("\n") + "\n";
  if (args.json) {
    console.log(JSON.stringify({ specVersion: SPEC_VERSION, month: args.month, markdown: text }, null, 2));
    return;
  }
  if (args.out) {
    fs.writeFileSync(args.out, text);
    console.log(paint(P.green, `burn: report → ${args.out}`));
    return;
  }
  console.log(text);
}

// ---------- attest (SPEC-3-5 §V5.C) ----------

function runAttest(args, ledger, pricing) {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const t = ledger.totals;
  const ph = pricingHashFor(ledger, pricing);
  const findings = doctor(ledger.events || [], pricing);
  const md = [];
  md.push(`# burn attestation — ${args.month}`);
  md.push("");
  md.push(`*A statement of method, **not an invoice**: estimated dollars are list-price`);
  md.push(`arithmetic over recorded tokens; price authority belongs to the providers (N1).*`);
  md.push("");
  md.push(`Issued ${new Date().toISOString()} · burn ${pkg.version} · ledger specVersion ${SPEC_VERSION} · ULP ${ULP_VERSION}.`);
  md.push("");
  md.push("## Measured");
  md.push(`- window ${args.since} → ${args.until} (UTC, exclusive), local snapshot history merged under §E.2 union`);
  md.push(`- ${t.events} usage events · ${ledger.agents.length} agent(s) · ${ledger.repos.length} repository/repositories`);
  md.push(`- ${(t.tokens.input + t.tokens.output).toLocaleString("en-US")} tokens (input + output)`);
  md.push("");
  md.push("## Cost by provenance class");
  md.push(`- billed (recorded by the agent): **$${t.store.toFixed(4)}**`);
  md.push(`- estimated (local pricing table): **$${t.estimate.toFixed(4)}**`);
  md.push(`- unpriced events (tokens counted, dollars withheld): ${ledger.sources.unpriced}`);
  md.push(`- **total: $${t.cost.toFixed(4)}**`);
  md.push("");
  md.push("## Reproducibility");
  md.push(`- pricingHash: \`${ph ?? "null — no pricing table applied to this ledger"}\` (sha256 over the effective table, 12 hex)`);
  md.push(`- same events + same table ⇒ identical totals; the ULP conformance kit (two independent implementations) enforces it`);
  md.push("");
  md.push("## Advice state");
  md.push(`- doctor: ${findings.length ? findings.map((f) => `${f.rule} (${f.severity})`).join("; ") : "no findings"}`);
  md.push("");
  md.push("_Contains no absolute paths, no hostname, no per-model prices, no session content._");
  const text = md.join("\n") + "\n";
  if (args.json) {
    console.log(JSON.stringify({ specVersion: SPEC_VERSION, month: args.month, pricingHash: ph, markdown: text }, null, 2));
    return;
  }
  if (args.out) {
    fs.writeFileSync(args.out, text);
    console.log(paint(P.green, `burn: attestation → ${args.out}`));
    return;
  }
  console.log(text);
}

// ---------- init (SPEC-3-5 §V5.D) ----------

const BURN_GENERATED = "generated by burn init --team";

const TEAM_USAGE_README = `# team/usage — burn bundles, git as the sync protocol

<!-- ${BURN_GENERATED} -->

Each machine (or the CI on one) drops a ULP bundle here:

    burn export --ulp -o team/usage/this-box.ulp.json

Commit, push — anyone reads the team ledger with no backend:

    burn merge team/usage/*.ulp.json
    burn team  team/usage/*.ulp.json

Bundles carry deviceId + hostname HASH only: no absolute paths, no session
content (ULP privacy P1–P4). Merge is union-by-identity and recompute-not-sum,
so even a file committed twice cannot double-count.
`;

const TEAM_WORKFLOW = `# ${BURN_GENERATED}
name: burn-usage

# Cron snapshot -> commit bundle -> push a branch; open the PR from the
# compare link the push prints (one click, no API token).
#
# burn is measurement-only and offline, and so is this workflow: its only
# network steps are actions/checkout reading YOUR repository and the single
# git push below — no package installs, no registries, no collector sockets.
#
# Run on a self-hosted runner where the agent transcripts actually live.
# On a hosted runner burn finds no data and says so — honestly, not loudly.

on:
  schedule:
    - cron: "17 21 * * *"
  workflow_dispatch:

permissions:
  contents: write

jobs:
  usage:
    runs-on: [self-hosted]
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 1

      - name: snapshot + export bundle
        run: |
          burn snapshot
          burn export --ulp -o team/usage/ci-runner.ulp.json
        continue-on-error: true

      - name: commit and push the bundle branch
        run: |
          git config user.name "burn-usage[bot]"
          git config user.email "burn-usage@localhost.invalid"
          git checkout -B "burn/usage-$(date -u +%Y%m%d-%H%M)"
          git add team/usage
          git commit -m "burn: usage snapshot $(date -u +%FT%TZ)" || echo "nothing new"
          git push origin HEAD
`;

function runInit(args) {
  if (!args.team) {
    console.error(paint(P.red, "usage: burn init --team   (v5 knows one scaffold: the serverless team sync)"));
    process.exit(2);
  }
  let inRepo = false;
  try {
    const st = fs.statSync(".git");
    inRepo = st.isDirectory() || st.isFile();
  } catch {
    /* not a repo */
  }
  if (!inRepo) {
    console.error(paint(P.red, "burn init --team: run inside a git repository — it writes ONLY into the current repo (team/usage/ + .github/workflows/)."));
    process.exit(2);
  }
  const writes = [
    ["team/usage/.gitkeep", ""],
    ["team/usage/README.md", TEAM_USAGE_README],
    [".github/workflows/burn-usage.yml", TEAM_WORKFLOW],
  ];
  header(paint(P.bold + P.cyan, "burn init --team") + paint(P.gray, "  idempotent scaffold; your edits to marked files are refreshed, unmarked files are kept"));
  for (const [rel, content] of writes) {
    let state;
    try {
      const cur = fs.readFileSync(rel, "utf8");
      if (rel.endsWith(".gitkeep") || !content) state = "present";
      else if (!cur.includes(BURN_GENERATED)) state = "kept — unmarked, presumably yours";
      else if (cur === content) state = "unchanged";
      else {
        fs.writeFileSync(rel, content);
        state = "refreshed";
      }
    } catch {
      fs.mkdirSync(path.dirname(rel), { recursive: true });
      fs.writeFileSync(rel, content);
      state = "created";
    }
    console.log(`${pad(rel, 36)} ${paint(P.gray, state)}`);
  }
  console.log(paint(P.green, "burn: scaffold ready —") + paint(P.gray, " git add team/usage .github && git commit, then run this workflow on a self-hosted runner."));
}

// ---------- plan (SPEC-3-5 §V4.B) ----------

function runPlan(args, ledger) {
  const priced = (ledger.events || []).filter((e) => e.costSource !== "unpriced" && e.cost != null);
  const names = [...new Set(priced.map((e) => e.repo || "(unknown)"))].sort();
  let repo = args.repo;
  if (!names.length) {
    console.error(paint(P.yellow, "burn plan: no priced history at all — nothing to project."));
    process.exit(1);
  }
  if (!names.includes(repo)) {
    const fuzzy = names.filter((n) => n.toLowerCase().includes(repo.toLowerCase()));
    if (fuzzy.length > 1) {
      console.error(paint(P.red, `burn plan: "${repo}" is ambiguous (${fuzzy.join(", ")})`));
      process.exit(2);
    }
    if (fuzzy.length === 1) repo = fuzzy[0];
    else {
      console.error(paint(P.red, `burn plan: no priced history for repository "${args.repo}".`));
      if (names.length) console.error(paint(P.gray, `  known repos: ${names.slice(0, 10).join(", ")}`));
      process.exit(2);
    }
  }
  const p = plan(priced, { repo, budgetUsd: args.budget, months: args.months, windowDays: args.window });
  if (!p.found) {
    console.error(paint(P.yellow, `burn plan: no priced history to project "${args.repo}" against.`));
    process.exit(1);
  }
  if (args.json) {
    console.log(JSON.stringify({ specVersion: SPEC_VERSION, plan: p }, null, 2));
    process.exit(p.affordable ? 0 : 3);
  }
  header(
    paint(P.bold + P.cyan, `Plan: ${repo} — $${args.budget.toFixed(2)} for ${args.months} month(s)`) +
      paint(P.gray, `  linear daily series, ${args.window}d sample ending ${p.end}`)
  );
  console.log(
    `  projected spend  ${paint(P.bold, fmtUSD(p.projectedCost))}  ` +
      paint(P.gray, `(${p.pricedEvents} priced events · slope ${p.slopePerDay >= 0 ? "+" : ""}${fmtUSD(p.slopePerDay)}/day${p.increasing ? "" : " — flat/declining"})`)
  );
  if (!p.affordable && p.exhaustionDate) {
    console.log(`  budget exhausted   ${paint(P.bold + P.red, p.exhaustionDate)} (linear projection, never a quote)`);
  }
  console.log(
    p.affordable
      ? paint(P.bold + P.green, `AFFORDABLE — exit 0`)
      : paint(P.bold + P.red, `NOT AFFORDABLE — exit 3 (same gate contract as burn budget)`)
  );
  process.exit(p.affordable ? 0 : 3);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args.command;
  if (cmd === "help") return console.log(HELP);
  if (cmd === "version") {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return console.log(`burn ${pkg.version}`);
  }

  if (cmd === "attribute") {
    const session = args.positional[1];
    if (!session || !args.unit) {
      console.error(paint(P.red, "usage: burn attribute <session> --unit <name>"));
      process.exit(2);
    }
    const p = saveAttribute(session, args.unit);
    console.log(paint(P.green, `burn: ${session} → "${args.unit}"`) + paint(P.gray, `  saved to ${p}`));
    return;
  }

  const blameRef = cmd === "blame" ? args.positional[1] : null;
  if (cmd === "blame" && !blameRef) {
    console.error(paint(P.red, "usage: burn blame <branch|A..B>   (e.g. burn blame feature/pay or burn blame v1..HEAD)"));
    process.exit(2);
  }
  const isRange = !!blameRef && blameRef.includes("..");

  if (args.confidence && !["native", "joined", "guess", "unattributed"].includes(args.confidence)) {
    console.error(paint(P.red, "burn: --confidence must be native|joined|guess|unattributed"));
    process.exit(2);
  }

  if (cmd === "budget") {
    if (!args.repo || args.max === null) {
      console.error(paint(P.red, "usage: burn budget --repo <label> --max <usd> [--period day|week|month|all]"));
      process.exit(2);
    }
    args.max = Number(args.max);
    if (!Number.isFinite(args.max) || args.max < 0) {
      console.error(paint(P.red, `burn budget: --max must be a non-negative number (got "${args.max}")`));
      process.exit(2);
    }
    args.since = periodSince(args.period);
  }

  if (cmd === "watch") return runWatch(args);

  if (cmd === "conformance") {
    // SPEC-3-5 §V3.C: the ULP kit, runnable without any agent data.
    const results = runKit();
    const failed = results.filter((r) => !r.pass);
    if (args.json) {
      console.log(JSON.stringify({ specVersion: SPEC_VERSION, ulpVersion: ULP_VERSION, results }, null, 2));
    } else {
      header(paint(P.bold + P.cyan, `ULP ${ULP_VERSION} conformance kit`) + paint(P.gray, `  ${results.length} vectors, pure JSON (ulp/conformance/)`));
      for (const r of results) {
        console.log(`${r.pass ? paint(P.green, "✓") : paint(P.red, "✗")} ${pad(r.id, 6)} ${r.name}`);
        for (const n of r.notes) console.log(paint(P.gray, `      ${n}`));
      }
      console.log(failed.length ? paint(P.red, `  ${failed.length} FAILING`) : paint(P.green, "  all vectors green"));
    }
    process.exit(failed.length ? 2 : 0);
  }

  if (cmd === "ingest") return runIngest(args);

  if (cmd === "init") return runInit(args);

  if (cmd === "history") {
    const sub = args.positional[1];
    if (sub === "ls") {
      const rows = listSnapshots();
      if (args.json) return console.log(JSON.stringify({ specVersion: SPEC_VERSION, historyDir: historyDir(), snapshots: rows }, null, 2));
      header(paint(P.bold + P.cyan, "Local snapshot history") + paint(P.gray, `  ${historyDir()}`));
      if (!rows.length) return console.log(paint(P.gray, "  no snapshots yet — run `burn snapshot`."));
      for (const r of rows) {
        console.log(
          `${pad(r.generatedAt || "(no date)", 26)} ${pad(`${r.events} evts`, 10)} ` +
            `${paint(P.bold, pad(fmtUSD(r.cost), 10))}  ` +
            (r.readable ? paint(P.gray, r.file) : paint(P.red, `${r.file} (unreadable)`))
        );
      }
      return;
    }
    if (sub === "drop") {
      const target = args.positional[2];
      if (!target) {
        console.error(paint(P.red, "usage: burn history drop <file> --yes"));
        process.exit(2);
      }
      try {
        const gone = dropSnapshot(target, { yes: args.yes });
        console.log(paint(P.green, `burn: dropped ${gone}`));
        return;
      } catch (e) {
        console.error(paint(P.red, `burn: ${e.message}`));
        process.exit(2);
      }
    }
    console.error(paint(P.red, "usage: burn history ls | burn history drop <file> --yes"));
    process.exit(2);
  }

  if (cmd === "snapshot" && args.compact) {
    console.error(paint(P.red, "burn snapshot: history without events is not history — drop --compact"));
    process.exit(2);
  }

  if (cmd === "merge" || cmd === "team") {
    const files = args.positional.slice(1);
    if (!files.length) {
      console.error(paint(P.red, `usage: burn ${cmd} <bundle.burn.json> [more …]`));
      process.exit(2);
    }
    return cmd === "merge" ? await runMerge(args, files) : runTeam(args, files);
  }

  if (cmd === "counterfactual" && !args.route) {
    console.error(paint(P.red, "usage: burn counterfactual --route <model>   (e.g. --route claude-sonnet-4)"));
    process.exit(2);
  }
  if (cmd === "forecast" || cmd === "plan") {
    args.window = Number(args.window) || 30;
    if (!Number.isInteger(args.window) || args.window < 2 || args.window > 365) {
      console.error(paint(P.red, `burn ${cmd}: --window must be an integer number of days (2–365)`));
      process.exit(2);
    }
  }

  if (cmd === "report" || cmd === "attest") {
    // --month YYYY-MM, default the current UTC month; the window is [first, next-first).
    const m = args.month || new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(m) || Number(m.slice(5)) < 1 || Number(m.slice(5)) > 12) {
      console.error(paint(P.red, `burn ${cmd}: --month must be YYYY-MM (got "${m}")`));
      process.exit(2);
    }
    const [yy, mm] = m.split("-").map(Number);
    args.month = m;
    args.since = `${m}-01`;
    args.until = mm === 12 ? `${yy + 1}-01-01` : `${yy}-${String(mm + 1).padStart(2, "0")}-01`;
  }

  if (cmd === "plan") {
    const bad = (msg) => { console.error(paint(P.red, `burn plan: ${msg}`)); process.exit(2); };
    if (!args.repo) bad("needs --repo <label>");
    if (args.budget === null) bad("needs --budget <usd>");
    if (args.months === null) bad("needs --months <n>");
    args.budget = Number(args.budget);
    if (!Number.isFinite(args.budget) || args.budget < 0) bad(`--budget must be a non-negative number (got "${args.budget}")`);
    args.months = Number(args.months);
    if (!Number.isInteger(args.months) || args.months < 1 || args.months > 24) bad("--months must be an integer 1–24");
  }

  const needsEvents = isRange || cmd === "forecast" || cmd === "counterfactual" || cmd === "doctor" || cmd === "export" || cmd === "snapshot" || cmd === "report" || cmd === "attest" || cmd === "plan";
  const useHistory = historyOn(cmd, args);
  const { ledger, active, pricing } = await gather(args, needsEvents ? { includeEvents: true } : {}, useHistory);

  if (cmd === "sources") {
    // A source report is valid even with zero data — it explains why.
    if (args.json) {
      console.log(JSON.stringify({ specVersion: SPEC_VERSION, sources: sourcesDoc(ledger) }, null, 2));
      return;
    }
    renderSources(ledger);
    return;
  }

  if (extractorMissing(ledger)) return empty();

  if (cmd === "export") return runExport(args, ledger, pricing);

  if (cmd === "snapshot") {
    const doc = ulpSnapshotDoc(ledger, pricing);
    const { file, events } = writeSnapshot(doc);
    console.log(
      paint(P.green, `burn: snapshot → ${file}`) +
        paint(P.gray, `  ${events} events · ${fmtUSD(doc.totals.cost)} · readable by any ULP tool`)
    );
    return;
  }

  if (cmd === "forecast" || cmd === "counterfactual" || cmd === "doctor") {
    return forwardMoney(cmd, args, ledger, pricing);
  }
  if (cmd === "report") return runReport(args, ledger, pricing);
  if (cmd === "attest") return runAttest(args, ledger, pricing);
  if (cmd === "plan") return runPlan(args, ledger);

  const visibleUnits = args.confidence
    ? ledger.units.filter((u) => u.unit.confidence === args.confidence)
    : ledger.units;

  if (args.json) {
    if (cmd === "work") {
      console.log(JSON.stringify({ specVersion: SPEC_VERSION, workUnits: visibleUnits }, null, 2));
      return;
    }
    if (cmd === "budget") return runBudget(args, ledger);
    if (cmd === "blame") {
      const payload = isRange
        ? { specVersion: SPEC_VERSION, ref: blameRef, confidence: "joined", rows: blameRange(ledger.events, ...blameRef.split("..")) }
        : { specVersion: SPEC_VERSION, ref: blameRef, confidence: "native", units: ledger.units.filter((u) => u.unit.kind === "branch" && u.unit.name.includes(blameRef)) };
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(
      JSON.stringify(
        {
          specVersion: SPEC_VERSION,
          generatedAt: new Date().toISOString(),
          supportedAgents: SOURCES.map((s) => s.label), // SPEC-2 §A: the truth, vs the plan
          pricingHash: pricingHashFor(ledger, pricing), // SPEC-3-5 §V5.C (null = table never applied)
          ...ledger,
        },
        null,
        2
      )
    );
    return;
  }

  if (cmd === "work") return renderWork(visibleUnits);
  if (cmd === "budget") return runBudget(args, ledger);
  if (cmd === "blame") {
    if (isRange) {
      const [a, b] = blameRef.split("..");
      return renderBlameRange(a, b, ledger.events);
    }
    return renderBlameBranch(blameRef, ledger.units);
  }

  const t = ledger.totals;
  console.log(paint(P.bold + P.green, "🔥 burn") + paint(P.gray, "  local AI usage ledger"));
  console.log(
    paint(
      P.gray,
      `  sources: ${active.map((s) => s.label).join(", ")} · ${t.events} usage events · ` +
        `${pricing.size()} priced models` +
        (args.since ? ` · since ${args.since}` : "")
    )
  );

  const promptTok = t.tokens.cacheRead + t.tokens.cacheWrite + t.tokens.input;
  header(
    `${paint(P.bold + P.green, fmtUSD(t.cost))} spent   ` +
      `${fmtTokens(t.tokens.input + t.tokens.output)} tokens   ` +
      `cache ${paint(P.green, (ledger.cacheHit * 100).toFixed(0) + "%")} of ${fmtTokens(promptTok)} prompt tokens reused`
  );
  console.log(provenance(ledger.sources));

  if (cmd === "summary" || cmd === "repos") section("By repository", ledger.repos, 15);
  if (cmd === "summary" || cmd === "models") section("By model", ledger.models, 12);
  if (cmd === "summary" || cmd === "agents") section("By agent", ledger.agents, 8);
  if (cmd === "daily") section("By day", ledger.days, 40);
  if (cmd === "summary") section("By day (recent)", ledger.days.slice(-14), 14);
  if (cmd === "sessions") {
    const list = ledger.sessions.slice(0, 15);
    if (list.length) {
      header(paint(P.bold + P.cyan, "Priciest sessions"));
      const max = Math.max(1e-9, ...list.map((s) => s.cost));
      for (const s of list) {
        console.log(
          `${pad(`${s.agent[0]} ${truncate(s.repo, 14)} ${truncate(s.sessionId.slice(0, 8), 8)}`, 24)} ` +
            `${bar(s.cost / max)} ${paint(P.bold, pad(fmtUSD(s.cost), 10))} ` +
            `${paint(P.gray, truncate(s.model, 24))}`
        );
      }
    }
  }

  console.log();
  console.log(
    paint(
      P.gray,
      "  billed = agent-recorded dollars · estimated = from your pricing table ·\n" +
        "  unpriced = tokens only. Teach burn more models: ~/.burn/pricing.json\n" +
        "  What did a feature cost?  burn work · burn blame <branch|A..B>"
    )
  );
}

// Entry point. node:sqlite's ExperimentalWarning is silenced by re-execing
// ourselves once with the flag; the child (BURN_QUIET=1) runs the real work.
if (!process.env.BURN_QUIET) {
  const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, BURN_QUIET: "1" } }
  );
  child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
  // A scripted `kill <parent>` must not orphan the child (watch loops forever).
  for (const sig of ["SIGINT", "SIGTERM"])
    process.on(sig, () => child.kill(sig));
} else {
  main().catch((e) => {
    console.error(paint(P.red, "burn error: ") + (e?.stack || e?.message || e));
    process.exit(2); // SPEC §7: 0 report · 1 no data · 2 unexpected error
  });
}
