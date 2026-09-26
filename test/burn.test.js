import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { loadPricing, estimateCost } from "../src/pricing.js";
import { collect } from "../src/aggregate.js";
import { fmtUSD, fmtTokens, repoFromDir } from "../src/util.js";
import * as claude from "../src/extractors/claude.js";
import * as opencode from "../src/extractors/opencode.js";
import * as codex from "../src/extractors/codex.js";
import * as gemini from "../src/extractors/gemini.js";
import { resolveUnit } from "../src/attribution.js";
import { revTime, blameRange } from "../src/git.js";
import { forecastSeries, forecast, counterfactual, doctor } from "../src/advise.js";
import { mergeBundles, auditBundles, teamView, bundleEvents } from "../src/bundle.js";

// ---------- SPEC-2 §B attribution ladder (unit level) ----------
test("H10: resolution ladder — explicit > branch > repo > unattributed", () => {
  const evBase = { agent: "a", sessionId: "s1", repo: "r", gitBranch: "feat/x", dir: "/x/r" };
  assert.deepEqual(resolveUnit(evBase, {}), { kind: "branch", name: "feat/x", confidence: "native" });
  assert.deepEqual(resolveUnit(evBase, { "a:s1": "billing sprint" }), {
    kind: "unit", name: "billing sprint", confidence: "native",
  });
  assert.deepEqual(resolveUnit({ ...evBase, gitBranch: null }, {}), {
    kind: "repo", name: "r", confidence: "guess",
  });
  assert.deepEqual(resolveUnit({ ...evBase, gitBranch: null, repo: "(unknown)" }, {}), {
    kind: "unattributed", name: "(unattributed)", confidence: "unattributed",
  });
});

test("H11: reconciliation — Σ workUnit costs == totals.cost (incl. unattributed residue)", async () => {
  const croot = fs.mkdtempSync(path.join(os.tmpdir(), "burn-recon-"));
  const proj = path.join(croot, "-p");
  fs.mkdirSync(proj);
  const a = (o) => JSON.stringify({ type: "assistant", ...o });
  fs.writeFileSync(
    path.join(proj, "s.jsonl"),
    [
      // branch event (priced)
      a({ timestamp: "2026-09-13T10:00:00.000Z", cwd: "/x/aa", gitBranch: "feat/pay",
          message: { model: "claude-sonnet-4", usage: { input_tokens: 1_000_000, output_tokens: 0 } } }),
      // repo-only event (priced differently)
      a({ timestamp: "2026-09-13T11:00:00.000Z", cwd: "/x/bb",
          message: { model: "claude-sonnet-4", usage: { input_tokens: 2_000_000, output_tokens: 0 } } }),
      // no cwd at all → unattributed
      a({ timestamp: "2026-09-13T12:00:00.000Z",
          message: { model: "claude-sonnet-4", usage: { input_tokens: 500_000, output_tokens: 0 } } }),
    ].join("\n")
  );
  process.env.BURN_CLAUDE_DIR = croot;
  process.env.BURN_OPENCODE_DB = "/nonexistent.db";
  const ledger = await collect([claude, opencode], await loadPricing({}), {});
  const unitSum = ledger.units.reduce((s, u) => s + u.cost, 0);
  assert.ok(Math.abs(unitSum - ledger.totals.cost) < 1e-9, `Σunits=${unitSum} == totals=${ledger.totals.cost}`);
  assert.equal(ledger.units.reduce((s, u) => s + u.events, 0), ledger.totals.events, "Σ unit events == total events");
  assert.ok(ledger.units.some((u) => u.unit.kind === "unattributed"), "residue is visible, never dropped");
  assert.ok(ledger.units.some((u) => u.unit.kind === "branch" && u.unit.name === "feat/pay"));
  delete process.env.BURN_CLAUDE_DIR;
  delete process.env.BURN_OPENCODE_DB;
});

test("H10: explicit attribute overrides branch at collect level", async () => {
  const croot = fs.mkdtempSync(path.join(os.tmpdir(), "burn-attr-"));
  const proj = path.join(croot, "-p");
  fs.mkdirSync(proj);
  fs.writeFileSync(
    path.join(proj, "S1.jsonl"),
    JSON.stringify({ type: "assistant", sessionId: "S1", timestamp: "2026-09-13T10:00:00.000Z", cwd: "/x/aa",
      gitBranch: "junk-branch", message: { model: "claude-sonnet-4", usage: { input_tokens: 1_000_000, output_tokens: 0 } } })
  );
  process.env.BURN_CLAUDE_DIR = croot;
  process.env.BURN_OPENCODE_DB = "/nonexistent.db";
  const ledger = await collect([claude, opencode], await loadPricing({}), {
    attributes: { "S1": "q3-launch" }, // bare-session key must work too
  });
  assert.ok(ledger.units.some((u) => u.unit.kind === "unit" && u.unit.name === "q3-launch"));
  assert.ok(!ledger.units.some((u) => u.unit.name === "junk-branch"));
  delete process.env.BURN_CLAUDE_DIR;
  delete process.env.BURN_OPENCODE_DB;
});

// ---------- H10/§B.2 git joiner against a REAL throwaway repo ----------
function gitSetup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "burn-gitrepo-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", HOME: dir };
  const run = (args, extraEnv) => {
    const r = spawnSync("git", ["-C", dir, ...args], { env: { ...env, ...(extraEnv || {}) }, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };
  run(["init", "-q", "--template="]);
  run(["config", "user.email", "t@t"]);
  run(["config", "user.name", "t"]);
  const commit = (name, isoDate) => {
    fs.writeFileSync(path.join(dir, name), name);
    run(["add", "."]);
    run(["commit", "-q", "-m", name], { GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate });
  };
  return { dir, run, commit };
}

test("H10: blameRange joins dated events to commit windows (confidence joined)", () => {
  const g = gitSetup();
  g.commit("a.txt", "2026-09-01T10:00:00Z");
  g.commit("b.txt", "2026-09-01T12:00:00Z");
  g.commit("c.txt", "2026-09-01T14:00:00Z");

  const tB = revTime(g.dir, "HEAD~1"); // b.txt commit
  const tC = revTime(g.dir, "HEAD");   // c.txt commit
  assert.ok(tB < tC, "revTime returns increasing epoch seconds");
  assert.equal(revTime(g.dir, "does-not-exist-ref"), null, "unknown ref → null (silent skip)");
  assert.equal(revTime("/not/a/repo", "HEAD"), null);

  const ev = (iso) => ({ dir: g.dir, repo: "burn-gitrepo", ts: Date.parse(iso), cost: 1,
    tokens: { input: 10, output: 1, cacheWrite: 0, cacheRead: 0, reasoning: 0 } });
  const events = [
    ev("2026-09-01T11:00:00Z"), // before window (b@12:00 excluded)
    ev("2026-09-01T12:00:00Z"), // exactly at b → open interval, excluded
    ev("2026-09-01T13:30:00Z"), // inside
    ev("2026-09-01T14:00:00Z"), // exactly at c → closed right edge, included
    ev("2026-09-01T20:00:00Z"), // after
  ];
  const rows = blameRange(events, "HEAD~1", "HEAD");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].events, 2, "window is (b@12:00, c@14:00] — exactly two events inside");
  assert.equal(rows[0].cost, 2);
  assert.equal(rows[0].confidence, "joined");
});

// ---------- pure unit tests ----------
test("estimateCost: known model uses list pricing + cache multipliers", async () => {
  const pricing = await loadPricing({});
  const usd = estimateCost(
    { model: "claude-opus-5", input: 1_000_000, output: 1_000_000, cacheWrite: 0, cacheRead: 0 },
    pricing
  );
  assert.equal(usd, 15 + 75); // 90 USD per 1M in + 1M out
});

test("estimateCost: unknown model returns null (never guesses)", async () => {
  const pricing = await loadPricing({});
  assert.equal(estimateCost({ model: "mystery-llm-v9", input: 10, output: 10 }, pricing), null);
});

test("estimateCost: user overrides teach new models", async () => {
  const pricing = await loadPricing({ "weird-model": { input: 2, output: 8, cacheWrite: 2, cacheRead: 0.5 } });
  assert.ok(pricing.has("weird-model"));
  assert.equal(estimateCost({ model: "weird-model", input: 500_000, output: 0 }, pricing), 1);
});

test("formatting helpers", () => {
  assert.equal(fmtUSD(40.078), "$40.08");
  assert.equal(fmtUSD(null), "—");
  assert.equal(fmtUSD(0.004), "<$0.01");
  assert.equal(fmtTokens(1500), "1.5k");
  assert.equal(fmtTokens(2_500_000), "2.50M");
});

// ---------- SPEC §10 conformance vectors ----------

test("V8: repo label derivation edge cases (basename only, no home leak)", () => {
  assert.equal(repoFromDir("/Users/x/repos/api-gateway"), "api-gateway");
  assert.equal(repoFromDir("/Users/x/repos/api-gateway/"), "api-gateway"); // trailing slash
  assert.equal(repoFromDir(os.homedir()), "~"); // username must NOT leak
  assert.equal(repoFromDir(os.homedir() + "/"), "~");
  assert.equal(repoFromDir(null), "(unknown)");
});

test("§4 pricing: longest-prefix wins; reverse prefix must not match; date suffixes OK", async () => {
  const pricing = await loadPricing({
    "foo": { input: 10, output: 10, cacheWrite: 10, cacheRead: 10 },
    "foo-mini": { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 },
  });
  // versioned id resolves to the exact family key via longest prefix
  assert.equal(estimateCost({ model: "foo-20260901", input: 1_000_000, output: 0 }, pricing), 10);
  // "foo-mini-2026" prefers "foo-mini" (longest) over "foo"
  assert.equal(estimateCost({ model: "foo-mini-2026", input: 1_000_000, output: 0 }, pricing), 1);
  // reverse prefix: bare "foo" has no exact key... it DOES here, so use another:
  assert.equal(pricing.lookup("gpt-5-micro"), null); // id extends beyond any key
  assert.equal(pricing.lookup(undefined), null);
});

test("§4: claude date-suffixed ids price at their family", async () => {
  const pricing = await loadPricing({});
  assert.equal(estimateCost({ model: "claude-opus-4-1-20260901", input: 1_000_000, output: 0 }, pricing), 15);
});

test("V9: malformed JSONL lines are skipped, not fatal", async () => {
  const croot = fs.mkdtempSync(path.join(os.tmpdir(), "burn-malformed-"));
  const proj = path.join(croot, "-p");
  fs.mkdirSync(proj);
  fs.writeFileSync(
    path.join(proj, "s.jsonl"),
    [
      "not json at all",
      "{truncated",
      JSON.stringify({ type: "user", message: { role: "user" } }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-09-13T10:00:00.000Z",
        cwd: "/x/repo",
        message: { model: "claude-sonnet-4", usage: { input_tokens: 1_000_000, output_tokens: 0 } },
      }),
    ].join("\n")
  );
  process.env.BURN_CLAUDE_DIR = croot;
  process.env.BURN_OPENCODE_DB = path.join(croot, "missing.db");
  const ledger = await collect([claude, opencode], await loadPricing({}), {});
  assert.equal(ledger.totals.events, 1);
  assert.equal(ledger.totals.estimate, 3, "sonnet input price applied to the one valid line");
  delete process.env.BURN_CLAUDE_DIR;
  delete process.env.BURN_OPENCODE_DB;
});

// ---------- shared fixture builder for spawned-CLI tests ----------
function makeFixtures() {
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "burn-spawn-claude-"));
  const proj = path.join(claudeDir, "-p-repo");
  fs.mkdirSync(proj);
  const a = (model, usage, cwd, ts) =>
    JSON.stringify({
      type: "assistant",
      timestamp: ts,
      cwd,
      message: { model, usage },
    });
  fs.writeFileSync(
    path.join(proj, "s1.jsonl"),
    [
      a("claude-opus-5", { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 1_000_000 }, "/x/cheap-repo", "2026-08-01T00:00:00.000Z"),
      a("claude-sonnet-4", { input_tokens: 2_000_000, output_tokens: 0, cache_read_input_tokens: 0 }, "/x/pricy-repo", "2026-09-02T00:00:00.000Z"),
      a("claude-sonnet-4", { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0 }, "/x/undated-repo", undefined),
    ].join("\n")
  );
  const dbFile = path.join(fs.mkdtempSync(os.tmpdir() + "/burn-spawn-oc-"), "opencode.db");
  const db = new DatabaseSync(dbFile);
  db.exec(
    `create table session (id text primary key, directory text, model text, cost real,
      tokens_input int, tokens_output int, tokens_reasoning int, tokens_cache_read int,
      tokens_cache_write int, time_created int);`
  );
  db.prepare(`insert into session values (?,?,?,?,?,?,?,?,?,?)`).run(
    "o1", "/x/billed-repo", JSON.stringify({ id: "some-free-model" }), 2.5,
    100, 10, 0, 0, 0, Date.parse("2026-09-03T00:00:00Z")
  );
  db.close();
  return { claudeDir, dbFile };
}

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
// A real-but-empty dir keeps codex/gemini deterministic (found:true, 0 events)
// in CLI spawn tests regardless of the runner machine's own agent homes.
const NEUTRAL_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "burn-neutral-"));
// Non-existent ingest/history roots: the merge readers return empty, so CLI
// spawn tests never pick up the developer's real ~/.burn ledger. Tests that
// exercise snapshots/ingest pass their own dirs via extraEnv, which wins here.
const NEUTRAL_EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), "burn-empty-"));
const NEUTRAL_INGEST_DIR = path.join(NEUTRAL_EMPTY, "ingest");
const NEUTRAL_HISTORY_DIR = path.join(NEUTRAL_EMPTY, "history");

