# burn — Specification v3 → v5: From Ledger to Standard (draft)

v1 answered **"where did my AI budget go?"** — shipped.
v2 answered **"what did each feature cost?"** — shipped (attribution, budgets,
doctor, mergeable bundles) and seeded the open protocol in [ulp/SPEC.md](ulp/SPEC.md).
This document plans the next three rungs, then stops: after v5, burn's job is
to be a *good reference implementation*, not a platform.

```
v1  local read-only ledger, provenance-classified dollars      ← shipped
v2  work attribution, budgets/gates, doctor, merge bundles     ← shipped
v3  ULP 1.0: the format leaves burn — any agent can emit one   ← this spec
v4  durable time: transcripts expire, history shouldn't        ← this spec
v5  the industry seam: ULP ↔ OpenTelemetry; burn goes thin     ← this spec
```

**Non-negotiable carry-forwards (every version, binding):**
no network in core · zero runtime dependencies · no writes to any agent's own
data · never invent a price (R1/R2/R3) · nothing ships claiming an unverified
format (H15) · privacy §9/P1–P4 (basename labels and hashes only) · v1/v2
JSON consumers keep working forever (additive-only).

Key words MUST/MUST NOT/SHOULD/MAY per RFC 2119. Conformance vectors continue
numbering from v1 §10 (1–9) and v2 §H (10–15): v3 = 16–21, v4 = 22–27,
v5 = 28–33.

---

# V3 — ULP 1.0: the protocol leaves burn

**Why.** Today a ledger exists only because `burn` parsed a transcript. The
format itself — events, provenance, buckets, merge semantics — is the valuable
artifact, and it is trapped inside one CLI. v3 makes it speakable by anyone:
Cursor-style agents that want to write their own usage logs, dashboards that
never install burn, budget gates in other languages. ulp/SPEC.md §10 says 1.0-gate =
a second independent implementation; v3 *is* that gate.

### V3.A Schema, not vibes
- The ULP core shape ships as machine-readable JSON Schema:
  `ulp/schema-1.0.json` (draft 2020-12, checked in, generated-by-hand — it is
  data, not a build artifact).
- burn validates against a **hand-rolled subset validator** (`src/ulp/validate.js`)
  covering exactly the schema's constraint vocabulary — no npm validator
  dependency, ever.
- `specVersion` is negotiated per [ulp/SPEC.md](ulp/SPEC.md) §10: major mismatch →
  reject with a clear error; minor/unknown fields → warn, ignore.
- Extension rule (normative): implementations MAY add fields only under an
  `x-<impl>-*` namespace; `burn export --ulp` MUST emit a **pure core**
  document with all `x-burn-*` fields stripped. Consumers MUST NOT require
  any `x-*` field.

### V3.B `burn ingest` — burn becomes a consumer
```
burn ingest <file|dir> [--strict]     # accept any conformant ULP bundle
burn ingest --list                    # what has been ingested, when, how many events
```
- Ingested bundles are validated, then stored under `~/.burn/ingest/` (the one
  place burn writes, user-owned, trivially deletable).
- Integrity checks at ingest: enums valid, token integers ≥ 0, `cost` numbers;
  for any event whose model resolves in the **local** pricing table, the R2
  formula is recomputed — a mismatch is REPORTED (count + top offenders),
  never silently repaired. `--strict` makes mismatch an error (exit 2).
- Ingested data joins every downstream command through the §E.2 merge rules
  (union identity, recompute-not-sum) — an ingested bundle from another tool
  is indistinguishable from a foreign device's export.
- Ingested events keep their declared provenance; burn MUST NOT upgrade an
  external `estimate` to `store` or vice versa.

### V3.C Conformance kit + implementation #2
- `ulp/conformance/` — pure-JSON vectors with expected results (the 16–21 set
  below plus the v1/v2 subsets reframed): any language can pass without
  touching Node.
- `ulp/reference/ulp-reader.py` — a single-file, stdlib-only Python reference
  READER (aggregate + reconcile a bundle set; not an extractor). Its job is
  existence proof: the protocol does not secretly require Node, burn, or
  hidden state. Both readers (burn, py) MUST produce identical totals on
  every vector.
- `burn conformance` runs the kit locally and prints pass/fail per vector id
  (exit 0/2). CI runs it.

### V3.D Spec home
- `docs/ulp/` renders ulp/SPEC.md + schema + conformance README as a static site.
  Publishing is the user's CI's job (network stays outside core, §B.4 precedent).

**v3 milestones & acceptance**
- M5: schema + subset validator + `export --ulp` purity. ✦ py-reader validates
  a burn bundle with zero burn-specific knowledge.
- M6: `ingest` + integrity + mismatch reporting + `--strict`. ✦ a handcrafted
  foreign-agent bundle (e.g. `aider`-shaped) flows into `burn repos` totals.
