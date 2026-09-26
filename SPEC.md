# burn Usage Ledger — Specification v1.0 (draft)

> v2 — work attribution, budgets, doctor, mergeable ledgers — shipped; see
> [SPEC-2.md](SPEC-2.md). v3–v5 (ULP 1.0, durable history, OpenTelemetry seam)
> are drafted in [SPEC-3-5.md](SPEC-3-5.md). This document remains the binding
> base; all later output is additive-only over it.

The normative contract for `burn`: how agent usage is modeled, how dollars are
resolved, what the JSON output guarantees, and what an extractor must do to
claim conformance. The goal is that any tool (dashboards, CI budget gates,
other CLIs) can safely parse a burn ledger, and any agent can be added without
changing semantics.

Key words MUST, MUST NOT, SHOULD, MAY are used as described in RFC 2119.

---

## 1. Goals and non-goals

**Goals**
- G1. Answer "where did my AI spend go?" per repository, model, agent, and day,
  from data already on the local machine.
- G2. Every dollar figure carries a **provenance class** (billed / estimated /
  unpriced). A consumer MUST be able to tell recorded truth from arithmetic.
- G3. Zero network, zero dependencies beyond the Node runtime, zero writes to
  any agent's own data.
- G4. A conformance path for new agents: one extractor file, no spec changes.

**Non-goals**
- N1. Price authority. Estimated dollars are arithmetic over a user-owned
  pricing table, not a billing statement.
- N2. Enforcement. Budget gates are downstream consumers of this spec, not
  part of it.
- N3. Session migration, memory, or tracing. Different axes, different tools.

---

## 2. Core data model

### 2.1 UsageEvent

The atomic unit emitted by extractors. One event = one billable interaction as
recorded by the source agent (a model turn, or an agent-billed session when the
source only exposes aggregates — see §5).

```
UsageEvent {
  agent       string        source id, kebab-case ("claude-code", "opencode")
  sessionId   string        source-native session identifier
  model       string        model id as the source reported it; "unknown" if absent
  dir         string|null   working directory the agent ran in, if recorded
  repo        string        display label derived from dir (§2.2)
  date        string        "YYYY-MM-DD" in UTC, or "unknown"
  tokens {
    input       integer ≥ 0   fresh (uncached) prompt tokens
    output      integer ≥ 0   generated tokens (incl. reasoning, see below)
    cacheWrite  integer ≥ 0   tokens written INTO prompt cache
    cacheRead   integer ≥ 0   tokens served FROM prompt cache
    reasoning   integer ≥ 0   subset of output that was reasoning/thinking; MAY be 0 if the source does not split it
  }
  storedCost  number|null   USD billed as recorded BY THE SOURCE AGENT itself;
                            null when the source does not record dollars
}
```

Rules:
- `date` MUST be derived from the source timestamp in UTC.
- Events the source itself marks non-billable (e.g. Claude Code
  `<synthetic>` model turns) MUST be skipped.
- Where the source bills per aggregate rather than per turn (OpenCode
  sessions), one event per aggregate is conformant as long as tokens and
  `storedCost` describe the same scope.

### 2.2 Repo label

`repo` MUST be the basename of `dir` with trailing slashes removed. Absolute
paths and home prefixes MUST NOT appear in any output (§9 privacy). Collisions
between distinct directories sharing a basename are acceptable; the label is
for grouping, not identity. Identity grouping for sessions uses
`agent:sessionId`.

---

## 3. Cost provenance (the heart of the spec)

Every event resolves to exactly one class, evaluated **in order, first match
wins**:

| # | rule | class | JSON key |
|---|------|-------|----------|
| R1 | `storedCost` is a finite number | **billed** | `store` |
| R2 | model resolves a price via §4 | **estimated** | `estimate` |
| R3 | otherwise | **unpriced** | `unpriced` |

Normative consequences:

- A conformant implementation MUST NOT invent a price for an unresolvable
  model. Unpriced events contribute tokens and MUST contribute nothing to any
  `cost` field.