function spawnCli(args, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    env: {
      ...process.env,
      BURN_CODEX_DIR: NEUTRAL_AGENT_DIR,
      BURN_GEMINI_DIR: NEUTRAL_AGENT_DIR,
      BURN_INGEST_DIR: NEUTRAL_INGEST_DIR,
      BURN_HISTORY_DIR: NEUTRAL_HISTORY_DIR,
      ...extraEnv,
    },
  });
}

test("§6: --json document conforms (specVersion, numeric costs, desc sort, key fields)", () => {
  const { claudeDir, dbFile } = makeFixtures();
  const r = spawnCli(["--json"], { BURN_CLAUDE_DIR: claudeDir, BURN_OPENCODE_DB: dbFile });
  assert.equal(r.status, 0, r.stderr.toString());
  const j = JSON.parse(r.stdout.toString());
  assert.equal(j.specVersion, "2.0");
  // SPEC-2 §F: v2 is additive-only over v1 — every v1 key must still be there.
  for (const k of ["totals", "cacheHit", "totalTokens", "sources", "repos", "models", "agents", "days", "sessions"])
    assert.ok(k in j, `v1 key ${k} must survive in 2.0`);
  assert.ok(Array.isArray(j.workUnits ?? j.units), "v2 units present");
  assert.deepEqual(j.supportedAgents, ["claude-code", "opencode", "codex", "gemini-cli"], "H15: only verified formats are claimed");
  assert.equal(j.totals.key, "total");
  for (const b of [...j.repos, ...j.models, ...j.agents, ...j.days]) {
    assert.equal(typeof b.cost, "number", "cost is never null");
    assert.ok(Number.isInteger(b.events));
  }
  const costs = j.repos.map((x) => x.cost);
  assert.deepEqual(costs, [...costs].sort((a, b) => b - a), "repos sorted cost DESC");
  // pricy-repo (2M sonnet in = $6) > billed-repo $2.5 > cheap-repo (1M opus in + 1M read = $16.5? -> recompute)
  const cheap = j.repos.find((x) => x.key === "cheap-repo");
  const pricy = j.repos.find((x) => x.key === "pricy-repo");
  assert.equal(cheap.cost, 15 + 1.5, "opus 1M in + 1M cacheRead at 1.5/M");
  assert.equal(pricy.cost, 6, "sonnet 2M in");
  assert.ok(j.repos.some((x) => x.key === "billed-repo" && x.cost === 2.5));
});

test("§7: --since excludes unknown-dated events", () => {
  const { claudeDir, dbFile } = makeFixtures();
  const r = spawnCli(["--json", "--since", "2026-08-15"], {
    BURN_CLAUDE_DIR: claudeDir,
    BURN_OPENCODE_DB: dbFile,
  });
  assert.equal(r.status, 0, r.stderr.toString());
  const j = JSON.parse(r.stdout.toString());
  assert.ok(!j.repos.some((x) => x.key === "undated-repo"), "undated event dropped under --since");
  assert.ok(!j.repos.some((x) => x.key === "cheap-repo"), "pre-cutoff August event dropped");
  assert.ok(j.repos.some((x) => x.key === "pricy-repo"), "post-cutoff kept");
});

test("§8: NO_COLOR ⇒ zero ANSI bytes in stdout", () => {
  const { claudeDir, dbFile } = makeFixtures();
  const r = spawnCli([], { BURN_CLAUDE_DIR: claudeDir, BURN_OPENCODE_DB: dbFile, NO_COLOR: "1" });
  assert.equal(r.status, 0, r.stderr.toString());
  assert.ok(!/\x1b\[/.test(r.stdout.toString()), "no escape sequences when NO_COLOR is set");
  assert.match(r.stdout.toString(), /By repository/);
});

test("V6: cacheHit is exactly 0 on a zero-prompt bucket", async () => {
  const croot = fs.mkdtempSync(path.join(os.tmpdir(), "burn-zeroprompt-"));
  const proj = path.join(croot, "-z");
  fs.mkdirSync(proj);
  // output-only turn: input/cacheWrite/cacheRead all zero
  fs.writeFileSync(
    path.join(proj, "z.jsonl"),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-09-13T10:00:00.000Z",
      cwd: "/x/zrepo",
      message: { model: "claude-sonnet-4", usage: { input_tokens: 0, output_tokens: 50 } },
    })
  );
  process.env.BURN_CLAUDE_DIR = croot;
  process.env.BURN_OPENCODE_DB = path.join(croot, "none.db");
  const ledger = await collect([claude, opencode], await loadPricing({}), {});
  const z = ledger.repos.find((b) => b.key === "zrepo");
  assert.equal(z.cacheHit, 0);
  assert.equal(ledger.cacheHit, 0);
  delete process.env.BURN_CLAUDE_DIR;
  delete process.env.BURN_OPENCODE_DB;
});

test("§7 exit codes: 0 on report, 1 on empty machine (stdout silent), via real CLI", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "burn-home-"));
  const env = { ...process.env, HOME: emptyHome };
  delete env.BURN_CLAUDE_DIR;
  delete env.BURN_OPENCODE_DB;
  const r = spawnSync(process.execPath, [cli, "--json"], { env });
  assert.equal(r.status, 1, "empty machine exits 1");
  assert.equal(r.stdout.toString(), "", "nothing on stdout");
  assert.match(r.stderr.toString(), /no supported agent data/i);
});

// ---------- SPEC-2 §A.2 sources · §C.3 budget · §G confidence filter ----------
function fixtureEnv() {
  const { claudeDir, dbFile } = makeFixtures();
  // Point codex/gemini at existing (but session-less) dirs so `sources` is
  // deterministic on any machine, regardless of the tester's real ~/.codex.
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "burn-codex-"));
  const geminiDir = fs.mkdtempSync(path.join(os.tmpdir(), "burn-gemini-"));
  return { BURN_CLAUDE_DIR: claudeDir, BURN_OPENCODE_DB: dbFile, BURN_CODEX_DIR: codexDir, BURN_GEMINI_DIR: geminiDir };
}

test("§A.2 sources --json: reports resolved paths, found flag, event counts, date span", () => {
  const env = fixtureEnv();
  const r = spawnCli(["sources", "--json"], env);
  assert.equal(r.status, 0, r.stderr.toString());
  const j = JSON.parse(r.stdout.toString());
  assert.equal(j.specVersion, "2.0");
  assert.equal(j.sources.length, 4, "claude + opencode + codex + gemini-cli");
  const c = j.sources.find((s) => s.agent === "claude-code");
  const o = j.sources.find((s) => s.agent === "opencode");
  const cx = j.sources.find((s) => s.agent === "codex");
  const gm = j.sources.find((s) => s.agent === "gemini-cli");
  assert.equal(cx.found, true);
  assert.equal(cx.events, 0, "registered but empty source is honestly zero, never guessed data");
  assert.equal(gm.events, 0);
  assert.equal(c.path, env.BURN_CLAUDE_DIR);
  assert.equal(c.found, true);
  assert.equal(c.events, 3);
  assert.equal(c.firstDate, "2026-08-01");
  assert.equal(c.lastDate, "2026-09-02"); // undated event doesn't extend the span
  assert.equal(c.costClasses, "estimated");
  assert.equal(o.events, 1);
  assert.equal(o.costClasses, "billed");
});

test("§A.2 sources: an absent source still reports its checked path (found:false, 0 events)", () => {
  const env = fixtureEnv();
  env.BURN_OPENCODE_DB = path.join(env.BURN_CLAUDE_DIR, "does-not-exist.db");
  const r = spawnCli(["sources", "--json"], env);
  assert.equal(r.status, 0, r.stderr.toString());
  const o = JSON.parse(r.stdout.toString()).sources.find((s) => s.agent === "opencode");
  assert.equal(o.found, false);
  assert.equal(o.events, 0);
  assert.equal(o.costClasses, "—");
});

test("H13 §C.3 budget: exit 0 under, exit 3 over, --json matches", () => {
  const env = fixtureEnv();
  const under = spawnCli(["budget", "--repo", "cheap-repo", "--max", "20", "--period", "all"], env);
  assert.equal(under.status, 0, under.stdout.toString() + under.stderr.toString());

  const over = spawnCli(["budget", "--repo", "cheap-repo", "--max", "10", "--period", "all", "--json"], env);
  assert.equal(over.status, 3, "cheap-repo costs $16.50 > $10 max ⇒ exit 3");
  const j = JSON.parse(over.stdout.toString());
  assert.equal(j.repo, "cheap-repo");
  assert.equal(j.over, true);
  assert.equal(j.cost, 16.5);
  assert.equal(j.max, 10);
});

test("§C.3 budget: unknown repo exits 2 with candidates; missing flags exit 2", () => {
  const env = fixtureEnv();
  const miss = spawnCli(["budget", "--repo", "nope-does-not-exist", "--max", "5"], env);
  assert.equal(miss.status, 2);
  assert.match(miss.stderr.toString(), /no repository matches/i);
  const noflags = spawnCli(["budget", "--repo", "cheap-repo"], env);
  assert.equal(noflags.status, 2);
  assert.match(noflags.stderr.toString(), /usage: burn budget/i);
});

test("§C.3 budget: unique substring resolves with a note; bad --period exits 2", () => {
  const env = fixtureEnv();
  const fuzzy = spawnCli(["budget", "--repo", "billed", "--max", "1", "--period", "all", "--json"], env);
  assert.equal(fuzzy.status, 3, "billed-repo $2.50 > $1 ⇒ over, matched fuzzily");
  assert.equal(JSON.parse(fuzzy.stdout.toString()).repo, "billed-repo");
  const badPeriod = spawnCli(["budget", "--repo", "cheap-repo", "--max", "5", "--period", "fortnight"], env);
  assert.equal(badPeriod.status, 2);
  assert.match(badPeriod.stderr.toString(), /--period must be/i);
});

test("§G work --confidence: filters work units to the requested ladder rung", () => {
  const env = fixtureEnv();
  const r = spawnCli(["work", "--confidence", "guess", "--json"], env);
  assert.equal(r.status, 0, r.stderr.toString());
  const { workUnits } = JSON.parse(r.stdout.toString());
  assert.ok(workUnits.length > 0, "fixture repos attribute via the repo-guess rung");
  assert.ok(workUnits.every((u) => u.unit.confidence === "guess"));
});

test("§G bad --confidence value exits 2", () => {
  const env = fixtureEnv();
  const r = spawnCli(["work", "--confidence", "bogus", "--json"], env);
  assert.equal(r.status, 2);
  assert.match(r.stderr.toString(), /--confidence must be/i);
});

// ---------- SPEC-2 §C/§D forward money (pure; snapshot-tested) ----------
const ev = ({ repo = "r", model = "claude-sonnet-4", costSource = "estimate", cost = 0, date = "2026-09-10", input = 0, output = 0, cacheRead = 0, cacheWrite = 0 }) => ({
  repo, model, costSource, cost, date, tokens: { input, output, cacheRead, cacheWrite, reasoning: 0 },
});

test("forecastSeries: constant and ramp series give exact linear/mean projections", () => {
  const flat = forecastSeries(Array(10).fill(2));
  assert.equal(flat.windowCost, 20);
  assert.equal(flat.slope, 0);
  assert.equal(flat.linearNext7, 14); // predict(10..16)=2 each
  assert.equal(flat.linearNext30, 60);
  assert.equal(flat.last7MeanNext7, 14);

  const ramp = forecastSeries([1, 2, 3, 4, 5]);
  assert.equal(ramp.slope, 1);
  assert.equal(ramp.linearNext7, 63); // predict(5..11)=6..12
  assert.equal(ramp.last7MeanNext7, 21); // mean(1..5)=3 ×7
});