- M7: conformance kit + py reader + `burn conformance` in CI. ✦ vectors
  16–21 green in TWO languages.

Conformance vectors 16–21:
16. `export --ulp` contains no `x-burn-*` key and validates against the schema.
17. Ingest rejects a major-version bundle (exit 2, named version in message);
    accepts a newer-minor bundle with a warning and ignored unknown fields.
18. Ingest recompute-mismatch: wrong `cost` on a locally-priced model is
    reported; `--strict` exits 2; totals never silently change.
19. Ingested events appear in `repos`/`models`/budget/merge with their
    original provenance class; `sources` counts match the bundle's `sources`.
20. Conformance kit runs standalone (JSON in → pass/fail out) and the py
    reader passes every vector with totals identical to burn's (1e-9).
21. Idempotence: ingesting the same bundle file twice yields one copy per
    event identity.

---

# V4 — Durable time: the ledger grows a memory

**Why.** burn is stateless by design, and that is also its biggest user-facing
limit: agent transcripts get deleted (retention, log rotation, reinstalled
laptops), so last month's answer changes to `—`. Bill-shock is a *time*
problem: "how did my June compare?" and "is this trend real?" need history
that outlives the transcripts. v4 adds exactly one durable artifact —
snapshots the user owns — and gets its integrity for free by reusing v2 merge
semantics.

### V4.A Snapshots = self-merge
- `burn snapshot [--since]` writes the current ledger as an ordinary ULP
  bundle to `~/.burn/history/YYYY-MM-DDTHH-mm.burn.json`. Nothing custom:
  history IS bundles.
- Every reading command MAY include history (`--history`, default ON for
  `report`/`budget --period month|all`/`forecast`, OFF elsewhere to preserve
  v1/v2 output stability).
- Dedup comes from §E.2 union identity. Normative tie-break (new): on an
  identity collision between **live** gather and a **snapshot**, the live
  event MUST win (it is the fresher record of a still-growing session);
  between two snapshots, the newer `generatedAt` wins. Re-runs of `snapshot`
  are idempotent by identity — no double counting is possible by construction.
- `burn history ls` lists snapshots (date, events, cost); `burn history drop
  <file>` deletes (the only destructive command; confirmation required, file
  under `~/.burn/`).

### V4.B Report & plan
```
burn report [--month YYYY-MM] [-o file.md]   # monthly digest, markdown
burn plan --repo <label> --budget <usd> --months <n>
```
- `report` = repos/models/agents/work units for the month + provenance mix +
  doctor findings at month end + cache economics. Markdown, paths-free, safe to
  email or commit. Zero network by construction.
- `plan` answers "can I afford X months at Y dollars?": forecast math (v2 §C.1)
  over history-backed daily series; verdict + projected exhaustion date
  computed from the linear series only (never invented). Exit `0` affordable
  / `3` not — the same gate contract as `budget`, so AgentVault and CI reuse it.

### V4.C Doctor grows up (R-5, R-6)
- **R-5 spend runaway**: total weekly cost grows > 3× in two consecutive
  weeks → info-level, cites the two weeks (estImpactClass: billed/estimated
  per the majority class in the newer week).
- **R-6 orphan spend**: a repo with > $X estimated spend in the window whose
  local git shows zero commits in that window (read-only `git log`, silent
  skip on non-repos, v2 §B.2 rules) → "paid for work that isn't landing?".
  Observation only; never guesses where the work went.

### V4.D Constraints
- History read budget: any command with `--history` over ≥ 365 daily
  snapshots MUST stay < 250 ms on the reference machine (property test with
  synthetic bundles; slow path fails the test, not the user).
- Snapshots obey ULP privacy §7 exactly (they ARE bundles; `dir` already
  stripped). Retention is the user's: burn never prunes silently.
- v1 §P2 nuance, restated: burn writes only under `~/.burn/` (`id`, pricing,
  attributes, ingest/, history/). It still writes nothing it reads.

**v4 milestones & acceptance**
- M8: snapshot + history merge + live-wins tie-break + idempotent re-snapshot.
  ✦ delete a fixture transcript after snapshotting; totals unchanged.
- M9: `report` + `plan` with gate exits + retention/perf budget test.
  ✦ `burn plan --repo X --budget 50 --months 2` exits 0 vs 3 on fixtures.
- M10: R-5/R-6 with fire + no-fire fixtures.

Conformance vectors 22–27:
22. Snapshot twice → merged history has one event per identity; totals == single.
23. Transcript deletion after snapshot → `--history` totals stable; without
    it, the data is gone (both behaviors asserted).
24. Live-wins tie-break: snapshot with stale `storedCost` + live event, same
    identity → live value in `--history` aggregates.
25. `plan` exits 0 under budget, 3 over, 1 with no priced history, 2 on bad
    flags; exhaustion date only printed when the linear series is increasing.
