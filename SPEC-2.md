# burn — Specification v2: The Work-Cost Ledger (draft)

v1 answered **"where did my AI budget go?"** (repo · model · day).
v2 answers the questions that actually gate adoption of agents at scale:

- **"What did FEATURE X cost?"** — dollars attributed to git branches, commits, PRs.
- **"What is this going to cost me next month?"** — trend + drift, honest counterfactuals.
- **"Who on my team spent what, and can I trust the number?"** — mergeable ledger bundles, no cloud.
- **"Am I wasting money structurally?"** — deterministic, explainable advice (doctor).

Vision ladder:
```
v1  local read-only ledger, provenance-classified dollars        ← shipped
v2  work-unit attribution (git), budgets/gates, doctor, merge    ← this spec
v3  the open Usage Ledger Protocol: any agent, any dashboard     ← SPEC-3-5.md
```

Non-negotiable v1 carry-forwards (all still binding): **no network, no writes to
agent data, no invented prices, zero runtime dependencies, honest provenance on
every dollar.**

Key words MUST/MUST NOT/SHOULD per RFC 2119. Sections marked (L1) build on
SPEC v1.0 without changing it; v2's ledger output is **additive-only** — every
v1 consumer keeps working.

---

## A. The agent matrix (§5 extractors, widened)

### A.1 Sources in scope for v2

| id              | store (best-known)                         | cost class available | milestone |
|-----------------|--------------------------------------------|----------------------|-----------|
| claude-code     | `~/.claude/projects/**/*.jsonl`            | estimated + git join | M1 (shipped) |
| opencode        | `~/.local/share/opencode/opencode.db`      | billed (L1)          | (shipped) |
| codex           | `~/.codex/sessions/**` (rollout JSONL)     | estimated (no $ stored) | M2 (shipped) |
| gemini-cli      | `~/.gemini/tmp/**/chats/*.jsonl`           | estimated (no $ stored) | M2 (shipped) |
| openclaw        | `~/.openclaw/**/openclaw-agent.sqlite`     | billed/estimated     | M2 — HELD (see note) |
| cursor-agent    | CLI session logs (path TBD at impl time)   | estimated            | M3 |

Discovery rule: an extractor MUST locate its store from documented defaults +
`BURN_<AGENT>_DIR/DB` overrides, and MUST report the resolved path in
`burn sources`. A source whose on-disk format is not yet verified MUST NOT ship
claiming support — the matrix above is the plan, `--json` `supportedAgents[]` is
the truth.

**Verification bar (H15).** "Verified" means the record layout, the usage/token
field names, and the store path have been confirmed against the upstream agent's
own source or docs at line level, AND the extractor is exercised on a fixture
that mirrors that schema byte-for-byte. `available()` MUST return false when the
store is absent, so a machine without the data reports the source as not-found
with zero events — never a guessed number.

**OpenClaw hold.** Codex and Gemini ship under this bar. OpenClaw does NOT: its
live store is a per-agent SQLite DB whose exact table/column names are not yet
confirmed, and `~/.openclaw` is absent on the reference machine. Rather than
invent a schema, the OpenClaw extractor stays unregistered — `supportedAgents[]`
omits it, and `burn sources` would show it as a roadmap entry only. This is the
H15 rule protecting the project's honesty, applied to ourselves.

### A.2 `burn sources` (new command)
Prints each discovered source: id, resolved path, event count, oldest/newest
date, cost class. Doubles as the doctor for "why is my number small."

---

## B. Work attribution — the heart of v2

### B.1 Concepts

```
WorkUnit  the unit of work usage is charged to. Resolution order per session:
            1. explicit:  burn attribute <session> --unit <name>  (user truth)
            2. git:       branch at session time (from transcript or `git` join)
            3. repo:      §2.2 label (v1 fallback, always succeeds)
Ref       { kind: "branch"|"commit-range"|"pr", repo, branch?, base?, head?, number? }
```

### B.2 Git join (read-only; Claude transcripts already carry `gitBranch` + `cwd`)

- Extractors already emit `dir`; v2 additionally captures `gitBranch` when the
  source records it (Claude user-lines do). No git execution needed for that class.