test("forecast: priced-only projection, unpriced tokens kept separate, window counted", async () => {
  const events = [
    ev({ date: "2026-09-10", cost: 5 }),
    ev({ date: "2026-09-10", cost: 5 }),
    ev({ date: "2026-09-11", cost: 5, repo: "other" }),
    ev({ date: "2026-09-12", costSource: "unpriced", input: 1000, output: 500 }), // tokens only
  ];
  const f = forecast(events, { windowDays: 30 });
  assert.equal(f.label, "est-forecast");
  assert.equal(f.daysWithData, 2, "09-10 and 09-11 priced; 09-12 is unpriced-only");
  assert.equal(f.total.windowCost, 15, "unpriced event contributes $0 to the projection");
  assert.equal(f.unpricedTokens, 1500, "reported separately, never $-ized");
  assert.equal(f.end, "2026-09-12");
});

test("counterfactual: replay at a priced route; honest '—' for an unpriceable target", async () => {
  const { loadPricing } = await import("../src/pricing.js");
  const pricing = await loadPricing({});
  const events = [
    ev({ model: "claude-opus-5", costSource: "estimate", cost: 30, input: 1_000_000, output: 0 }),
    ev({ model: "claude-opus-5", costSource: "store", cost: 1, input: 0, output: 0 }),
  ];
  const sonnet = counterfactual(events, pricing, "claude-sonnet-4");
  assert.equal(sonnet.label, "estimate-of-estimate");
  assert.equal(sonnet.asItHappened, 31);
  assert.equal(sonnet.billed, 1);
  assert.equal(sonnet.estimated, 30);
  // 1M sonnet input @ $3/M = $3
  assert.equal(sonnet.replay, 3);
  assert.equal(sonnet.delta, 28);

  const ghost = counterfactual(events, pricing, "gpt-9-nonexistent");
  assert.equal(ghost.unpriceable, true, "never claims savings on a model with no price");
  assert.equal(ghost.replay, null);
});

test("doctor R-1 cache-starved: fires only with big prompts + <10% cache over ≥20 turns", async () => {
  const { loadPricing } = await import("../src/pricing.js");
  const pricing = await loadPricing({});
  const starved = [];
  for (let i = 0; i < 20; i++) starved.push(ev({ repo: "cold", input: 60_000, output: 100, cacheRead: 100, cost: 0.2 }));
  const r1 = doctor(starved, pricing).find((f) => f.rule.startsWith("R-1"));
  assert.ok(r1, "avg prompt 60k, cacheHit <10%, 20 turns ⇒ fire");
  assert.equal(r1.estImpactClass, "estimated");

  const warm = starved.map((e) => ({ ...e, repo: "warm", tokens: { ...e.tokens, cacheRead: 300_000 } }));
  assert.ok(!doctor(warm, pricing).find((f) => f.rule.startsWith("R-1")), "high cache hit ⇒ no fire");

  const few = starved.slice(0, 19);
  assert.ok(!doctor(few, pricing).find((f) => f.rule.startsWith("R-1")), "19 turns < 20 ⇒ no fire");
});

test("doctor R-2 model overspend: opus dollars on short outputs", async () => {
  const { loadPricing } = await import("../src/pricing.js");
  const pricing = await loadPricing({});
  const overspend = Array(10).fill(0).map(() => ev({ repo: "over", model: "claude-opus-5", input: 1000, output: 50, cost: 0.05 }));
  const r2 = doctor(overspend, pricing).find((f) => f.rule.startsWith("R-2"));
  assert.ok(r2, "100% opus, median output 50 < 400 ⇒ fire");
  assert.ok(r2.estImpactUsd > 0, "carries a real counterfactual delta number");

  const longOut = overspend.map((e) => ({ ...e, repo: "long", tokens: { ...e.tokens, output: 5000 } }));
  assert.ok(!doctor(longOut, pricing).find((f) => f.rule.startsWith("R-2")), "median output 5000 ≥ 400 ⇒ no fire");
});

test("doctor R-4 unpriced drift: fires when >25% of tokens have no price", async () => {
  const { loadPricing } = await import("../src/pricing.js");
  const pricing = await loadPricing({});
  const mixed = [
    ev({ repo: "a", costSource: "unpriced", model: "mystery-1", input: 4000, output: 1000 }),
    ev({ repo: "a", model: "claude-sonnet-4", input: 6000, cost: 0.02 }),
  ];
  const r4 = doctor(mixed, pricing).find((f) => f.rule.startsWith("R-4"));
  assert.ok(r4, "unpriced share 5000/11000 ≈ 45% > 25% ⇒ fire");
  assert.equal(r4.estImpactClass, "none");

  const mostlyPriced = [
    ev({ repo: "b", costSource: "unpriced", model: "mystery-1", input: 100, output: 0 }),
    ev({ repo: "b", model: "claude-sonnet-4", input: 9000, cost: 0.03 }),
  ];
  assert.ok(!doctor(mostlyPriced, pricing).find((f) => f.rule.startsWith("R-4")), "unpriced <25% ⇒ no fire");
});

test("§C/§D CLI: forecast/counterfactual/doctor --json payloads, doctor stays advisory", () => {
  const env = fixtureEnv();
  const f = spawnCli(["forecast", "--window", "30", "--json"], env);
  assert.equal(f.status, 0, f.stderr.toString());
  const fj = JSON.parse(f.stdout.toString()).forecast;
  assert.equal(fj.label, "est-forecast");
  assert.equal(fj.windowDays, 30);
  assert.equal(fj.unpricedTokens, 0, "fixtures are fully priced");
  assert.ok(fj.byRepo.length >= 3);

  const cf = spawnCli(["counterfactual", "--route", "claude-haiku-4-5", "--json"], env);
  assert.equal(cf.status, 0, cf.stderr.toString());
  const cfj = JSON.parse(cf.stdout.toString()).counterfactual;
  assert.equal(cfj.asItHappened, 28, "16.5 + 6 + 3 estimated + 2.5 billed");
  assert.equal(cfj.unpriceable, false);

  const ghost = spawnCli(["counterfactual", "--route", "no-such-model-x", "--json"], env);
  assert.equal(JSON.parse(ghost.stdout.toString()).counterfactual.unpriceable, true, "honest —, never a guessed saving");

  const doc = spawnCli(["doctor", "--json"], env);
  assert.equal(doc.status, 0, "doctor is advice, not a gate — always 0");
  const { findings } = JSON.parse(doc.stdout.toString());
  assert.ok(Array.isArray(findings));
  for (const fi of findings)
    for (const k of ["rule", "severity", "scope", "observation", "suggested", "estImpactClass", "estImpactUsd"])
      assert.ok(k in fi, `finding carries §D field ${k}`);

  const noRoute = spawnCli(["counterfactual"], env);
  assert.equal(noRoute.status, 2);
  assert.match(noRoute.stderr.toString(), /usage: burn counterfactual/i);
});

// ---------- H15: source-verified Codex + Gemini formats ----------
test("H15 codex: rollout JSONL → normalized turns, native branch attribution, no double-count", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "burn-codex-"));
  const day = path.join(root, "2026", "09", "20");
  fs.mkdirSync(day, { recursive: true });
  const L = [
    { timestamp: "2026-09-20T10:00:00.000Z", ordinal: 0, type: "session_meta", payload: { session_id: "sess-42", id: "thread-42", cwd: "/x/codex-repo", cli_version: "0.45.0", git: { branch: "feature/rollout", commit_hash: "abc123" } } },
    { timestamp: "2026-09-20T10:00:05.000Z", ordinal: 1, type: "turn_context", payload: { model: "gpt-5-codex", cwd: "/x/codex-repo" } },
    { timestamp: "2026-09-20T10:00:10.000Z", ordinal: 2, type: "response_item", payload: { type: "reasoning" } },
    { timestamp: "2026-09-20T10:00:15.000Z", ordinal: 3, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 5000, cached_input_tokens: 3000, cache_write_input_tokens: 0, output_tokens: 400, reasoning_output_tokens: 100, total_tokens: 5400 }, model_context_window: 272000 }, rate_limits: {} } },
    "a line that is definitely not json {{{",
    { timestamp: "2026-09-20T10:00:20.000Z", ordinal: 4, type: "event_msg", payload: { type: "token_count", info: null } },
    { timestamp: "2026-09-20T10:00:25.000Z", ordinal: 5, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1200, cached_input_tokens: 900, output_tokens: 60 } } } },
  ].map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n");
  fs.writeFileSync(path.join(day, "rollout-2026-09-20T10-00-00-thread-42.jsonl"), L);
  process.env.BURN_CODEX_DIR = day;
  process.env.BURN_GEMINI_DIR = "/nonexistent-gemini";
  try {
    const evs = [...codex.extract()];
    assert.equal(evs.length, 2, "only real token_count turns; null-info and junk lines skipped");
    const e = evs[0];
    assert.equal(e.agent, "codex");
    assert.equal(e.sessionId, "sess-42");
    assert.equal(e.model, "gpt-5-codex", "model carried from turn_context");
    assert.equal(e.repo, "codex-repo");
    assert.equal(e.gitBranch, "feature/rollout", "git branch from session_meta → native attribution");
    assert.equal(e.date, "2026-09-20");
    assert.equal(e.storedCost, null, "Codex never stores dollars");
    assert.deepEqual(e.tokens, { input: 2000, output: 400, cacheWrite: 0, cacheRead: 3000, reasoning: 100 }, "cached slice subtracted from full prompt count");
    // collect-level: gpt-5-codex is a *variant*, not a version suffix ⇒ unpriced (SPEC §4)
    const pricing = await loadPricing({});
    const ledger = await collect([codex], pricing, {});
    assert.equal(ledger.totals.events, 2);
    assert.equal(ledger.sources.unpriced, 2, "burn refuses to price gpt-5-codex off gpt-5");
    assert.equal(ledger.totals.cost, 0);
    assert.equal(ledger.units.find((u) => u.unit.name === "feature/rollout").unit.confidence, "native");
  } finally {
    delete process.env.BURN_CODEX_DIR;
    delete process.env.BURN_GEMINI_DIR;
  }
});

test("H15 gemini-cli: chat JSONL → metadata seeds session/repo, tokens unmapped without double-count", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "burn-gemini-"));
  const chats = path.join(root, "my-project-slug", "chats");
  fs.mkdirSync(chats, { recursive: true });
  const L = [
    { sessionId: "g-abc12345", projectHash: "h", startTime: "2026-09-21T08:00:00.000Z", lastUpdated: "2026-09-21T08:05:00.000Z", kind: "main", directories: ["/x/gemini-repo"] },
    { id: "m1", timestamp: "2026-09-21T08:00:05.000Z", type: "user", content: { text: "hi" } },
    { id: "m2", timestamp: "2026-09-21T08:00:09.000Z", type: "gemini", model: "gemini-2.5-pro", tokens: { input: 2000, output: 300, cached: 1500, thoughts: 50, tool: 10, total: 2360 } },
    { id: "m3", timestamp: "2026-09-21T08:00:12.000Z", type: "gemini", model: "gemini-2.5-pro", tokens: { input: 800, output: 100, cached: 0, thoughts: 0 } },
  ].map((l) => JSON.stringify(l)).join("\n");
  fs.writeFileSync(path.join(chats, "session-2026-09-21T08-00-abc12345.jsonl"), L);
  process.env.BURN_GEMINI_DIR = root;
  try {
    const evs = [...gemini.extract()];
    assert.equal(evs.length, 2, "assistant turns with tokens only");
    const e = evs[0];
    assert.equal(e.agent, "gemini-cli");
    assert.equal(e.sessionId, "g-abc12345", "sessionId from ConversationRecord metadata");
    assert.equal(e.repo, "gemini-repo", "repo from metadata directories, not the slug");
    assert.equal(e.gitBranch, null, "Gemini stores no branch ⇒ never invent one");
    assert.deepEqual(e.tokens, { input: 510, output: 300, cacheWrite: 0, cacheRead: 1500, reasoning: 50 }, "fresh input = input − cached, plus tool tokens");

    const pricing = await loadPricing({});
    const ledger = await collect([gemini], pricing, {});
    // gemini-2.5-pro IS priced: 510/1M*1.25 + 300/1M*10 + 1500/1M*0.3125 (+ second turn)
    assert.equal(ledger.sources.estimate, 2, "priced via the user's pricing table");
    const expected =
      ((510 * 1.25 + 300 * 10 + 1500 * 0.3125) / 1e6) + ((800 * 1.25 + 100 * 10) / 1e6);
    assert.ok(Math.abs(ledger.totals.cost - expected) < 1e-12);
    assert.equal(ledger.units.length, 1, "no branch ⇒ repo-guess rung");
    assert.equal(ledger.units[0].unit.confidence, "guess");
  } finally {
    delete process.env.BURN_GEMINI_DIR;
  }
});