26. R-5/R-6 fire on crafted fixtures and stay silent on healthy ones.
27. Perf budget: 400 synthetic daily snapshots load in < 250 ms (CI tolerance
    2× on shared runners).

---

# V5 — The industry seam: ULP meets OpenTelemetry, burn goes thin

**Why.** By v5, agent-telemetry convergence around OpenTelemetry's GenAI
semantic conventions is a safe bet; enterprises will want spend ledgers
speaking both dialects. And burn should *shrink* as the protocol grows: the
endgame is that burn's CLI is optional — a reference implementation, a
conformance referee, and the friendliest reader of a standard everyone can
emit.

### V5.A ULP governance leaves the building
- ULP (schema + spec + conformance kit) moves to its own home
  (`aashish254/ulp` initially), with an open RFC process: `rfc/NNNN-title.md`,
  published decisions, changelog. Schema evolution stays additive-only under
  the §10 versioning rules.
- burn demotes itself in its own docs: "reference implementation #1";
  `ulp-reader.py` becomes #2 and CI runs the kit against both.
- A registry-free discovery convention: `x-<impl>-*` namespaces self-declare;
  no central authority, no domain squatting — namespaces are github-style
  `{repo-or-user}-{tool}` strings documented in the RFC.

### V5.B OpenTelemetry mapping (translation, not adoption)
- `ulp/otel-mapping.md` — field-by-field table UsageEvent ↔ OTel GenAI span
  attributes (`gen_ai.*` token usage, model, provider, conversation id),
  versioned against the semconv release date and re-verified when the mapping
  file is touched. Where OTel has no slot (cacheWrite provenance, WorkUnit
  attribution), ULP fields map to span attributes under the ULP namespace —
  documented, never smuggled.
- `burn export --otel [-o file]`: emits OTLP/JSON *to a file* (pure transform,
  offline). `burn ingest --otel <file>`: the inverse. Core NEVER opens a
  collector socket — shipping to a backend is the user's pipeline's job, the
  same boundary as the PR-badge action.
- Lossless-or-loud: any ULP field that cannot be represented in OTel MUST be
  listed in the export summary; lossy-by-silence is a conformance failure.

### V5.C Auditability for money conversations
- Every ledger/bundle gains `pricingHash` (SHA-256 of the effective pricing
  table incl. user overrides, truncated 12 hex) — so an estimate is
  *reproducible*: same table + same tokens = same dollars, provable years
  later without the table owner's trust.
- `burn attest [--month] [-o file.md]`: a finance-shaped one-pager — totals by
  provenance class, sources, pricingHash, tool + spec versions, doctor state.
  A statement of method, explicitly *not* an invoice (N1 price authority still
  belongs to providers).

### V5.D Team scaffold, still serverless
- `burn init --team` writes `team/usage/` + a ready CI workflow (cron snapshot
  → commit bundle → PR) into the user's repo; the workflow uses burn + git
  only. The user's network is their own; core stays offline.

**Explicit non-goals, v3–v5 (the fence around the whole plan):**
hosted services, accounts, telemetry of any kind, plugin runtimes, LLM-written
advice or summaries, price authority, collector backends, dashboards-as-a-
product, enforcement (that is AgentVault's job — burn measures). If a feature
needs a server or a socket in core, it does not ship.

**v5 milestones & acceptance**
- M11: ULP repo split + RFC process + namespace convention. ✦ v3 conformance
  kit passes from the new home, unchanged.
- M12: OTel mapping + `--otel` export/ingest with lossless-or-loud summary.
- M13: `pricingHash` + `attest` + `init --team`. ✦ two runs with identical
  pricing tables on identical fixtures byte-match totals to 1e-9 and share a
  pricingHash; the scaffolded workflow is exercised in a throwaway repo.

Conformance vectors 28–33:
28. `export --otel` output parses as OTLP/JSON; every unmappable ULP field is
    named in the summary; ingest(export(x)) ≡ x for core fields (1e-9 on costs).
29. OTel mapping doc's attribute names re-verified against a pinned semconv
    snapshot; drift fails CI (fixture-based, no network).
30. `pricingHash` changes iff the effective table changes; absent table (all
    unpriced) yields a stable null marker, not a hash of nothing.
31. `attest` output contains no path, hostname, or model pricing claim beyond
    provenance classes (privacy + N1 audit).
32. ULP repo and burn repo pass the same conformance vectors independently;
    py reader unchanged.
33. `init --team` is idempotent, touches only the invoked repo, and its
    generated workflow's only network step is `git push` (asserted by grep).

---

## The one-paragraph version

**v3** makes the format bigger than the tool (schema, ingest, conformance kit,
second implementation). **v4** makes the tool outlive the transcripts it reads
(snapshots as self-merge, monthly reports, budget planning, grown-up doctor).
**v5** makes the protocol speak to the industry (OTel seam, reproducible-price
attestation, serverless team scaffolds) while burn itself gets *smaller* — the
sign the standard worked.
