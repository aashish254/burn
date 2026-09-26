#!/usr/bin/env node
// burn benchmark — synthetic transcripts, real pipeline.
//
//   node scripts/bench.mjs            # default sizes: 10k and 100k events
//   node scripts/bench.mjs 250000     # custom
//
// Generates Claude-Code-shaped JSONL under a temp dir, then times the exact
// paths the CLI takes: extraction, pricing, aggregation, and a full spawned
// `burn --json` end-to-end run. Prints a markdown-ready table.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import * as claude from "../src/extractors/claude.js";
import * as opencode from "../src/extractors/opencode.js";

const CLI = path.join(fileURLToPath(import.meta.url), "..", "..", "src", "cli.js");
const SIZES = process.argv.slice(2).map(Number).filter(Number.isFinite);
const RUNS = SIZES.length ? SIZES : [10_000, 100_000];

const MODELS = ["claude-sonnet-4", "claude-opus-4", "claude-haiku-4-5"];
const REPOS = ["analytics", "api", "docs", "platform", "mobile"];
const BRANCHES = ["main", "feat/payments", "fix/cache", null];

function generate(root, events) {
  const perSession = 50;
  const sessions = Math.ceil(events / perSession);
  let written = 0;
  for (let s = 0; s < sessions; s++) {
    const repo = REPOS[s % REPOS.length];
    const proj = path.join(root, `-bench--${repo}`);
    fs.mkdirSync(proj, { recursive: true });
    const lines = [];
    const n = Math.min(perSession, events - written);
    for (let i = 0; i < n; i++) {
      const day = 1 + ((s + i) % 26);
      lines.push(JSON.stringify({
        type: "assistant",
        sessionId: `bench-${s}`,
        timestamp: `2026-09-${String(day).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00.000Z`,
        cwd: `/bench/${repo}`,
        gitBranch: BRANCHES[(s + i) % BRANCHES.length],
        message: {
          model: MODELS[(s + i) % MODELS.length],
          usage: {
            input_tokens: 2_000 + ((s * 31 + i * 7) % 40_000),
            output_tokens: 200 + ((s * 13 + i * 3) % 6_000),
            cache_read_input_tokens: ((s + i) % 3) * 12_000,
            cache_creation_input_tokens: ((s + i) % 2) * 3_000,
          },
        },
      }));
    }
    fs.writeFileSync(path.join(proj, `bench-${s}.jsonl`), lines.join("\n"));
    written += n;
  }
  return sessions;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const rows = [];
for (const events of RUNS) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "burn-bench-"));
  fs.mkdirSync(path.join(root, "projects"));
  const croot = path.join(root, "projects");
  const t0 = performance.now();
  const sessions = generate(croot, events);
  const genMs = performance.now() - t0;

  const env = {
    ...process.env,
    BURN_CLAUDE_DIR: croot,
    BURN_OPENCODE_DB: path.join(root, "none.db"),
    BURN_CODEX_DIR: path.join(root, "none-codex"),
    BURN_GEMINI_DIR: path.join(root, "none-gemini"),
    BURN_INGEST_DIR: path.join(root, "none-ingest"),
    BURN_HISTORY_DIR: path.join(root, "none-history"),
    BURN_ID_FILE: path.join(root, "id"),
    BURN_QUIET: "1",
  };

  // spawned end-to-end, 3 runs (median)
  const walls = [];
  let outEvents = 0;
  for (let r = 0; r < 3; r++) {
    const t = performance.now();
    const res = spawnSync(process.execPath, [CLI, "--json"], { env, maxBuffer: 512 * 1024 * 1024 });
    walls.push(performance.now() - t);
    if (res.status !== 0) { console.error(res.stderr.toString()); process.exit(1); }
    outEvents = JSON.parse(res.stdout.toString()).totals.events;
  }

  // in-process extract-only timing (one run)
  process.env.BURN_CLAUDE_DIR = croot;
  process.env.BURN_OPENCODE_DB = env.BURN_OPENCODE_DB;
  const tp = performance.now();
  let evCount = 0;
  for (const _ of claude.extract()) evCount++;
  const tExtract = performance.now() - tp;
  if (evCount !== events) {
    console.error(`MISMATCH: generated ${events}, extractor yields ${evCount}`);
    process.exit(1);
  }
  delete process.env.BURN_CLAUDE_DIR;

  if (outEvents !== events) {
    console.error(`MISMATCH: generated ${events}, ledger reports ${outEvents}`);
    process.exit(1);
  }
  const e2e = median(walls);
  rows.push({
    events, sessions, e2e, extract: tExtract,
    perSec: Math.round(events / (e2e / 1000)),
  });
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("\n| events | sessions | extract | end-to-end (median of 3) | events/sec |");
console.log("|-------:|---------:|--------:|-------------------------:|-----------:|");
for (const r of rows) {
  console.log(`| ${r.events.toLocaleString()} | ${r.sessions} | ${r.extract.toFixed(0)} ms | ${r.e2e.toFixed(0)} ms | ${r.perSec.toLocaleString()} |`);
}
console.log(`\nnode ${process.version} · ${os.cpus()[0].model.trim()} · ${os.platform()} ${os.arch()}`);
console.log("end-to-end = spawned `burn --json`: read transcripts, price, aggregate, serialize.");