// ---------- integration: temp Claude + OpenCode stores ----------
function tmp(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "burn-test-"));
  return { dir, name: path.join(dir, name) };
}

test("collect: cross-agent ledger, cost provenance, cache rate", async () => {
  // Claude fixture: one priced model + one synthetic (must be skipped).
  const croot = fs.mkdtempSync(path.join(os.tmpdir(), "burn-claude-"));
  const proj = path.join(croot, "-Users-test-repo");
  fs.mkdirSync(proj);
  const ev = (model, usage, cwd) =>
    JSON.stringify({ type: "assistant", timestamp: "2026-09-13T10:00:00.000Z", cwd, model: null, message: { model, usage } });
  const lines = [
    ev("claude-sonnet-4", { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, "/Users/test/repo-a"),
    ev("brand-new-unpriced-model", { input_tokens: 1000, output_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, "/Users/test/repo-a"),
    ev("<synthetic>", { input_tokens: 999999, output_tokens: 999999 }, "/Users/test/repo-a"),
  ];
  fs.writeFileSync(path.join(proj, "sess1.jsonl"), lines.join("\n"));

  // OpenCode fixture: a billed ($2.00) session and a genuinely-free ($0) one.
  // OpenCode always records a numeric cost, so both are "billed" (store), never unpriced.
  const { name: dbFile } = tmp("opencode.db");
  const db = new DatabaseSync(dbFile);
  db.exec(
    `create table session (id text primary key, directory text, model text, cost real,
      tokens_input int, tokens_output int, tokens_reasoning int, tokens_cache_read int,
      tokens_cache_write int, time_created int);`
  );
  const ins = db.prepare(
    `insert into session values (?,?,?,?,?,?,?,?,?,?)`
  );
  ins.run(
    "s2", "/Users/test/repo-b", JSON.stringify({ id: "gpt-5" }), 2.0,
    500, 200, 0, 1000, 0, Date.parse("2026-09-20T00:00:00Z")
  );
  ins.run(
    "s3", "/Users/test/repo-b", JSON.stringify({ id: "free-model-xyz" }), 0,
    3000, 100, 0, 0, 0, Date.parse("2026-09-21T00:00:00Z")
  );
  db.close();

  process.env.BURN_CLAUDE_DIR = croot;
  process.env.BURN_OPENCODE_DB = dbFile;

  const pricing = await loadPricing({});
  const ledger = await collect([claude, opencode], pricing, {});

  // 4 events counted (synthetic Claude turn excluded).
  assert.equal(ledger.totals.events, 4, "synthetic Claude turn is excluded");
  // Two OpenCode sessions are billed (one $2, one genuinely free $0).
  assert.equal(ledger.totals.store, 2, "two billed opencode sessions");
  assert.ok(ledger.totals.estimate > 0, "priced Claude turn estimated");
  // Only Claude with an unknown model can be unpriced (OpenCode always records cost).
  assert.equal(ledger.sources.unpriced, 1, "unknown Claude model: tokens only, no dollars");
  assert.equal(ledger.sources.store, 2);
  assert.equal(ledger.sources.estimate, 1);
  assert.equal(ledger.repos.length, 2, "repo-a and repo-b");
  assert.ok(ledger.cacheHit > 0, "cache hit computed from cache_read");

  delete process.env.BURN_CLAUDE_DIR;
  delete process.env.BURN_OPENCODE_DB;
});

// ---------- SPEC-2 §E bundles · merge · team · export ----------
function bundleEvent({ repo = "r", agent = "claude-code", sessionId = "s1", model = "claude-sonnet-4", costSource = "estimate", cost = 5, date = "2026-09-10", input = 1000, output = 0 }) {
  return { agent, sessionId, model, repo, date, costSource, cost, tokens: { input, output, cacheWrite: 0, cacheRead: 0, reasoning: 0 }, unit: { kind: "repo", name: repo, confidence: "guess" } };
}

test("H12 §E.2 merge: union by identity, recompute-not-sum, idempotent", () => {
  const dev = "device-aaa";
  const mk = (events) => ({ deviceId: dev, events });
  const single = mergeBundles([mk([bundleEvent({ cost: 5 }), bundleEvent({ cost: 3 })])]);
  const dup = mergeBundles([mk([bundleEvent({ cost: 5 }), bundleEvent({ cost: 3 })]), mk([bundleEvent({ cost: 5 }), bundleEvent({ cost: 3 })])]);
  assert.equal(dup.totals.events, single.totals.events, "identical (deviceId,agent,session,index) unions are idempotent");
  assert.equal(dup.totals.cost, single.totals.cost, "merge NEVER double-counts an identical bundle");

  // recompute-not-sum: two machines each with repo "r" must form ONE repo row,
  // not be added as pre-aggregated rows. Give them distinct deviceIds.
  const two = mergeBundles([
    mk([bundleEvent({ cost: 5, input: 1000 })]),
    { deviceId: "device-bbb", events: [bundleEvent({ cost: 7, input: 2000 })] },
  ]);
  const rrow = two.repos.find((x) => x.key === "r");
  assert.equal(rrow.cost, 12, "repos recomputed from merged events (5+7), not summed buckets");
  assert.equal(rrow.tokens.input, 3000);
  assert.equal(two.totals.events, 2);
});

test("§E.2 merge --audit flags duplicate deviceIds from copied ~/.burn/id", () => {
  const docs = [
    { deviceId: "same", events: [bundleEvent({})], __file: "a.json" },
    { deviceId: "same", events: [bundleEvent({})], __file: "b.json" },
  ];
  const audit = auditBundles(docs);
  assert.equal(audit.ok, false);
  assert.equal(audit.duplicates.length, 1);
  assert.deepEqual(audit.duplicates[0].files, ["a.json", "b.json"]);
});

test("§E.3 team: groups merged events per deviceId (human), honours local roster", () => {
  const merged = mergeBundles([
    { deviceId: "dev-1", events: [bundleEvent({ cost: 5 }), bundleEvent({ cost: 2 })] },
    { deviceId: "dev-2", events: [bundleEvent({ cost: 9 })] },
  ], { attributes: {} });
  const roster = { "dev-2": "Priya" };
  const view = teamView(merged, roster);
  assert.equal(view.humans.length, 2);
  const priya = view.humans.find((h) => h.deviceId === "dev-2");
  assert.equal(priya.label, "Priya", "roster deviceId → display label (kept local)");
  assert.equal(priya.cost, 9);
  const anon = view.humans.find((h) => h.deviceId === "dev-1");
  assert.equal(anon.cost, 7);
});

test("§E.1 export --json bundle: deviceId, hostnameHash, supportedAgents ready, events present", () => {
  const env = fixtureEnv();
  const idFile = path.join(env.BURN_CLAUDE_DIR, "burn-id");
  const r = spawnCli(["export", "--json"], { ...env, BURN_ID_FILE: idFile });
  assert.equal(r.status, 0, r.stderr.toString());
  const doc = JSON.parse(r.stdout.toString());
  assert.equal(doc.specVersion, "2.0");
  assert.match(doc.deviceId, /^[0-9a-f]{8}-/i, "persisted uuid at ~/.burn/id");
  assert.match(doc.hostnameHash, /^[0-9a-f]{8}$/, "8-hex display-only hash");
  assert.ok(Array.isArray(doc.events) && doc.events.length === 4, "export carries raw events for merge fidelity");
  assert.ok(doc.supportedAgents.find((a) => a.id === "codex" && a.status === "ready"));
  assert.ok(fs.existsSync(idFile), "deviceId persisted");
  assert.equal(doc.deviceId, fs.readFileSync(idFile, "utf8").trim(), "id file is the source of truth");
});

test("§E.1 export --compact drops events; full export strips paths + reshapes attribution (privacy)", () => {
  const env = fixtureEnv();
  const idFile = path.join(env.BURN_CLAUDE_DIR, "burn-id2");
  const full = JSON.parse(spawnCli(["export"], { ...env, BURN_ID_FILE: idFile }).stdout.toString());
  const compact = JSON.parse(spawnCli(["export", "--compact"], { ...env, BURN_ID_FILE: idFile }).stdout.toString());
  assert.ok(Array.isArray(full.events) && full.events.length === 4, "default export carries raw events for merge fidelity");
  assert.ok(!("events" in compact), "--compact drops events[] (report-only transport, SPEC-2 §E.2)");
  const sample = full.events[0];
  assert.ok(!("dir" in sample), "raw absolute dir path stripped from exported events (v1 §9 privacy)");
  assert.ok(!("unit" in sample), "internal unit replaced by attribution shape");
  assert.ok(sample.attribution && "confidence" in sample.attribution);
  assert.equal(compact.deviceId, full.deviceId, "same persisted deviceId");
});

// ---------- SPEC-3-5 §V3.M5: ULP 1.0 schema, negotiation, pure export ----------
import { ulpSchema, negotiate, tildePath, toUlpDocument, validateAgainstUlp } from "../src/ulp/ulp.js";
import { validate, schemaVocabularyCheck } from "../src/ulp/validate.js";

test("V3.A: our own schema stays inside the hand-rolled validator's vocabulary", () => {
  assert.deepEqual(schemaVocabularyCheck(ulpSchema()), [], "no unsupported JSON Schema keywords");
});

test("V3.A: version negotiation — burn 2.0 maps to ULP 1.0; majors reject; newer minors relax", () => {
  assert.deepEqual(negotiate({ specVersion: "2.0" }), { ok: true, relax: false });
  assert.deepEqual(negotiate({ ulpVersion: "1.0" }), { ok: true, relax: false });
  const newer = negotiate({ ulpVersion: "1.4" });
  assert.ok(newer.ok && newer.relax && newer.warn.includes("1.4"), "newer minor: accept + warn + relax");
  const bad = negotiate({ ulpVersion: "2.0" });
  assert.ok(!bad.ok && bad.error.includes("major"), "major mismatch names the version");
  assert.ok(!negotiate({ specVersion: "9.9" }).ok, "no mapping → reject, never guess");
});

test("V3.A validator + purify unit: workUnits rename, x-* strip, tilde, unknown-field gate", () => {
  const doc = toUlpDocument({
    specVersion: "2.0", generatedAt: "2026-09-26T00:00:00.000Z",
    totals: { key: "total", events: 0, cost: 0, store: 0, estimate: 0, unpricedEvents: 0, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, reasoning: 0 }, cacheHit: 0 },
    cacheHit: 0, totalTokens: 0, sources: { store: 0, estimate: 0, unpriced: 0 },
    repos: [], models: [], agents: [], days: [], sessions: [],
    units: [{ key: "branch:x", events: 1, cost: 1, store: 0, estimate: 1, unpricedEvents: 0, tokens: { input: 1, output: 0, cacheWrite: 0, cacheRead: 0, reasoning: 0 }, cacheHit: 0, unit: { kind: "branch", name: "x", confidence: "native" } }],
    "x-burn-flavor": { anything: true },
  });
  assert.deepEqual(validateAgainstUlp(doc), [], "purified doc validates");
  assert.ok(!("x-burn-flavor" in doc) && !("units" in doc), "extensions stripped, units renamed");
  assert.equal(doc.workUnits[0].unit.ref, "x", "name → protocol ref");
  assert.equal(tildePath(path.join(os.homedir(), ".claude", "projects")), "~/.claude/projects");
  assert.equal(tildePath("/tmp/whatever"), null, "outside home → omit, never leak");
  const strict = { ...doc, surpriseField: 1 };
  assert.ok(validate(strict, ulpSchema()).some((e) => e.includes("surpriseField")), "additionalProperties:false gates core");
  assert.deepEqual(validate(strict, ulpSchema(), { relaxUnknown: true }), [], "relaxUnknown lets newer minors through");
});

test("V16: export --ulp emits a pure, schema-valid, path-free ULP document", () => {
  const env = fixtureEnv();
  const r = spawnCli(["export", "--ulp"], { ...env, BURN_ID_FILE: path.join(env.BURN_CLAUDE_DIR, "ulp-id") });
  assert.equal(r.status, 0, r.stderr.toString());
  const doc = JSON.parse(r.stdout.toString());
  assert.equal(doc.ulpVersion, "1.0");
  assert.deepEqual(validateAgainstUlp(doc), []);
  assert.ok(Array.isArray(doc.workUnits) && doc.workUnits.length > 0, "protocol name, not burn's units");
  const s = JSON.stringify(doc);
  assert.ok(!/"x-/.test(s), "no x-burn-* extension fields in a core document");
  assert.ok(!/\/Users\/|\/home\/|\/private\//.test(s), "no absolute paths anywhere in the bundle");
  for (const a of doc.supportedAgents) {
    assert.ok(!("storePath" in a) || /^[~$]/.test(a.storePath), "store paths tilde-form or omitted (fixtures live in tmp)");
  }
});

test("V16: plain export bundles are path-free too (shareable file, P3)", () => {
  const env = fixtureEnv();
  const r = spawnCli(["export"], { ...env, BURN_ID_FILE: path.join(env.BURN_CLAUDE_DIR, "ulp-id2") });
  assert.equal(r.status, 0, r.stderr.toString());
  assert.ok(!/\/Users\/|\/home\/|\/private\//.test(r.stdout.toString()), "bundle never carries absolute store paths");
});

const havePython = spawnSync("python3", ["-V"]).status === 0;
test("V16 M5-acceptance: the independent Python reader validates a burn --ulp bundle with zero burn knowledge", { skip: !havePython && "python3 unavailable" }, () => {
  const env = fixtureEnv();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "burn-ulp-py-"));
  const bundle = path.join(tmp, "b.ulp.json");
  const r = spawnCli(["export", "--ulp", "-o", bundle], { ...env, BURN_ID_FILE: path.join(env.BURN_CLAUDE_DIR, "ulp-id3") });
  assert.equal(r.status, 0, r.stderr.toString());
  const reader = fileURLToPath(new URL("../ulp/reference/ulp-reader.py", import.meta.url));
  const v = spawnSync("python3", [reader, "validate", bundle], { encoding: "utf8" });
  assert.equal(v.status, 0, `python validate: ${v.stdout}${v.stderr}`);
  assert.match(v.stdout.trim(), /^OK$/);
  const t = spawnSync("python3", [reader, "totals", bundle], { encoding: "utf8" });
  assert.equal(t.status, 0, t.stderr);
  const py = JSON.parse(t.stdout);
  const doc = JSON.parse(fs.readFileSync(bundle, "utf8"));
  assert.equal(py.totals.events, doc.totals.events, "implementation #2 agrees on event count");
  assert.ok(Math.abs(py.totals.cost - doc.totals.cost) < 1e-9, "…and on cost (recomputed from events, not copied)");
  assert.deepEqual(py.sources, doc.sources, "…and on provenance class counts");
});

// ---------- SPEC-3-5 §V3.M6: burn ingest ----------
function foreignBundle(over = {}) {
  const tok = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, reasoning: 0 };
  const ev = (sessionId, model, tokens, cost, costSource) => ({
    agent: "aider", sessionId, model, repo: "aider-playground", date: "2026-09-20",
    tokens: { ...tok, ...tokens }, storedCost: null, cost, costSource,
    gitBranch: null, attribution: { kind: "repo", ref: "aider-playground", confidence: "guess" },
  });
  const events = over.events || [
    ev("aid-77", "claude-sonnet-4", { input: 1_000_000 }, 3.0, "estimate"),
    ev("aid-77", "aider-unknown-x", { input: 5_000, output: 200 }, 0, "unpriced"),
  ];
  return {
    ulpVersion: over.ulpVersion || "1.0",
    generatedAt: "2026-09-20T12:00:00.000Z",
    deviceId: over.deviceId || "aiderbox-0001",
    hostnameHash: "abcd1234",
    totals: { key: "total", events: events.length, cost: 3, store: 0, estimate: 3, unpricedEvents: 1, tokens: { ...tok, input: 1_005_000, output: 200 }, cacheHit: 0 },
    cacheHit: 0, totalTokens: 1_005_200,
    sources: { store: 0, estimate: 1, unpriced: 1 },
    repos: [], models: [], agents: [], days: [], sessions: [], events,
    ...(over.extra || {}),
  };
}

function writeBundle(dir, name, doc) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(doc, null, 2));
  return p;
}