- Where the source is silent, the enricher MAY run, strictly read-only:
  `git -C <dir> log --format=%H%x09%ad --date=iso -n 500` to map event timestamps
  to the commit that was HEAD in the window. It MUST NOT lock, fetch, GC, or
  write anything, and MUST skip non-repos and unreadable repos silently.
- Every attributed dollar keeps its v1 cost class **and** gains an attribution
  confidence: `native` (source recorded the branch) > `joined` (timestamp↔git
  map) > `guess` (repo-only) > `unattributed`.

### B.3 `burn work` and `burn blame <ref>` (new commands)

```
burn work                       # cost per WorkUnit, cost class split, confidence
burn work --since 2026-09-01
burn blame feature/payments     # all spend whose Ref matches a branch/PR name
burn blame HEAD~20..HEAD        # commit-range version
```

Normative: `burn blame` MUST NOT ever print a path outside the repo basename
(v1 §9 survives); totals MUST reconcile — the sum of WorkUnit costs equals
`totals.cost` when all events are attributed, with a visible
`unattributed` bucket for the residue (never silently dropped).

### B.4 PR cost badge (export, not a service)

`burn blame --json` is the payload; a shipped example GitHub Action posts it as
a comment on PRs. burn itself performs no network I/O — the user's CI does that.

---

## C. Forward-looking money (still never invented)

### C.1 `burn forecast`
Day-level totals (v1 §3.1) through linear + last-7d-mean on **priced events
only**; unpriced events appear as a separate "tokens, unpriced" line, never
converted to speculative dollars. Output: per-repo and total 7/30-day
projections, labeled `est-forecast`, with the sample window size printed.

### C.2 `burn counterfactual --route <model>`
"Your spend as it happened: $X (billed/estimated mix shown). Replay at
`<model>` list price: $Y." Pure arithmetic over recorded tokens × pricing
table (v1 §3 formula), displayed with both numbers and an explicit
`estimate-of-estimate` label. MUST NOT claim savings on free/unpriced models
(the honest answer there is `—`).

