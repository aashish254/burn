# 🔥 burn

[![CI](https://github.com/aashish254/burn/actions/workflows/test.yml/badge.svg)](https://github.com/aashish254/burn/actions/workflows/test.yml)
![node](https://img.shields.io/badge/node-%E2%89%A522.5-brightgreen)
![deps](https://img.shields.io/badge/dependencies-0-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)
![protocol](https://img.shields.io/badge/ULP-1.0-blueviolet)

**Where did your AI budget actually go — and what did each feature cost?**

`burn` is a local, zero-dependency ledger that reads the transcripts your coding
agents already leave on disk. It answers per **repo**, per **model**, per **day**,
per **git branch**: how many tokens you spent, how many dollars that cost, and how
much prompt caching saved you. No network. No account. No telemetry. Nothing
leaves your machine.

The behavior below is governed by written contracts — **[SPEC.md](SPEC.md)** (v1:
usage-event model, cost provenance, JSON schema, exit codes) and
**[SPEC-2.md](SPEC-2.md)** (v2: work attribution, gates, doctor, mergeable
bundles) and **[SPEC-3-5.md](SPEC-3-5.md)** (v3–v5: the open protocol, history,
plan gates). The ledger format itself is a standalone protocol: ULP, in
**[ulp/](ulp/README.md)** — burn is its reference implementation #1.
Dashboards and CI can build on the specs, not on this CLI.

```
$ burn

🔥 burn  local AI usage ledger
  sources: claude-code, opencode · 118 usage events · 13 priced models

$40.08 spent   18.28M tokens   cache 50% of 38.85M prompt tokens reused
────────────────────────────────────────────────────────────────
  28 billed · 90 estimated cost events

By repository
────────────────────────────────────────────────────────────────
acme/analytics           ████████████████████████ $40.08     225k tok   cache 84%
acme/api                 ························ $0.00      222k tok   cache 95%
pet-habit                ························ $0.00      15.88M tok cache 0%

$ burn work          # v2: dollars per work unit

By work unit  (SPEC-2 §B: explicit > branch > repo fallback)
────────────────────────────────────────────────────────────
main                 [branch]   native      ████████████████████████ $40.08     105k tok
acme/api             [repo]     guess       ························ $0.00      222k tok
```

## Why

Every coding agent quietly writes down exactly what it did — Claude Code drops a
JSONL transcript per session with a full `usage` block and its git branch;
OpenCode keeps a SQLite db with real billed `cost`; Codex and Gemini CLI record
their own token histories. That data has been sitting on your laptop this whole
time. Nobody adds it up **across agents**, and nobody can tell you what
`feature/payments-refactor` actually cost.

`burn` answers the questions that gate agent adoption at scale:

- Which repo is eating my spend? Which **feature/branch/PR**?
- Am I paying opus prices for 100-token answers? (`burn doctor`)
- What will this pace cost me next month? (`burn forecast`)
- Is this PR over budget *before* it merges? (`burn budget` → exit 3)
- What does my **team** spend, with no backend? (`burn export | merge | team`)

## Install

It's a dependency-free Node CLI (Node ≥ 22.5, for the built-in `node:sqlite`).
The npm package is `burn-usage`; the command you type is `burn`.

```bash
npm i -g burn-usage        # → provides the `burn` command
# or run from source:
git clone https://github.com/aashish254/burn && cd burn && npm link
```

## How cost is computed (and why we never lie)

`burn` distinguishes **three** kinds of dollar figures and labels its totals with
the mix, so you always know what's real:

| label | meaning | source |
|-------|---------|--------|
| **billed** | the agent recorded the actual charge | OpenCode `session.cost` |
| **estimated** | computed from a pricing **table you control** | tokens × `~/.burn/pricing.json` |
| **unpriced** | tokens counted, dollars **withheld** because the model has no known price | anything not in the table |

If `burn` doesn't know a model's price, it shows tokens and reports `—` for cost.
**It will never fabricate a dollar figure.** The same rule governs v2: forecasts
project only priced events, counterfactuals print `—` for unpriced routes, and the
`supportedAgents` list only contains formats verified against upstream source —
nothing ships claiming an agent it can't truly parse.

```json
// ~/.burn/pricing.json  (USD per 1M tokens)
{ "my-router/llama-4": { "input": 0.2, "output": 0.8, "cacheWrite": 0.2, "cacheRead": 0.05 } }
```

## Commands

```
burn                     overall summary + all breakdowns
burn repos / models / agents / daily / sessions
burn work                cost per work unit: branch ▸ commit-adjacent ▸ repo
burn blame feature/pay   what one branch cost (native attribution)
burn blame v1..HEAD      what a commit range cost (read-only git join)
burn attribute S1 --unit my-epic     charge a session to a named unit
burn sources             which agents were found, where, and with how much data
burn budget --repo app --max 25 [--period day|week|month|all]   exit 3 = over
burn forecast [--window 30]          trend + last-7d-mean, priced events only
burn counterfactual --route claude-haiku-4-5                    estimate-of-estimate
burn doctor              deterministic advice, rules R-1..R-6 (advisory, exit 0)
burn watch               live per-turn cost stream as agents write transcripts
burn export -o me.burn.json          shareable bundle (mergeable, path-scrubbed)
burn export --ulp                    pure ULP 1.0 core document (schema-validated)
burn merge a.json b.json [--audit]   union across machines, recompute-not-sum
burn team a.json b.json              per-human totals (roster.json optional)
burn ingest their.ulp.json [--strict]  accept any conformant ULP ledger (v3)
burn ingest dir/                       …or a whole folder of them
burn ingest --list                   what's stored and what each bundle gave
burn conformance                     run the ULP kit (pure JSON vectors; exit 0/2)
burn snapshot                        append today's ledger to ~/.burn/history (v4)
burn history ls / history drop F --yes   inspect; delete (only destructive cmd)
burn report [--month 2026-09] [-o sept.md]  markdown digest, safe to commit
burn plan --repo app --budget 50 --months 2  forecast gate: 0 afford / 3 can't
burn attest --month 2026-09          finance one-pager: method, NOT an invoice
burn init --team                     team/usage/ + CI scaffold (git-push-only network)
burn export --otel -o x.otlp.json    OTLP/JSON to a FILE (offline transform)
burn ingest --otel x.otlp.json       OTLP/JSON back in — lossless-or-loud
burn --history / --no-history        fold local snapshots in (default ON for
                                     report, budget month|all, forecast)
burn --since 2026-09-01              only count usage on/after a date
burn --json                          machine-readable (SPEC-2 §F, additive over v1)
```

Exit codes ([SPEC.md](SPEC.md) §7 + [SPEC-2.md](SPEC-2.md) §G): `0` report ·
`1` no supported agent data (stderr hint, stdout silent) · `2` error ·
`3` **over budget** — so CI can tell "policy failure" from "tool crash".
`burn` checks budgets and enforces nothing: **burn measures,
[AgentVault](https://github.com/aashish254/agentvault) gates.**

## Supported agents

| agent | store | cost available | status |
|-------|-------|----------------|--------|
| **Claude Code** | `~/.claude/projects/**/*.jsonl` | estimated + git branch | shipped |
| **OpenCode** | `~/.local/share/opencode/opencode.db` | billed (`session.cost`) | shipped |
| **Codex CLI** | `~/.codex/sessions/**/rollout-*.jsonl` | estimated; branch from `session_meta` | shipped |
| **Gemini CLI** | `~/.gemini/tmp/*/chats/*.jsonl` | estimated; repo from workspace dirs | shipped |
| OpenClaw | per-agent SQLite (schema unconfirmed) | billed per message | **held** — we won't guess a format (SPEC-2 §A) |
| Cursor agent | path TBD | — | planned |

An extractor is one file exporting `label`, `rootPath()`, `available()` and
`extract()` yielding normalized events — see `src/extractors/claude.js`. Run
`burn sources` to see exactly which paths were probed on your machine.

## Teams with zero backend

```bash
# each human:
burn export -o team/usage/ash.json        # git commit it — git IS the sync protocol
# anyone, anywhere:
burn merge team/usage/*.json              # one ledger, deduped by (device, session, index)
burn merge --audit team/usage/*.json      # catches copied ~/.burn/id collisions
burn team  team/usage/*.json              # per-human totals
```

Bundles carry no absolute paths and no hostnames (device ids are random uuids;
hostnames ship as 8-hex hashes). Names appear only from a local `roster.json`.

## Privacy

`burn` opens files under your home directory and prints a summary. It makes **no
network requests** and stores nothing beyond what you explicitly export. Every
dollar is either read from your own agent's records or computed from a pricing
table you wrote. Repo labels are basenames only; exported events are path-scrubbed.

## How this differs from the neighbours

- **vs. `ccusage`** — great, but Claude-only (and Codex-only forks exist). `burn`
  is **cross-agent**, adds the cache-economics view, and separates billed vs.
  estimated dollars so the number is honest.
- **vs. gateways (LiteLLM / OpenRouter / Portkey)** — those meter only traffic that
  *routes through them*. Your native agents bypass them entirely. `burn` meters
  what already happened, with no proxy and no config change.
- **vs. session-migrate** — that moves a session *between* agents. `burn` reads all
  their logs to report *spend*. Different axis; they compose.
- **vs. AgentVault** — AgentVault is the firehose gate for agent traffic; `burn`
  is the measurement layer. `burn budget`'s exit 3 is the seam between them.

## Development

```bash
npm test             # 67 tests implementing every SPEC/SPEC-2 conformance vector
                     # (§10 V1–V9, H10–H15): pricing math, provenance classes,
                     # attribution ladder, reconciliation invariant, read-only git
                     # joiner, budget exit 3, merge idempotence/recompute-not-sum,
                     # bundle privacy, doctor fire/no-fire fixtures, snapshot-tested
                     # forecast math, spawned-CLI JSON shape, NO_COLOR, exit codes —
                     # plus v3/v4: ULP schema + negotiation, pure exports, ingest
                     # integrity, the conformance kit green in TWO languages (Node +
                     # stdlib Python), snapshot/history tie-breaks, plan gates, the
                     # 400-snapshot perf budget, R-5/R-6 fire/no-fire.
                     # Zero dependencies, zero Node warnings.
```

## Roadmap

**v2 is shipped** (work attribution, budgets, doctor, mergeable bundles — see
[SPEC-2.md](SPEC-2.md) and [TODO-2.md](TODO-2.md)). **v3 and v4 are shipped**
(the protocol, ingest, conformance; snapshots/history, report, plan, R-5/R-6 —
see [SPEC-3-5.md](SPEC-3-5.md) and [TODO-3-5.md](TODO-3-5.md)).

The remaining legs, specified in [SPEC-3-5.md](SPEC-3-5.md):

- **v3 — the protocol left burn. ✔** [ulp/SPEC.md](ulp/SPEC.md) is
  machine-checkable (JSON Schema + hand-rolled validator), `burn ingest`
  accepts any conformant bundle, the conformance kit ships as pure JSON
  vectors, and a second implementation (stdlib-only Python reader) proves the
  format isn't burn-specific.
- **v4 — the ledger outlives the transcripts. ✔** Snapshots are just bundles
  merged by the existing union semantics, so history can't double-count;
  `burn report`, `burn plan` (budget gates on forecasts), and doctor R-5/R-6.
- **v5 — the industry seam. ✔ (except the repo cut)** ULP has a self-contained
  home (`ulp/`: spec, schema, conformance kit, RFC process, changelog) and is
  ready to move to its own repo — the git split itself waits on its owner.
  OpenTelemetry GenAI mapping ships with offline `--otel` file transforms
  (lossless-or-loud, semconv pinned), `pricingHash` makes every estimate
  reproducible without trusting the table owner, `burn attest` writes the
  finance one-pager, and `burn init --team` scaffolds serverless team sync
  whose only network step is `git push`. Burn deliberately got *smaller* —
  the sign the standard worked.

The fence around it all: if a feature needs a server or a socket in core, it
does not ship. burn measures; your stack decides.