test("V19 M6-acceptance: an ingested foreign-agent ledger joins every report", () => {
  const env = fixtureEnv();
  const ing = fs.mkdtempSync(path.join(os.tmpdir(), "burn-ing-"));
  const base = { ...env, BURN_INGEST_DIR: ing, BURN_ID_FILE: path.join(ing, "id") };
  const file = writeBundle(ing, "aider.json", foreignBundle());
  const r = spawnCli(["ingest", file], base);
  assert.equal(r.status, 0, r.stderr.toString());
  assert.match(r.stdout.toString(), /stored/);

  const j = JSON.parse(spawnCli(["--json"], base).stdout.toString());
  const liveOnly = JSON.parse(spawnCli(["--json"], { ...env, BURN_ID_FILE: path.join(ing, "id") }).stdout.toString());
  assert.equal(j.totals.events, liveOnly.totals.events + 2, "foreign events join the totals");
  const aider = j.agents.find((a) => a.key === "aider");
  assert.ok(aider && aider.events === 2, "foreign agent appears in the agent matrix");
  const repo = j.repos.find((x) => x.key === "aider-playground");
  assert.ok(repo && Math.abs(repo.cost - 3.0) < 1e-9, "…and in repos with its recorded dollars intact");
  assert.equal(j.sources.estimate, liveOnly.sources.estimate + 1, "provenance classes merge honestly [19]");
  assert.equal(j.sources.unpriced, liveOnly.sources.unpriced + 1, "their unpriced stays unpriced — never re-priced locally");
  assert.ok(j.deviceIds.includes("aiderbox-0001"), "contributing devices listed");
});

test("V21: re-ingesting the same bundle is a content-addressed no-op", () => {
  const env = fixtureEnv();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "burn-ing2src-"));
  const ing = fs.mkdtempSync(path.join(os.tmpdir(), "burn-ing2-"));
  const base = { ...env, BURN_INGEST_DIR: ing, BURN_ID_FILE: path.join(ing, "id") };
  const file = writeBundle(src, "aider.json", foreignBundle());
  assert.equal(spawnCli(["ingest", file], base).status, 0);
  const second = spawnCli(["ingest", file], base);
  assert.equal(second.status, 0);
  assert.match(second.stdout.toString(), /already present/);
  assert.equal(fs.readdirSync(ing).filter((f) => f.endsWith(".json")).length, 1, "one stored copy, content-hashed");
  const j = JSON.parse(spawnCli(["--json"], base).stdout.toString());
  const aider = j.agents.find((a) => a.key === "aider");
  assert.equal(aider.events, 2, "identity union: no double counting on repeat ingest");
});

test("V18: estimated-cost mismatch is REPORTED, never repaired; --strict gates it", () => {
  const env = fixtureEnv();
  const ing = fs.mkdtempSync(path.join(os.tmpdir(), "burn-ing3-"));
  const base = { ...env, BURN_INGEST_DIR: ing, BURN_ID_FILE: path.join(ing, "id") };
  const events = foreignBundle().events.map((e, i) => (i === 0 ? { ...e, cost: 42.0 } : e));
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "burn-ing3src-"));
  const file = writeBundle(src, "drifted.json", foreignBundle({ events, deviceId: "drift-box-2" }));

  const soft = spawnCli(["ingest", file], base);
  assert.equal(soft.status, 0, "default: ingest succeeds, disagreement reported");
  assert.match(soft.stderr.toString(), /1 estimated-cost mismatch/);
  assert.match(soft.stderr.toString(), /claims \$42\.00/);
  const j = JSON.parse(spawnCli(["--json"], base).stdout.toString());
  const repo = j.repos.find((x) => x.key === "aider-playground");
  assert.ok(repo.cost > 40, "their recorded $42 stays $42 — burn never rewrites history it doesn't own [18]");

  const file2 = writeBundle(src, "drifted2.json", foreignBundle({ events, deviceId: "drift-box-3" }));
  const strict = spawnCli(["ingest", "--strict", file2], base);
  assert.equal(strict.status, 2, "--strict turns mismatch into exit 2");
  assert.match(strict.stderr.toString(), /mismatch/);
});

test("V17: version negotiation at the ingest boundary", () => {
  const env = fixtureEnv();
  const ing = fs.mkdtempSync(path.join(os.tmpdir(), "burn-ing4-"));
  const base = { ...env, BURN_INGEST_DIR: ing, BURN_ID_FILE: path.join(ing, "id") };

  const src = fs.mkdtempSync(path.join(os.tmpdir(), "burn-ing4src-"));
  const future = writeBundle(src, "future.json", foreignBundle({ ulpVersion: "2.0" }));
  const rej = spawnCli(["ingest", future], base);
  assert.equal(rej.status, 2);
  assert.match(rej.stderr.toString(), /major version 2 is not supported/);
  assert.equal(fs.readdirSync(ing).filter((f) => f.endsWith(".json")).length, 0, "rejected data never reaches the store");

  const newer = foreignBundle({ ulpVersion: "1.4", extra: { someFutureCoreField: { hey: true } } });
  const nfile = writeBundle(src, "newer.json", newer);
  const ok = spawnCli(["ingest", nfile], base);
  assert.equal(ok.status, 0, "newer minor: accepted with unknown fields ignored");
  assert.match(ok.stderr.toString(), /newer than this tool/);

  const garbage = path.join(src, "junk.json");
  fs.writeFileSync(garbage, "{ not json");
  const bad = spawnCli(["ingest", garbage], base);
  assert.equal(bad.status, 2);
});

test("V3.B: ingest usage gate, directory scan, and --list inventory", () => {
  const env = fixtureEnv();
  const ing = fs.mkdtempSync(path.join(os.tmpdir(), "burn-ing5-"));
  const base = { ...env, BURN_INGEST_DIR: ing, BURN_ID_FILE: path.join(ing, "id") };
  assert.equal(spawnCli(["ingest"], base).status, 2, "no targets → usage error");

  const src = fs.mkdtempSync(path.join(os.tmpdir(), "burn-ing5src-"));
  writeBundle(src, "a.json", foreignBundle());
  writeBundle(src, "b.json", foreignBundle({ deviceId: "aiderbox-0002", events: [] }));
  const dirRun = spawnCli(["ingest", src], base);
  assert.equal(dirRun.status, 0, dirRun.stderr.toString());
  assert.match(dirRun.stdout.toString(), /2 bundle\(s\) validated/, "directory argument scans *.json");

  const l = spawnCli(["ingest", "--list", "--json"], base);
  assert.equal(l.status, 0);
  const lj = JSON.parse(l.stdout.toString());
  assert.equal(lj.bundles.length, 2);
  assert.ok(lj.bundles.every((b) => b.readable && /^[0-9a-f]{16}$/.test(b.file.replace(".json", ""))));
});

// ---------- SPEC-3-5 §V3.M7: conformance kit, two-language green, docs site ----------
import { runKit, vectorsDir } from "../src/ulp/conformance.js";

test("V20: the kit itself is pure JSON in → pass/fail out — every vector green in Node", () => {
  const results = runKit();
  assert.ok(results.length >= 8, "the 16–21 set plus reframed v1/v2 subsets");
  const failing = results.filter((r) => !r.pass);
  assert.deepEqual(failing.map((f) => `${f.id}: ${f.notes.join("; ")}`), [], "8/8 green");
  // vectors carry no burn-specific knowledge: keys are the documented kit shape
  for (const f of fs.readdirSync(vectorsDir())) {
    const v = JSON.parse(fs.readFileSync(path.join(vectorsDir(), f), "utf8"));
    assert.ok(["validate", "validate-both", "merge"].includes(v.kind), `${f}: kind in the kit contract`);
    assert.ok(v.bundle || v.bundles, `${f}: carries its document(s) under bundle/bundles`);
    if (v.bundles) assert.ok(!("bundle" in v), `${f}: merge vectors use bundles`);
  }
});

test("V20: `burn conformance` exits 0 (text + --json)", () => {
  const t = spawnSync(process.execPath, ["src/cli.js", "conformance"], {
    cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), ".."), encoding: "utf8",
  });
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout, /all vectors green/);
  const j = spawnSync(process.execPath, ["src/cli.js", "conformance", "--json"], {
    cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), ".."), encoding: "utf8",
  });
  assert.equal(j.status, 0, j.stderr);
  const out = JSON.parse(j.stdout);
  assert.equal(out.ulpVersion, "1.0");
  assert.ok(out.results.length >= 8 && out.results.every((r) => r.pass));
});

test("V20 two-language green: the stdlib Python reader passes every vector, and totals match burn's to 1e-9",
  { skip: !havePython && "python3 unavailable" }, () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const reader = path.join(root, "ulp", "reference", "ulp-reader.py");
  const py = spawnSync("python3", [reader, "conform"], { cwd: root, encoding: "utf8" });
  assert.equal(py.status, 0, `${py.stdout}\n${py.stderr}`);
  assert.match(py.stdout, /all vectors green/);

  // identical merge totals between implementations #1 and #2 on K06
  const kit = path.join(root, "ulp", "conformance", "vectors");
  const k06 = JSON.parse(fs.readFileSync(path.join(kit, "K06-union-recompute-not-sum.json"), "utf8"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "burn-k06-"));
  const files = k06.bundles.map((b, i) => {
    const p = path.join(tmp, `b${i}.json`);
    fs.writeFileSync(p, JSON.stringify(b));
    return p;
  });
  const pyt = spawnSync("python3", [reader, "--schema", path.join(root, "ulp", "schema-1.0.json"), "totals", ...files],
    { encoding: "utf8" });
  assert.equal(pyt.status, 0, pyt.stderr);
  const got = JSON.parse(pyt.stdout);
  assert.equal(got.totals.events, k06.expect.totals.events);
  assert.ok(Math.abs(got.totals.cost - k06.expect.totals.cost) < 1e-9, "py cost matches the vector's expectation");
});

