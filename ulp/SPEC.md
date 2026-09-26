# Usage Ledger Protocol (ULP) — version 1.0 (ratified)

> Extracted from burn's [SPEC.md](../SPEC.md) (v1.0, the binding base) and
> [SPEC-2.md](../SPEC-2.md) §B/§E/§F, now ratified and living in its own home:
> **[github.com/aashish254/ulp](https://github.com/aashish254/ulp)** is the
> normative source; this copy is vendored inside burn so one checkout referees
> both. Normative
> schema in [schema-1.0.json](schema-1.0.json), the conformance kit in
> [conformance/README.md](conformance/README.md), governance in
> [rfc/README.md](rfc/README.md), and decisions in [CHANGELOG.md](CHANGELOG.md).
>
> Status: the 1.0 gate — "a second, independent implementation passes the
> conformance vectors" — is met: `burn` is reference implementation #1 and
> [reference/ulp-reader.py](reference/ulp-reader.py) is #2. Schema evolution
> stays additive-only under the §10 versioning rules; anything else is an RFC.

Key words MUST, MUST NOT, SHOULD, MAY are used as described in RFC 2119.

---

## 1. Scope and philosophy

A **usage ledger** is a JSON document that answers, from local transcript data:
how many tokens and how many dollars an AI coding agent consumed, grouped by
repository, model, agent, day, session, and unit of work.

Three inviolable principles, inherited from the base spec:

1. **Provenance over authority.** Every dollar carries a class — *billed* (the
   source agent recorded it), *estimated* (arithmetic over a user-owned pricing
   table), or *unpriced* (tokens counted, dollars withheld). A ledger consumer
   MUST always be able to tell recorded truth from arithmetic from nothing.
2. **Never invent.** A conformant producer MUST NOT emit a dollar figure it
   cannot trace to R1 or R2 (§3). An unknown price yields tokens, not a guess.
3. **Privacy by shape.** Ledgers carry counters, labels, and hashes — never
   absolute paths, home directories, hostnames, or session content (§7).

The protocol governs the **document and its semantics only**. How a producer
obtains events (transcript parsing, SQLite reads) is out of scope; §5 defines
what a source agent's data must be able to map onto.

---

## 2. UsageEvent — the atomic record

```
UsageEvent {
  agent       string        source id, kebab-case ("claude-code", "codex", …)
  sessionId   string        source-native session identifier
  model       string        model id as the source reported it; "unknown" if absent
  repo        string        display label = basename of the working directory,
                            trailing slashes removed; collisions acceptable —
                            it groups, it does not identify (§6 privacy)
  date        string        "YYYY-MM-DD" in UTC, or "unknown"
  tokens {
    input       integer ≥ 0   fresh (uncached) prompt tokens
    output      integer ≥ 0   generated tokens
    cacheWrite  integer ≥ 0   tokens written INTO prompt cache
    cacheRead   integer ≥ 0   tokens served FROM prompt cache
    reasoning   integer ≥ 0   subset of output that was reasoning/thinking;
                              MAY be 0 when the source does not split it
  }
  storedCost  number|null   USD billed as recorded BY THE SOURCE AGENT itself;
                            null when the source records no dollars
  cost        number        resolved USD for this event (§3); unpriced ⇒ 0
  costSource  "store" | "estimate" | "unpriced"
  gitBranch   string|null   branch when the source recorded it
}
```

Rules:
- One event = one billable interaction as recorded by the source (a model turn,
  or an agent-billed aggregate session when only totals exist).
- Tokens the source bills at *full* prompt count including cached tokens MUST be
  normalized so `input` is fresh-only — double-billing breaks every downstream
  price math.
- Events the source marks non-billable MUST be skipped.
- Session identity is the tuple `agent:sessionId`; `repo` is display-only.

## 3. Cost provenance

Evaluated in order, first match wins:

| # | condition | class | key |
|---|-----------|-------|-----|
| R1 | `storedCost` is a finite number (including 0) | billed | `store` |
| R2 | `model` resolves a price in the producer's pricing table | estimated | `estimate` |
| R3 | otherwise | unpriced | `unpriced` |

- `storedCost === 0` is **billed zero** (a genuine free tier), not missing data.
- Estimated cost, prices in USD per 1,000,000 tokens:

  ```
  cost = (input·p.input + output·p.output + cacheWrite·p.cacheWrite + cacheRead·p.cacheRead) / 1e6
  ```

  with `p.cacheWrite` and `p.cacheRead` defaulting to `p.input` when unspecified.
- Model resolution is deterministic: exact key, else the longest table key whose
  remainder is empty or a version suffix (`-20260901` / `.2`). Variant names
  (`gpt-5-micro`) MUST NOT inherit a family price; unpriced is always the
  fallback, never a guess.
- Pricing tables are producer-owned; the protocol takes no position on price
  truth, only on provenance labeling.

## 4. Derived metrics

For any bucket (totals, repo, model, agent, day, session, work unit):

```
promptTokens = input + cacheWrite + cacheRead
cacheHit     = promptTokens > 0 ? cacheRead / promptTokens : 0
shownTokens  = input + output                       (cache excluded by design)
cost         = Σ resolved costs of billed + estimated events
store        = Σ billed costs
estimate     = Σ estimated costs
```

`cacheHit` is the protocol's answer to "what did prompt caching do for me."

---

## 5. Ledger document

`specVersion: "2.0"` shape (1.x consumers remain valid: all v2 fields are additive):

```
LedgerDocument {
  specVersion    "1.0" | "2.0"
  generatedAt    ISO-8601 UTC
  totals         Bucket            (key "total", all events)
  cacheHit       number            (= totals.cacheHit, top-level convenience)
  totalTokens    integer           (totals.input + totals.output)
  sources        { store: int, estimate: int, unpriced: int }   // event COUNTS per class
  repos          Bucket[]  sorted cost DESC
  models         Bucket[]  sorted cost DESC
  agents         Bucket[]  sorted cost DESC
  days           Bucket[]  sorted key ASC ("unknown" last)
  sessions       Session[] sorted cost DESC

  // v2, additive:
  supportedAgents? [ { id, storePath?, status: "ready"|"planned" } ]
  workUnits?       Bucket[] + { unit: { kind, name, confidence }, unattributed: boolean }
  events?          UsageEvent[] + { attribution: { kind, ref, confidence } | null }
  deviceIds?       string[]        // present on merged ledgers
}

Bucket {
  key string, events int, cost number, store number, estimate number,
  unpricedEvents int,
  tokens { input, output, cacheWrite, cacheRead, reasoning },
  cacheHit number
}

Session {
  agent, sessionId, model, repo, date,          // model/repo/date from FIRST event
  cost number, tokens { …as Bucket… },
  source "store"|"estimate"|"unpriced"          // first event's class
}
```

Normative:
- `cost` fields are ALWAYS numbers, never null; unpriced events contribute 0
  and surface via `unpricedEvents` / `sources.unpriced`.
- A consumer MUST ignore unknown fields.
- Work attribution MUST reconcile: `Σ workUnits.cost === totals.cost`, with a
  visible `unattributed` bucket for the residue — never silently dropped.
- Attribution confidence ladder: `explicit` (user assertion) > `native` (source
  recorded the branch) > `joined` (timestamp↔git mapping) > `guess` (repo-only)
  > `unattributed`.
- `supportedAgents[].status === "ready"` asserts the producer actually parses
  that source's on-disk format; claiming "ready" for an unverified format is a
  conformance failure.

## 6. Bundle document and merge semantics

A **bundle** is a LedgerDocument plus producer identity, written for exchange:

```
Bundle = LedgerDocument {
  + deviceId      string   producer identity — a random uuid persisted by the
                           producer, never derived from a name or email
  + hostnameHash  string   SHA-256(hostname) truncated to 8 hex — display only
  + pricingHash   string|null  SHA-256 over the producer's EFFECTIVE pricing
                           table, canonicalized, truncated to 12 hex — makes
                           an estimate reproducible years later. MUST be null
                           (a stable marker, never "a hash of nothing") when
                           no pricing table priced any event in the ledger.
  + events[]      required for merge-capable bundles; each event's `dir` is
                   STRIPPED and `unit` is replaced by `attribution`
}
```

A **report-only** bundle (`--compact` in the reference implementation) MAY omit
`events[]`; such bundles MUST NOT be accepted as merge inputs.

`merge(bundles…) → LedgerDocument` is normative, order-independent:

1. **Event identity** = `(deviceId, agent, sessionId, index-within-session)`.
   The merged event set is the **union** of these identities. Conflicts cannot
   exist by construction; merging identical bundles is idempotent.
2. **Recompute, never sum.** All buckets (§4) are recomputed from the merged
   event set. Two machines' `repos[0]` rows are not one row; elementwise
   addition of pre-aggregated buckets is a conformance failure.
3. **Recorded cost travels with the event.** Merged events keep their recorded
   `cost`/`costSource`; a merge MUST NOT re-price another machine's events
   against this machine's pricing table (that would silently mutate history).
4. **Attribution re-resolves locally.** Bundled `attribution` is discarded on
   merge; work units re-resolve against the consuming machine's own explicit
   attributes, per §5's ladder.
5. **Duplicate deviceIds** (a copied identity file) make one human's
   identical-index events shadow another's; a conformant tool MUST offer an
   audit mode that detects and reports them.
6. Merged output lists every contributing `deviceId` (sorted).

Distribution is out of scope by design: committing bundles to a repository
(`team/usage/*.burn.json`) or any file share is sufficient. **Git is the sync
protocol; there is no server, and a conformant core MUST NOT require network
I/O.**

## 7. Privacy requirements

- P1. No network I/O in a conformant core. Optional fetches (price snapshots)
  are explicit opt-in side commands.
- P2. Source agent data is read read-only; a ledger tool MUST NOT write to or
  mutate transcripts/databases it reads.
- P3. Absolute paths, home directories, hostnames, and session content MUST NOT
  appear in ledgers, bundles, or rendered output. `repo` is basename-only;
  `hostnameHash` is the only machine-derived string allowed in bundles.
- P4. Estimated dollars MUST remain labeled as estimates in every rendering and
  in JSON (`sources`, per-bucket `estimate`).

## 8. Exit-code and gate contract

Tooling that reports a ledger (rather than only emitting documents) SHOULD use:

| code | meaning |
|------|---------|
| 0 | report produced (or gate passed) |
| 1 | no supported data found — stdout empty, human hint on stderr |
| 2 | error (tool or input problem) |
| 3 | policy failure (e.g. budget exceeded) — distinct from a crash on purpose |

The protocol measures; enforcement lives in the consumer of exit 3.

## 9. Conformance vectors (protocol seed)

A second implementation is conformant when it passes at least:

1. Provenance: `storedCost = 0` → `store` with cost 0, NOT unpriced; unknown
   model → tokens counted, cost 0, `sources.unpriced + 1`.
2. Estimated dollars match the §3 formula to 1e-9; cacheWrite/cacheRead
   defaults to input price when unspecified.
3. `cacheHit` per §4 including the zero-prompt case.
4. Document on an empty machine: exit 1, empty stdout.
5. Bucket sorting and `days` ordering (key ASC, "unknown" last) as §5.
6. Merge: union, idempotence (merge(A,A) ≡ A), order-independence, and
   recompute-not-sum (merged buckets ≠ elementwise sums when devices share
   repos).
7. Reconciliation: `Σ workUnits.cost === totals.cost` incl. `unattributed`.
8. Privacy: a full-path string appearing anywhere in bundle output fails.
9. Identity: deviceId is opaque (uuid-shaped or otherwise non-personal);
   hostname never appears raw.

The `burn` test-suite (`test/burn.test.js`, 39 vectors) is the current
reference implementation of these tests and doubles as ULP's executable
conformance suite.

## 10. Versioning

- Field additions bump the minor; renames, removals, or semantic changes bump
  the major.
- Producers echo `specVersion`; consumers reject nothing newer than they
  understand except major mismatch (warn, ignore unknown fields).
- 1.0-gate: a second independent implementation passing §9, and a named
  trademark-free home for this document.