- `storedCost === 0` is **billed zero**, not missing data: a genuinely free
  tier is recorded truth and MUST take R1.
- Estimated cost is computed as, with all prices in USD per 1,000,000 tokens:

  ```
  cost = (input·p.input + output·p.output + cacheWrite·p.cacheWrite + cacheRead·p.cacheRead) / 1e6
  ```

  where `p.cacheWrite` defaults to `p.input` and `p.cacheRead` defaults to
  `p.input` when unspecified.

### 3.1 Derived metrics

For any bucket (totals, repo, model, agent, day, session):

```
promptTokens = input + cacheWrite + cacheRead
cacheHit     = promptTokens > 0 ? cacheRead / promptTokens : 0
shownTokens  = input + output          (the "tok" column; cache excluded by design)
cost         = Σ resolved costs of billed + estimated events
store        = Σ billed costs
estimate     = Σ estimated costs
```

`cacheHit` is reported as a percentage; it is the spec's answer to "what did
caching do for me", and is deliberately undefined on zero-prompt buckets (0).

---

## 4. Pricing table

- Location: `~/.burn/pricing.json`, overridable by `--pricing <path>`.
- Shape: flat object mapping model id → `{ input, output, cacheWrite?, cacheRead? }`
  in USD per 1M tokens.
- User entries are merged OVER built-in defaults (same key → user wins).
- Malformed overrides MUST be ignored (with stderr warning if cheap to detect),
  never abort the run.

**Model resolution order** (deterministic):
1. Exact key match.
2. Longest key K such that the requested id equals `K + suffix`, where
   `suffix` is empty or begins with `-<digit>` / `.<digit>` — i.e. **only
   version/date suffixes may be folded into a family price**
   (`"claude-opus-4-1"` resolves for `"claude-opus-4-1-20260901"`).
3. Otherwise no price → R3 unpriced.

Variant names MUST NOT inherit a sibling's price: `"gpt-5-micro"` has no
exact key and its remainder `"-micro"` is not a version suffix, so it is
unpriced — never billed at `"gpt-5"` rates. Likewise reverse prefixes (a
requested id that is a prefix of a table key, `"gpt-5"` → `"gpt-5-mini"`)
MUST NOT resolve. When in doubt, the answer is unpriced, not a guess.

Versioned snapshots of real-world prices are out of scope for v1; the built-in
defaults are a convenience sample that users are expected to audit.

---

## 5. Extractor contract

An extractor module MUST export:

```
label: string                      // §2.1 agent id
available(): boolean               // is the source present & readable NOW?
extract(): Iterable<UsageEvent>    // sync or async; must not mutate sources
```

Conformance requirements for sources:
- Files MUST be opened read-only. SQLite databases MUST be opened with a
  read-only flag where the runtime supports it.
- Individual malformed records (bad JSON lines, unreadable files) MUST be
  skipped, not fatal.
- Missing/locked/unreadable store → `available()` false or empty stream; the
  ledger MUST run with the remaining sources.
- Paths are overridable for testing and non-default installs:
  `BURN_CLAUDE_DIR`, `BURN_OPENCODE_DB` (one env per extractor, `BURN_<AGENT>_DB`-style
  for future agents).

---

## 6. Ledger document (`--json`)

`burn --json` prints one object to stdout, no other stdout bytes:

```
{
  specVersion    "1.0"
  generatedAt    ISO-8601 UTC
  totals         Bucket   (key "total", all events)
  cacheHit       number   (same as totals.cacheHit; top-level for convenience)
  totalTokens    integer  (totals.input + totals.output)
  sources        { store: int, estimate: int, unpriced: int }   // event COUNTS per class
  repos          Bucket[]  sorted cost DESC
  models         Bucket[]  sorted cost DESC
  agents         Bucket[]  sorted cost DESC
  days           Bucket[]  sorted key ASC ("unknown" sorts last)
  sessions       Session[] sorted cost DESC
}

Bucket {
  key string, events int, cost number, store number, estimate number,
  unpricedEvents int,
  tokens { input, output, cacheWrite, cacheRead, reasoning },
  cacheHit number
}

Session {
  agent, sessionId, model, repo, date,        // model/repo/date from FIRST event of the session
  cost number, tokens { …as Bucket… }, source "store"|"estimate"|"unpriced"  // source = first event's class
}
```