test("V20 negative control: a broken vector fails BOTH runners with exit 2 (kit is not vacuous)", () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), "burn-kit-bad-"));
  const good = JSON.parse(fs.readFileSync(path.join(vectorsDir(), "K01-valid-minimal-bundle.json"), "utf8"));
  fs.writeFileSync(path.join(bad, "K01-valid-minimal-bundle.json"), JSON.stringify({ ...good, expect: { ok: false } }));
  fs.writeFileSync(path.join(bad, "K99-claim.json"), JSON.stringify({ ...good, id: "K99", expect: { ok: false } }));

  const node = spawnSync(process.execPath, ["src/cli.js", "conformance"], {
    cwd: root, encoding: "utf8", env: { ...process.env, ULP_VECTORS_DIR: bad },
  });
  assert.equal(node.status, 2, "flipped expectation must fail the run");
  assert.match(node.stdout, /K01/);

  if (havePython) {
    const py = spawnSync("python3", [path.join(root, "ulp", "reference", "ulp-reader.py"), "conform", bad], { encoding: "utf8" });
    assert.equal(py.status, 2, "both runners reject the same broken kit");
    assert.match(py.stdout, /FAIL K01/);
  }
});

test("V3.D: docs/ulp static site renders from the repo sources, deterministically and script-free", () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const script = path.join(root, "scripts", "render-docs.mjs");
  const first = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  const pages = {};
  for (const f of ["index.html", "ulp.html", "schema.html", "conformance.html"]) {
    pages[f] = fs.readFileSync(path.join(root, "docs", "ulp", f), "utf8");
    assert.ok(pages[f].startsWith("<!doctype html>"), `${f} is a complete page`);
    assert.ok(!/<script|srcdoc|fetch\(/.test(pages[f]), `${f} ships no JavaScript — rendering only`);
  }
  assert.match(pages["ulp.html"], /<h2 id="3-cost-provenance"/, "SPEC.md headings render with anchors");
  assert.match(pages["ulp.html"], /<table>/, "provenance table renders");
  assert.match(pages["conformance.html"], /ULP 1\.0 conformance kit/);
  assert.match(pages["schema.html"], /"ulpVersion"/, "schema JSON is embedded, not lost");

  spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
  for (const f of Object.keys(pages)) {
    assert.equal(fs.readFileSync(path.join(root, "docs", "ulp", f), "utf8"), pages[f], `${f} is byte-stable`);
  }
});

// ---------- SPEC-3-5 §V4.M8: snapshots = self-merge ----------
import { historyDir, snapshotName } from "../src/history.js";

// A fully isolated one-session Claude Code fixture: everything else neutral.
function histFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "burn-hist-"));
  const proj = path.join(root, "projects", "-h-h");
  fs.mkdirSync(proj, { recursive: true });
  const turn = (iso, inp) => JSON.stringify({
    type: "assistant", sessionId: "HS1", timestamp: iso, cwd: "/x/h",
    message: { model: "claude-sonnet-4", usage: { input_tokens: inp, output_tokens: 10 } },
  });
  const file = path.join(proj, "HS1.jsonl");
  fs.writeFileSync(file, [turn("2026-09-20T10:00:00.000Z", 1_000_000), turn("2026-09-20T11:00:00.000Z", 1_000_000)].join("\n") + "\n");
  const ing = path.join(root, "ingest");
  fs.mkdirSync(ing);
  const env = {
    BURN_CLAUDE_DIR: path.join(root, "projects"), BURN_OPENCODE_DB: "/nonexistent.db",
    BURN_INGEST_DIR: ing, BURN_HISTORY_DIR: path.join(root, "history"),
    BURN_ID_FILE: path.join(root, "id"), BURN_ATTRIBUTES: path.join(root, "attrs.json"),
  };
  fs.writeFileSync(env.BURN_ID_FILE, "machine-hist-01\n");
  return { root, file, env };
}

const snapshotsIn = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".burn.json")).sort() : [];

test("V22: burn snapshot writes a schema-valid ULP bundle; re-snapshots dedupe to the same totals", () => {
  const { env, root } = histFixture();
  const r = spawnCli(["snapshot"], env);
  assert.equal(r.status, 0, r.stderr.toString());
  assert.match(r.stdout.toString(), /snapshot →/);
  const hist = path.join(root, "history");
  const files = snapshotsIn(hist);
  assert.equal(files.length, 1, "one snapshot file");
  assert.match(files[0], /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}\.burn\.json$/, "ULP bundle naming");
  const doc = JSON.parse(fs.readFileSync(path.join(hist, files[0]), "utf8"));
  assert.equal(doc.ulpVersion, "1.0");
  assert.deepEqual(validateAgainstUlp(doc), [], "history IS ordinary ULP bundles — nothing custom");
  assert.equal(doc.deviceId, "machine-hist-01");

  spawnCli(["snapshot"], env); // second run: same minute overwrites (idempotent), later minute adds one
  const base = JSON.parse(spawnCli(["--json"], env).stdout.toString()).totals;
  const withH = JSON.parse(spawnCli(["--json", "--history"], env).stdout.toString()).totals;
  assert.equal(withH.events, base.events, "union identity: snapshot events dedupe against live [22]");
  assert.ok(Math.abs(withH.cost - base.cost) < 1e-9, "totals == single [22]");
});

test("V23 M8-acceptance: transcript deletion after snapshot — --history stable, without it the data is gone", () => {
  const { env, root, file } = histFixture();
  const before = JSON.parse(spawnCli(["--json"], env).stdout.toString()).totals;
  assert.equal(spawnCli(["snapshot"], env).status, 0);
  fs.rmSync(file);

  const gone = spawnCli(["--json"], env);
  assert.equal(gone.status, 1, "no history: the deleted transcript really is gone");
  const kept = spawnCli(["--json", "--history"], env);
  assert.equal(kept.status, 0, "history: transcript deletion stopped being data deletion");
  const t = JSON.parse(kept.stdout.toString()).totals;
  assert.equal(t.events, before.events, "…with identical totals [23]");
  assert.ok(Math.abs(t.cost - before.cost) < 1e-9);
});

test("V24: live-wins on identity collision; between snapshots, newer generatedAt wins", () => {
  const { env, root, file } = histFixture();
  assert.equal(spawnCli(["snapshot"], env).status, 0);
  // still-growing session: live now records DOUBLE the tokens of its snapshot
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/1000000/g, "2000000"));
  const liveOnly = JSON.parse(spawnCli(["--json"], env).stdout.toString()).totals;
  const merged = JSON.parse(spawnCli(["--json", "--history"], env).stdout.toString()).totals;
  assert.ok(Math.abs(merged.cost - liveOnly.cost) < 1e-9, "live event beats its stale snapshot twin [24]");
  assert.equal(merged.events, liveOnly.events, "…and is not double counted");

  // two snapshots of DIFFERENT vintages, no live data: the newer one wins
  const hist = path.join(root, "history");
  const srcFiles = snapshotsIn(hist);
  const src = JSON.parse(fs.readFileSync(path.join(hist, srcFiles[0]), "utf8"));
  fs.rmSync(file);
  for (const f of srcFiles) fs.rmSync(path.join(hist, f)); // leave only the two vintages below
  for (const [date, cost] of [["2026-09-19", 1.0], ["2026-09-21", 100.0]]) {
    const stale = structuredClone(src);
    stale.generatedAt = `${date}T10:00:00.000Z`;
    stale.events[0].cost = cost;
    fs.writeFileSync(path.join(hist, `${date}T10-00.burn.json`), JSON.stringify(stale));
  }
  const m = JSON.parse(spawnCli(["--json", "--history"], env).stdout.toString()).totals;
  assert.equal(m.events, 2, "identity union across the two snapshots");
  assert.ok(Math.abs(m.cost - (100.0 + src.events[1].cost)) < 1e-9, "newer snapshot's value survives [24]");
});

test("[23]: --history defaults — ON for forecast and budget month, OFF for plain summary", () => {
  const { env, root, file } = histFixture();
  assert.equal(spawnCli(["snapshot"], env).status, 0);
  fs.rmSync(file);
  assert.equal(spawnCli(["--json"], env).status, 1, "summary defaults to history OFF (v1/v2 stability)");
  assert.equal(spawnCli(["--json", "--history"], env).status, 0, "…and ON when asked");
  assert.equal(spawnCli(["forecast", "--json"], env).status, 0, "forecast defaults to history ON");
  assert.equal(spawnCli(["budget", "--repo", "h", "--max", "100", "--json"], env).status, 0, "budget (month default) too");
  assert.equal(spawnCli(["budget", "--repo", "h", "--max", "100", "--period", "day", "--json"], env).status, 1, "budget day: OFF default — today has no live data");
});

test("history ls / drop: inventory, confirmation gate, path safety, deletion", () => {
  const { env, root } = histFixture();
  assert.equal(spawnCli(["snapshot"], env).status, 0);
  const l = spawnCli(["history", "ls", "--json"], env);
  assert.equal(l.status, 0, l.stderr.toString());
  const rows = JSON.parse(l.stdout.toString()).snapshots;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].events, 2);
  assert.ok(rows[0].cost > 0 && rows[0].readable);

  const name = rows[0].file;
  const noConfirm = spawnCli(["history", "drop", name], env);
  assert.equal(noConfirm.status, 2, "the only destructive command REQUIRES confirmation");
  assert.match(noConfirm.stderr.toString(), /--yes/);
  for (const bad of ["../../etc/passwd", "notes.txt", "nope.burn.json"]) {
    assert.equal(spawnCli(["history", "drop", bad, "--yes"], env).status, 2, `refuses ${bad}`);
  }
  const ok = spawnCli(["history", "drop", name, "--yes"], env);
  assert.equal(ok.status, 0, ok.stderr.toString());
  assert.equal(snapshotsIn(path.join(root, "history")).length, 0);
});

test("§V4.D: snapshot writes only inside BURN_HISTORY_DIR (+ its own id file)", () => {
  const { env, root } = histFixture();
  const before = new Set(walkFiles(root));
  assert.equal(spawnCli(["snapshot"], env).status, 0);
  for (const f of walkFiles(root)) if (!before.has(f)) {
    assert.ok(f.startsWith(path.join(root, "history") + path.sep) || f === env.BURN_ID_FILE, `new file ${f} stays under the fixture root`);
  }
  assert.ok(snapshotName(new Date(Date.UTC(2026, 0, 2, 3, 4))).startsWith("2026-01-02T03-04"), "UTC names");
});

function walkFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
}

// ---------- SPEC-3-5 §V4.M9: report + plan + history read budget ----------
import { plan as planMath } from "../src/advise.js";
import { loadSnapshots } from "../src/history.js";

test("V25: plan gate — exit 0 affordable, 3 not affordable, 1 no data, 2 bad flags", () => {
  const { env, root, file } = histFixture();
  const ok = spawnCli(["plan", "--repo", "h", "--budget", "500", "--months", "2", "--json"], env);
  assert.equal(ok.status, 0, ok.stderr.toString());
  const p = JSON.parse(ok.stdout.toString()).plan;
  assert.equal(p.repo, "h");
  assert.equal(p.affordable, true);
  assert.ok(p.projectedCost > 0, "linear series projects real dollars, never a guess");

  const over = spawnCli(["plan", "--repo", "h", "--budget", "1", "--months", "2", "--json"], env);
  assert.equal(over.status, 3, "same gate contract as burn budget");
  const po = JSON.parse(over.stdout.toString()).plan;
  assert.equal(po.affordable, false);
  assert.ok(po.exhaustionDate > po.end, "increasing series DOES cite an exhaustion date [25]");

  // bad flags — rejected before any data is touched
  for (const bad of [
    ["plan", "--budget", "10", "--months", "1"], // no --repo
    ["plan", "--repo", "h", "--months", "1"], //    no --budget
    ["plan", "--repo", "h", "--budget", "10"], //   no --months
    ["plan", "--repo", "h", "--budget", "x", "--months", "1"],
    ["plan", "--repo", "h", "--budget", "10", "--months", "0"],
    ["plan", "--repo", "h", "--budget", "10", "--months", "25"],
  ]) {
    assert.equal(spawnCli(bad, env).status, 2, `must exit 2: ${bad.join(" ")}`);
  }
  // unknown repo → 2 with candidates; zero data anywhere → 1
  assert.equal(spawnCli(["plan", "--repo", "nope-xyz", "--budget", "5", "--months", "1"], env).status, 2);
  fs.rmSync(file);
  const emptyHist = path.join(root, "history2");
  const gone = spawnCli(["plan", "--repo", "h", "--budget", "5", "--months", "1"], { ...env, BURN_HISTORY_DIR: emptyHist });
  assert.equal(gone.status, 1, "no priced history anywhere exits 1 [25]");
});