### C.3 `burn budget` (gate semantics)
```
burn budget --repo <label> --max <usd> [--period day|week|month|all] [--json]
```
Period defaults to `month` (calendar month, UTC, from `YYYY-MM-01`); `all`
counts the whole ledger.
Exit codes extend v1: `0` under budget · `1` no data · `2` error ·
**`3` over budget** (the only new code; chosen so CI can treat 3 as a
policy failure, not a crash). Checks the ledger; enforces nothing — the
enforcement partner is [AgentVault](https://github.com/aashish254/agentvault)
consuming this exit code. Spec says loudly: **burn measures, AgentVault gates.**

---

## D. `burn doctor` — deterministic, explainable advice

Rules over v1 metrics only; **no LLM, no vibes**. Each finding:
`{ rule, severity, scope, observation, suggested, estImpactClass }` with
`estImpactClass ∈ {billed, estimated, none}` — advice that can't carry a
number carries none.

Shipped rules at v2:
- **R-1 cache-starved**: repo has avg prompt > 50k tokens but cacheHit < 10%
  over ≥ 20 events → "structure stable prefixes (system prompt, file context)
  first; Anthropic caching bills reads at ~0.1× input."
- **R-2 model overspend**: ≥ 60% of a repo's estimated dollars on an opus-tier
  family while median output < 400 tokens → show `burn counterfactual` delta.
- **R-3 silent migration**: a model id's share changes > 2× week-over-week →
  "did your router change?" (trend only, no advice attached).
- **R-4 unpriced drift**: unpriced token share > 25% of all tokens → "teach
  burn these models or your ledger is blind: <top 3 ids>."

`burn doctor --json` emits findings array; exit code stays 0 (advisory).

---

## E. Teams without a backend: mergeable ledgers

### E.1 Bundle exchange
`burn export [--since] [--only-repo X] -o person.burn.json` writes the §6
document plus `{ deviceId, hostnameHash, specVersion:"2.0" }`.
- `deviceId`: random uuid persisted at `~/.burn/id` — never derived from name/email.
- `hostnameHash`: SHA-256 of hostname truncated to 8 hex — display only.

### E.2 Merge semantics (normative, order-independent)
`burn merge a.burn.json b.burn.json …` produces one ledger:
- Event identity = `(deviceId, agent, sessionId, index-within-session)` — sets
  are **unioned**; identical inputs are idempotent.
- Buckets (§3.1) recomputed from the merged event set; merge NEVER sums
  pre-aggregated bucket numbers (two machines' `repos[0]` are not one row).
- v2 documents MAY carry `events[]` raw (needed for merge fidelity); `--compact`
  drops them for report-only transport. Bundle size target < 1% of the source
  transcripts' size when compacted.
- Conflicts cannot exist by construction (union semantics); duplicate deviceIds
  from copied `~/.burn/id` are reported by `burn merge --audit`.

Distribution story: commit compact bundles to your repo (`team/usage/`) or drop
them in any file share — git *is* the sync protocol; there is no server.

### E.3 `burn team` view
Merged input → per-human (deviceId hash) totals, per-repo totals, per-agent
matrix. No names unless the operator supplies a `~/.burn/roster.json` mapping
deviceId → display label (kept local; nothing leaves).

---

## F. Ledger format v2 (ULP candidate)

`specVersion: "2.0"`, fully additive over v1 §6:

```
+ deviceId?, hostnameHash?
+ supportedAgents[]: { id, storePath?, status: "ready"|"planned" }
+ events[]?: normalized v1 UsageEvents + { gitBranch?, attribution:
    { kind, ref, confidence } }       // present in bundles, absent from --json by default
+ workUnits[]: WorkUnit rows (§3.1 shape + confidence + unattributed flag)
+ forecast?/counterfactual?/doctor?   // only for their respective commands
```

Stability rules from v1 §11 unchanged (additive → minor; semantic change →
major bump; consumers ignore unknown fields). The `events[]` field and merge
semantics make this a **protocol**, not just output — that is the v3 play:
publish as "Usage Ledger Protocol" once a second implementation exists
(conformance suite is already the seed for that). **Drafted standalone in
[ulp/SPEC.md](ulp/SPEC.md).**

## G. CLI & exit-code surface (v2 delta)

new commands: `sources work blame doctor forecast counterfactual budget export merge team watch`
new flags: `--unit` (attribute), `--confidence native|joined|guess` (filter),
`--audit` (merge). Exit codes: v1's 0/1/2 plus **3 = budget exceeded**.
`watch` = tail newest session files, print per-turn cost lines as they land
(pure fs polling, no daemons; MUST NOT open the SQLite hot-loop — it re-queries
session rows on an interval instead).

## H. Testing & conformance (v2 additions to §10)

10. Attribution correctness on fixture repos (native branch, timestamp join,
    repo fallback, non-repo → unattributed).
11. Reconciliation invariant: `Σ workUnits.cost == totals.cost` incl. the
    unattributed row; property-tested across fixtures.
12. Merge: union, idempotence, order-independence, recompute-not-sum (assert
    merged buckets ≠ elementwise sums when deviceIds overlap repos).
13. Budget exit codes 0 vs 3; forecast excludes unpriced from dollar claims;
    counterfactual prints `—` for unpriced models.
14. Doctor R-1..R-4 fire on crafted fixtures and stay silent on healthy ones.
15. `supportedAgents` truthfulness: every "ready" entry must have a passing
    real-format fixture test; nothing ships claiming an unparsed format.

## I. Milestones & acceptance

- **M1 (core of v2)**: attribution engine + `work`/`blame` on existing two
  sources; reconciliation invariant test; README v2. ✦ Accept: `burn blame
  HEAD~20..HEAD` on a real repo prints dollars with confidence labels.
- **M2**: codex + gemini-cli + openclaw extracters against **verified on-disk
  formats**; `sources`; budget + watch. ✦ Accept: matrix ≥ 5 agents with real
  fixtures; SPEC conformance suite extended.
- **M3**: doctor (R1–R4), forecast, counterfactual. ✦ Accept: each rule has
  fire + no-fire tests; forecast math is pure and snapshot-tested.
- **M4**: bundles + merge + team; PR-badge example action; publish ledger
  format as standalone spec doc (ULP draft). ✦ Accept: two humans' ledgers
  merge correctly from committed files only; zero network in core re-verified.

## J. Explicit non-goals (v2)

Cloud sync, accounts, telemetry, dashboards-as-a-service, enforcement (that's
AgentVault's job), LLM-generated advice, price authority (table stays
user-owned), session content indexing (tokens & counters only — privacy §9 of
v1 still bars paths/names/content from output).