Compatibility:
- The shape is governed by this spec's version: **additive** field changes bump
  the minor; any rename, removal, or semantic change bumps `specVersion` major.
- Consumers MUST ignore unknown fields. `cost` fields are always numbers, never
  null — unpriced contributes 0 to cost and shows up in `unpricedEvents`/
  `sources.unpriced`.

---

## 7. CLI grammar and exit codes

```
burn [command] [options]
commands: summary (default) | repos | models | agents | daily | sessions
options:  --since <YYYY-MM-DD>   inclusive lower bound on date; "unknown"-dated events are EXCLUDED when --since is set
          --json                 §6 document on stdout
          --pricing <path>       override location for §4
          -h | --help, -v | --version
```

- Rendering caps: repos 15, models 12, agents 8, daily 40, sessions 15.
- Rows with zero cost AND zero non-cache tokens AND zero cache reads MAY be
  omitted (they are noise); rows with tokens but zero cost MUST be shown
  (free-but-huge is a real signal).
- stdout carries ONLY the report (or the JSON document). Diagnostics and the
  friendly no-data message go to stderr.

Exit codes:

| code | meaning |
|------|---------|
| 0 | report produced |
| 1 | no supported data found (human hint on stderr, nothing on stdout) |
| 2 | unexpected error |

---

## 8. Human-readable rendering

Not normative except where a consumer might scrape it:
- Bars scale to the maximum of the displayed set (so the top row is always
  full), rendered with `█` and `·`.
- USD format: `—` for null, `<$0.01` for `0 < v < 0.01`, 2 decimals under
  $1,000, comma-grouped whole dollars at or above.
- `NO_COLOR` MUST disable ANSI; output MUST be useful piped to a file.

---

## 9. Privacy and integrity requirements

- P1. No network I/O in the core, ever. Optional price-snapshot fetches (post-v1)
  MUST be explicit opt-in subcommands.
- P2. Source agent data is read-only (§5); the ledger stores nothing itself.
- P3. Absolute paths, home directories, and session content MUST NOT appear in
  any output; only §2.2 labels and counters.
- P4. Estimated dollars MUST remain labeled as estimates in both human output
  (provenance line) and JSON (§6 `sources`/`estimate`).

---

## 10. Conformance test vectors (minimum set)

A conformant implementation passes:
1. Synthetic/non-billable turns are skipped.
2. `storedCost = 0` → class `store` with cost 0, NOT unpriced.
3. Unknown Claude model → tokens counted, `sources.unpriced + 1`, cost 0.
4. Estimated dollars match the §3 formula exactly (to 1e-9).
5. Pricing override: user entry with same key replaces the built-in.
6. `cacheHit` follows §3.1 including the zero-prompt case.
7. `--json` on an empty machine: exit 1, stdout empty.
8. Repo label derivation incl. trailing-slash and home-root edge cases.
9. Malformed JSONL lines do not abort a session scan.

The shipped test-suite (`test/`) implements these vectors; CI runs Node LTS
matrix with no dependency install.

---

## 11. Versioning of this spec

- Spec changes follow the ledger document: additive → minor, breaking → major.
- Implementations SHOULD echo `specVersion` in output and reject nothing newer
  than they understand except for major mismatch (warn, ignore unknown).

Status: v1.0 draft, aligned with the v0.1 implementation. Open questions
tracked before stabilization: per-turn vs per-session event granularity when
sources offer both; whether `Session.model` should become the dominant model
rather than first-seen.