test("V25 unit: plan math — exhaustion date only from an increasing series, never invented", () => {
  const ev = (date, cost) => ({
    agent: "x", sessionId: "s", model: "m", repo: "r", date, cost, costSource: "store",
    storedCost: cost, tokens: { input: 10, output: 1, cacheWrite: 0, cacheRead: 0, reasoning: 0 },
  });
  const days = (seq) => seq.map((c, i) => ev(`2026-09-${String(1 + i).padStart(2, "0")}`, c));

  const rising = planMath(days([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), { repo: "r", budgetUsd: 5, months: 1, windowDays: 10 });
  assert.equal(rising.found, true);
  assert.equal(rising.affordable, false);
  assert.ok(rising.increasing && rising.exhaustionDate > "2026-09-10", "exhaustion date when increasing");

  const falling = planMath(days([100, 99, 98, 97, 96, 95, 94, 93, 92, 91]), { repo: "r", budgetUsd: 2000, months: 1, windowDays: 10 });
  assert.ok(!falling.increasing, "declining series is detected as declining");
  assert.equal(falling.exhaustionDate, null, "no date is printed for a non-increasing series [25]");
  assert.equal(falling.affordable, false, "…but the honest NOT-AFFORDABLE verdict still stands");
  assert.ok(falling.projectedCost > 2000 && falling.projectedCost < 3000, "high-flat spend projects at its level, not a runaway");

  const rising10 = planMath(days([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), { repo: "r", budgetUsd: 5000, months: 1, windowDays: 10 });
  assert.ok(rising10.increasing && rising10.affordable, "a growing repo still fits a big enough budget");

  const unpricedOnly = planMath([ev("2026-09-02", null)].map((e) => ({ ...e, costSource: "unpriced" })), { repo: "r", budgetUsd: 1, months: 1 });
  assert.equal(unpricedOnly.found, false, "unpriced tokens are never projected into dollars");
});

test("V27 perf budget: 400 synthetic daily snapshots load + merge in < 500 ms (250 ms × 2 CI tolerance)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "burn-perf-"));
  process.env.BURN_HISTORY_DIR = dir;
  try {
    const tok = { input: 1000, output: 100, cacheWrite: 0, cacheRead: 2000, reasoning: 0 };
    for (let d = 0; d < 400; d++) {
      const day = new Date(Date.UTC(2025, 0, 1 + d));
      const iso = day.toISOString().slice(0, 10);
      const events = Array.from({ length: 6 }, (_, i) => ({
        agent: "claude-code", sessionId: `S${d % 20}`, model: "claude-sonnet-4", repo: `r${d % 5}`,
        date: iso, tokens: tok, storedCost: null, cost: 0.05 + i * 0.01, costSource: "estimate", gitBranch: null,
      }));
      const doc = {
        ulpVersion: "1.0", generatedAt: `${iso}T23:59:00.000Z`, deviceId: `perfdev-${String(d % 3)}`,
        totals: { key: "total", events: events.length, cost: 0, store: 0, estimate: 0, unpricedEvents: 0, tokens: { ...tok }, cacheHit: 0 },
        cacheHit: 0, totalTokens: 0, sources: { store: 0, estimate: events.length, unpriced: 0 },
        repos: [], models: [], agents: [], days: [], sessions: [], events,
      };
      const p2 = (n) => String(n).padStart(2, "0");
      fs.writeFileSync(
        path.join(dir, `${iso}T23-59.burn.json`),
        JSON.stringify(doc)
      );
      void p2;
    }
    assert.equal(snapshotsIn(dir).length, 400);
    const t0 = performance.now();
    const { docs, skipped } = loadSnapshots();
    const merged = mergeBundles([{ deviceId: "live", events: [] }, ...docs], { attributes: {} });
    const ms = performance.now() - t0;
    assert.equal(skipped.length, 0);
    assert.ok(merged.totals.events > 0, "the perf fixture actually exercises the merge");
    assert.ok(ms < 500, `history read budget: ${ms.toFixed(0)} ms for 400 snapshots (budget 2×250 ms) [27]`);
    assert.equal(docs[0].generatedAt.slice(0, 4), "2026", "newest snapshot ordered first");
  } finally {
    delete process.env.BURN_HISTORY_DIR;
  }
});

test("report: monthly markdown digest — scoped window, provenance, cache, doctor, zero paths [V4.B]", () => {
  const { env } = histFixture();
  const r = spawnCli(["report", "--month", "2026-09", "--json"], env);
  assert.equal(r.status, 0, r.stderr.toString());
  const md = JSON.parse(r.stdout.toString()).markdown;
  assert.match(md, /^# burn report — 2026-09/);
  assert.match(md, /Window 2026-09-01 → 2026-10-01/);
  assert.match(md, /\*\*Total: \$6\.0\d+\*\*/, "fixture month totals");
  assert.match(md, /## By repository[\s\S]*\| h \|/);
  assert.match(md, /Cost provenance: 0 billed .* 2 estimated/);
  assert.match(md, /## Cache economics/);
  assert.match(md, /## Doctor/);
  assert.ok(!/\/Users\/|\/home\/|\/private\/|\/var\/folders/.test(md), "a report is safe to commit — no paths");

  // window scoping: a month that predates the fixture has nothing to show
  const emptyMonth = spawnCli(["report", "--month", "2026-08"], env);
  assert.equal(emptyMonth.status, 1, "--month really filters [25 sibling: until window]");
  for (const bad of [["report", "--month", "2026-13"], ["report", "--month", "sep-26"]]) {
    assert.equal(spawnCli(bad, env).status, 2, `bad --month exits 2: ${bad[1]}`);
  }

  const out = path.join(env.BURN_HISTORY_DIR, "..", "september.md");
  const w = spawnCli(["report", "--month", "2026-09", "-o", out], env);
  assert.equal(w.status, 0, w.stderr.toString());
  assert.match(fs.readFileSync(out, "utf8"), /^# burn report — 2026-09/);
});

// ---------- SPEC-3-5 §V4.M10: doctor grows up — R-5, R-6 ----------
test("V26 R-5 spend runaway: fires on a >3× week-over-week jump, cites both weeks; silent on healthy", async () => {
  const pricing = await loadPricing({});
  const ev = (date, cost, source = "store") => ({
    agent: "a", sessionId: "s", model: "m", repo: "r", date, cost,
    costSource: source, storedCost: source === "store" ? cost : null,
    tokens: { input: 1000, output: 10, cacheWrite: 0, cacheRead: 0, reasoning: 0 },
  });
  const calm = [ev("2026-09-08", 1), ev("2026-09-12", 1), ev("2026-09-16", 2), ev("2026-09-20", 2.5)];
  assert.ok(!doctor(calm, pricing).some((f) => f.rule.startsWith("R-5")), "2.5× growth is a busy week, not a runaway");

  const runaway = [ev("2026-09-08", 1), ev("2026-09-12", 1), ev("2026-09-15", 10, "estimate"), ev("2026-09-20", 12, "estimate")];
  const f = doctor(runaway, pricing).find((x) => x.rule === "R-5 spend runaway");
  assert.ok(f, "10× jump fires [26]");
  assert.equal(f.severity, "info");
  assert.equal(f.scope, "ledger");
  assert.match(f.observation, /2026-09-07 → 2026-09-13/);
  assert.match(f.observation, /2026-09-14 → 2026-09-20/, "both weeks cited");
  assert.equal(f.estImpactClass, "estimated", "majority class of the NEWER week [26]");

  // tiny denominators must not shout: $0.50 → $10 is noise, not a trend
  const noisy = [ev("2026-09-10", 0.5), ev("2026-09-18", 10)];
  assert.ok(!doctor(noisy, pricing).some((x) => x.rule === "R-5 spend runaway"), "≥$1 baseline required");
});

test("V26 R-6 orphan spend: fires against a real git repo with no commits in window; silent otherwise", async () => {
  const pricing = await loadPricing({});
  const g = gitSetup();
  g.commit("old.txt", "2026-08-01T10:00:00Z"); // history exists — but not in the spend window
  const ev = (dir, cost) => ({
    agent: "a", sessionId: "s", model: "claude-sonnet-4", repo: "ghostwork", date: "2026-09-11",
    cost, costSource: "estimate", storedCost: null, dir,
    tokens: { input: 1_000_000, output: 10, cacheWrite: 0, cacheRead: 0, reasoning: 0 },
  });
  const orphan = doctor([ev(g.dir, 3.0), ev(g.dir, 3.0)], pricing).find((x) => x.rule === "R-6 orphan spend");
  assert.ok(orphan, "$6 estimated, zero commits in window → fire [26]");
  assert.equal(orphan.scope, "repo:ghostwork");
  assert.ok(!JSON.stringify(orphan).includes(g.dir), "the observation cites repo basenames, never the absolute path");

  g.commit("landed.txt", "2026-09-11T12:00:00Z"); // work lands → silent
  assert.ok(!doctor([ev(g.dir, 3.0), ev(g.dir, 3.0)], pricing).some((x) => x.rule === "R-6 orphan spend"), "commit inside window ⇒ silent");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "burn-notarepo-"));
  assert.ok(!doctor([ev(tmp, 3.0), ev(tmp, 3.0)], pricing).some((x) => x.rule === "R-6 orphan spend"), "non-repos silently skip — burn never guesses at a missing VCS");
  assert.ok(!doctor([ev(g.dir, 2.0), ev(g.dir, 2.0)], pricing).some((x) => x.rule === "R-6 orphan spend"), "under $X threshold stays silent");
});

// ---------- SPEC-3-5 §V5.M11: the ulp/ home stands alone ----------
test("V32: ulp/ is a self-contained protocol home — the py reader passes the kit from a copy of that folder alone",
  { skip: !havePython && "python3 unavailable" }, () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const home = path.join(root, "ulp");
  for (const f of [
    "README.md", "SPEC.md", "schema-1.0.json", "CHANGELOG.md",
    "conformance/README.md", "rfc/README.md", "rfc/0001-extension-namespaces.md",
    "reference/ulp-reader.py",
  ]) {
    assert.ok(fs.existsSync(path.join(home, f)), `protocol home carries ${f}`);
  }
  // governance: the RFC index lists 0001 and the namespace shape is documented
  const rfc1 = fs.readFileSync(path.join(home, "rfc", "0001-extension-namespaces.md"), "utf8");
  assert.match(rfc1, /\{repo-or-user\}-\{tool\}/, "registry-free namespace convention published");

  // independence: ship ONLY the ulp/ folder — same vectors, same green
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ulp-home-"));
  fs.cpSync(home, path.join(tmp, "ulp"), { recursive: true });
  const py = spawnSync("python3", [path.join(tmp, "ulp", "reference", "ulp-reader.py"), "conform"], { encoding: "utf8" });
  assert.equal(py.status, 0, `${py.stdout}\n${py.stderr}`);
  assert.match(py.stdout, /all vectors green/, "the folder alone is sufficient [32]");

});

// ---------- SPEC-3-5 §V5.M12: the OpenTelemetry seam ----------
import { toOtlp, fromOtlp } from "../src/ulp/otel.js";

test("V28: export --otel writes OTLP/JSON; ingest --otel round-trips an identical ledger", () => {
  const { env, root } = histFixture();
  const otlpFile = path.join(root, "x.otlp.json");
  const r = spawnCli(["export", "--otel", "-o", otlpFile], env);
  assert.equal(r.status, 0, r.stderr.toString());
  assert.match(r.stderr.toString(), /0 dropped/, "lossless-or-loud reports the balance [28]");
  const otlp = JSON.parse(fs.readFileSync(otlpFile, "utf8"));
  const spans = otlp.resourceSpans[0].scopeSpans[0].spans;
  assert.equal(spans.length, 2);
  for (const sp of spans) {
    assert.match(sp.traceId, /^[0-9a-f]{32}$/, "deterministic OTLP ids");
    assert.match(sp.spanId, /^[0-9a-f]{16}$/);
    assert.match(sp.startTimeUnixNano, /^\d+$/, "int64 as string = OTLP/JSON encoding");
    assert.equal(sp.kind, "SPAN_KIND_CLIENT");
    assert.ok(sp.attributes.some((a) => a.key === "gen_ai.operation.name" && a.value.stringValue === "chat"));
  }
  const live = JSON.parse(spawnCli(["--json"], env).stdout.toString());

  const ing2 = fs.mkdtempSync(path.join(os.tmpdir(), "burn-otel-ing-"));
  const i = spawnCli(["ingest", "--otel", otlpFile], { ...env, BURN_INGEST_DIR: ing2 });
  assert.equal(i.status, 0, i.stderr.toString());
  assert.match(i.stdout.toString(), /stored/);
  const back = JSON.parse(
    spawnCli(["--json"], { ...env, BURN_INGEST_DIR: ing2, BURN_CLAUDE_DIR: path.join(root, "projects-nope") }).stdout.toString()
  );
  assert.equal(back.totals.events, live.totals.events, "ingest(export(x)) ≡ x on events [28]");
  assert.ok(Math.abs(back.totals.cost - live.totals.cost) < 1e-9, "…to 1e-9 on cost [28]");
  assert.deepEqual(back.sources, live.sources, "…and on provenance classes");
  const again = spawnCli(["ingest", "--otel", otlpFile], { ...env, BURN_INGEST_DIR: ing2 });
  assert.match(again.stdout.toString(), /already present/, "canonical ULP storage = content-addressed no-op");
});

test("V28 unit: toOtlp/fromOtlp is lossless over core fields; unknown fields make it LOUD", () => {
  const tok = { input: 1000, output: 5, cacheWrite: 7, cacheRead: 900, reasoning: 3 };
  const evs = [
    { agent: "aider", sessionId: "A1", model: "some-free-model", repo: "r", date: "2026-09-01", ts: 1756720000000,
      tokens: tok, storedCost: null, cost: null, costSource: "unpriced", gitBranch: null },
    { agent: "aider", sessionId: "A1", model: "gpt-x", repo: "r", date: "2026-09-01", ts: 1756720001000,
      tokens: { ...tok, cacheWrite: 0, reasoning: 0 }, storedCost: 2.5, cost: 2.5, costSource: "store", gitBranch: "fix/x" },
  ];
  const bundle = { ulpVersion: "1.0", generatedAt: "2026-09-02T00:00:00.000Z", deviceId: "otelbox-a1", events: evs };
  const { otlp, summary } = toOtlp(bundle);
  assert.deepEqual(summary.dropped, [], "every core field has a documented slot");
  const back = fromOtlp(otlp);
  assert.deepEqual(validateAgainstUlp(back), [], "the inverse yields a conformant ULP bundle");
  assert.equal(back.deviceId, "otelbox-a1");
  assert.equal(back.events.length, 2);
  for (let i = 0; i < 2; i++) {
    const a = evs[i], b = back.events[i];
    for (const k of ["agent", "sessionId", "model", "repo", "date", "costSource", "gitBranch"]) {
      assert.equal(b[k], a[k], `events[${i}].${k}`);
    }
    assert.deepEqual(b.tokens, a.tokens, `events[${i}].tokens`);
    assert.equal(b.ts, a.ts);
    assert.equal(b.storedCost, a.storedCost ?? null);
    if (a.cost == null) assert.equal(b.cost, null);
    else assert.ok(Math.abs(b.cost - a.cost) < 1e-9);
  }
  const leaky = { ...bundle, events: [{ ...evs[0], secretSauce: { recipe: true } }] };
  assert.deepEqual(toOtlp(leaky).summary.dropped, ["events[].secretSauce"], "lossy-by-silence is impossible by construction [28]");
});

test("V29: every gen_ai.* name in the mapping (and in code) exists in the pinned semconv snapshot — offline", () => {
  const pin = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ulp", "semconv-genai-pin.json"), "utf8"));
  assert.match(pin.commit, /^[0-9a-f]{12}$/, "pinned to a registry commit");
  const pinned = new Set(pin.attributes.map((a) => a.id));
  const mapping = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ulp", "otel-mapping.md"), "utf8");
  const names = new Set(mapping.match(/gen_ai\.[a-z_.]+/g) || []);
  assert.ok(names.size >= 8, "the mapping table cites real attribute ids");
  for (const n of names) assert.ok(pinned.has(n), `drift: ${n} is used in otel-mapping.md but absent from the pin [29]`);
  // and what the CODE emits must also be pinned
  const { summary } = toOtlp({ deviceId: "d", generatedAt: "2026-09-01T00:00:00.000Z", events: [] });
  for (const n of summary.mapped) assert.ok(pinned.has(n), `drift: code emits ${n}, the pin doesn't know it [29]`);
});

// ---------- SPEC-3-5 §V5.M13: pricingHash + attest + init --team ----------
test("V30: pricingHash changes iff the effective table changes; no table applied ⇒ stable null marker", async () => {
  const { loadPricing } = await import("../src/pricing.js");
  const base = await loadPricing({});
  const same = await loadPricing({ "claude-sonnet-4": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 } }); // same values, different merge path
  const moved = await loadPricing({ "claude-sonnet-4": { input: 3.01 } });
  assert.equal(base.tableHash(), same.tableHash(), "same effective table ⇒ same hash [30]");
  assert.notEqual(base.tableHash(), moved.tableHash(), "one price moved ⇒ different hash [30]");
  assert.match(base.tableHash(), /^[0-9a-f]{12}$/);

  const { env } = histFixture();
  const j = JSON.parse(spawnCli(["--json"], env).stdout.toString());
  assert.equal(j.pricingHash, base.tableHash(), "the ledger records the table that priced it [30]");

  // a ledger nobody priced carries the null marker, never a hash of nothing
  const ing = fs.mkdtempSync(path.join(os.tmpdir(), "burn-ph-"));
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "burn-phsrc-"));
  const tok = { input: 10, output: 1, cacheWrite: 0, cacheRead: 0, reasoning: 0 };
  const unpriced = foreignBundle({
    deviceId: "nullhash-dev-1",
    events: [{
      agent: "mystery", sessionId: "M1", model: "totally-unknown-9", repo: "mystery-repo", date: "2026-09-19",
      tokens: tok, storedCost: null, cost: null, costSource: "unpriced", gitBranch: null,
    }],
  });
  const file = writeBundle(src, "u.json", unpriced);
  assert.equal(spawnCli(["ingest", file], { ...env, BURN_INGEST_DIR: ing, BURN_CLAUDE_DIR: path.join(env.BURN_CLAUDE_DIR, "empty"), BURN_OPENCODE_DB: "/nonexistent.db" }).status, 0);
  const only = spawnCli(["--json"], { ...env, BURN_INGEST_DIR: ing, BURN_CLAUDE_DIR: path.join(env.BURN_CLAUDE_DIR, "empty"), BURN_OPENCODE_DB: "/nonexistent.db" });
  assert.equal(only.status, 0, only.stderr.toString());
  assert.equal(JSON.parse(only.stdout.toString()).pricingHash, null, "all-unpriced ⇒ null marker [30]");
});

test("V31: attest — method statement: provenance classes, pricingHash, versions; zero paths/hostnames/prices", () => {
  const { env } = histFixture();
  const r = spawnCli(["attest", "--month", "2026-09"], env);
  assert.equal(r.status, 0, r.stderr.toString());
  const md = r.stdout.toString();
  assert.match(md, /not an invoice/i);
  assert.match(md, /## Cost by provenance class/);
  assert.match(md, /estimated \(local pricing table\): \*\*\$6\.000\d\*\*/);
  assert.match(md, /pricingHash: `[0-9a-f]{12}`/);
  assert.match(md, /burn \d+\.\d+\.\d+ · ledger specVersion 2\.0 · ULP 1\.0/);
  assert.match(md, /## Advice state/);
  assert.ok(!/\/Users\/|\/home\/|\/private\/|\/var\/folders/.test(md), "no absolute paths [31]");
  assert.ok(!md.includes(os.hostname()), "no hostname [31]");
  assert.ok(!/\binput:\s*\d|\$3\/M|per 1M|table row/.test(md), "no per-model price claims beyond provenance classes [31]");
  const bad = spawnCli(["attest", "--month", "nope"], env);
  assert.equal(bad.status, 2);
});

test("V33: init --team — idempotent, repo-local, and its workflow's only network steps are checkout + git push", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "burn-team-"));
  fs.mkdirSync(path.join(repo, ".git"));
  const run = () => spawnSync(process.execPath, [fileURLToPath(new URL("../src/cli.js", import.meta.url)), "init", "--team"], {
    cwd: repo, encoding: "utf8",
    env: { ...process.env, BURN_ATTRIBUTES: path.join(repo, "attrs.json") },
  });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /created/g);
  const wf = fs.readFileSync(path.join(repo, ".github", "workflows", "burn-usage.yml"), "utf8");
  assert.match(wf, /git push/, "bundle delivery rides on git");
  assert.ok(!/curl|wget|npx|npm i|npm install|pip |gh api|gh pr|api\.|https?:/.test(wf),
    "grep gate: no registry, no API, no URLs — the workflow's only network is checkout + git push [33]");
  assert.match(wf, /burn snapshot/, "cron runs the SAME snapshot command the human runs");

  const second = run();
  assert.equal(second.status, 0);
  assert.match(second.stdout, /unchanged/g, "idempotent: second run changes nothing [33]");
  const wfAfter = fs.readFileSync(path.join(repo, ".github", "workflows", "burn-usage.yml"), "utf8");
  run();
  assert.equal(fs.readFileSync(path.join(repo, ".github", "workflows", "burn-usage.yml"), "utf8"), wfAfter, "third run too");

  // a foreign file at the same path is KEPT, never clobbered
  fs.writeFileSync(path.join(repo, "team", "usage", "README.md"), "mine\n");
  const third = run();
  assert.equal(third.status, 0);
  assert.equal(fs.readFileSync(path.join(repo, "team", "usage", "README.md"), "utf8"), "mine\n", "unmarked files are never overwritten [33]");

  // refuses to scaffold outside a git repo, writes nothing
  const loose = fs.mkdtempSync(path.join(os.tmpdir(), "burn-noteam-"));
  const bad = spawnSync(process.execPath, [fileURLToPath(new URL("../src/cli.js", import.meta.url)), "init", "--team"], { cwd: loose, encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.deepEqual(fs.readdirSync(loose), [], "a refused init touches nothing [33]");
});

test("M13 acceptance: identical fixtures + identical tables ⇒ identical totals (1e-9) + shared pricingHash, across machines", () => {
  // two independent "machines" — different deviceIds, identical data + table
  const boxA = histFixture();
  const boxB = histFixture();
  fs.writeFileSync(boxB.env.BURN_ID_FILE, "machine-hist-02\n");
  const a = JSON.parse(spawnCli(["export", "--ulp"], boxA.env).stdout.toString());
  const b = JSON.parse(spawnCli(["export", "--ulp"], boxB.env).stdout.toString());
  assert.equal(a.pricingHash, b.pricingHash, "same effective table ⇒ same 12-hex anchor [30]");
  assert.equal(a.totals.events, b.totals.events);
  assert.ok(Math.abs(a.totals.cost - b.totals.cost) < 1e-9, "identical fixtures + tables ⇒ identical dollars [M13]");
  assert.deepEqual(a.sources, b.sources);

  // a THIRD box ingests both bundles: union across devices, idempotent re-merge
  const ing = fs.mkdtempSync(path.join(os.tmpdir(), "burn-m13m-"));
  const src = path.join(boxA.root, "twobundles");
  fs.mkdirSync(src);
  writeBundle(src, "a.ulp.json", a);
  writeBundle(src, "b.ulp.json", b);
  const boxC = { ...boxA.env, BURN_INGEST_DIR: ing, BURN_CLAUDE_DIR: path.join(boxA.root, "nodata"), BURN_OPENCODE_DB: "/nonexistent.db" };
  assert.equal(spawnCli(["--json"], boxC).status, 1, "box C starts as an honest empty machine");
  assert.equal(spawnCli(["ingest", src], boxC).status, 0);
  const mergedC = JSON.parse(spawnCli(["--json"], boxC).stdout.toString());
  assert.equal(mergedC.totals.events, 2 * a.totals.events, "two devices' copies of the same work both count — they are separate records [M13]");
  assert.ok(Math.abs(mergedC.totals.cost - 2 * a.totals.cost) < 1e-9, "…and recompute-not-sum gets it right");
  assert.deepEqual(mergedC.deviceIds, ["machine-hist-01", "machine-hist-02"]);
  assert.equal(spawnCli(["ingest", src], boxC).status, 0);
  const againC = JSON.parse(spawnCli(["--json"], boxC).stdout.toString());
  assert.equal(againC.totals.events, mergedC.totals.events, "re-ingesting both bundles changes nothing (content-addressed + union)");
});
