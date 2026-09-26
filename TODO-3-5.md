# burn v3–v5 — execution plan (from SPEC-3-5.md)

Autonomous-loop backlog. Each item independently verifiable; acceptance
inherits SPEC-3-5 conformance vectors in brackets. v2's rules still bind:
zero deps, no network in core, H15 honesty, additive-only JSON.

## M5 — ULP schema + pure export (v3)
- [x] `ulp/schema-1.0.json` — hand-authored JSON Schema for the ULP core (data, not a build artifact)
- [x] `src/ulp/validate.js` — hand-rolled subset validator covering exactly the schema's vocabulary (no npm dep) [16]
- [x] `x-<impl>-*` extension rule: `burn export --ulp` strips every `x-burn-*` field; output validates [16]
- [x] Version negotiation: major mismatch → clear error; newer minor → warn + ignore unknown [17]
- [x] py reader validates a burn `--ulp` bundle with zero burn-specific knowledge ✦ M5 acceptance

## M6 — `burn ingest` (v3)
- [x] `burn ingest <file|dir>`: validate → store under `~/.burn/ingest/` → idempotent by content [21]
- [x] Integrity checks: enums, token integers ≥ 0, cost numbers; R2 recompute for locally-priced models [18]
- [x] Mismatch REPORTED (count + top offenders), never repaired; `--strict` → exit 2 [18]
- [x] Ingested events flow into all commands via §E.2 merge, keeping declared provenance [19]
- [x] `burn ingest --list` (file, ingestedAt, events, cost, specVersion)
- [x] Foreign-agent fixture (aider-shaped handcrafted bundle) reaches `burn repos` totals ✦ M6 acceptance

## M7 — Conformance kit + implementation #2 (v3)
- [x] `ulp/conformance/` — pure-JSON vectors + expected results (16–21 plus reframed v1/v2 subsets)
- [x] `ulp/reference/ulp-reader.py` — single-file stdlib-only reader: aggregate + reconcile [20]
- [x] `burn conformance` command — runs the kit, pass/fail per vector id, exit 0/2 [20]
- [x] CI: kit green in Node; py reader green on same vectors; totals identical to 1e-9 [20]
- [x] `docs/ulp/` static spec site (rendering only; publishing stays user-CI-side)

## M8 — Snapshots = self-merge (v4)
- [x] `burn snapshot` → ULP bundle at `~/.burn/history/YYYY-MM-DDTHH-mm.burn.json` [22]
- [x] History merge via §E.2 union identity; re-snapshot idempotent [22]
- [x] Tie-break rules: live > snapshot; newer snapshot > older [24]
- [x] `--history` flag: default ON for report/budget(month|all)/forecast, OFF elsewhere (v1/v2 output stability) [23]
- [x] `burn history ls` / `burn history drop <file>` (confirm; only destructive command)
- [x] Delete fixture transcript after snapshot → `--history` totals unchanged ✦ M8 acceptance

## M9 — Report + plan (v4)
- [x] `burn report [--month] [-o file.md]` — markdown digest, provenance mix, doctor, cache economics; path-free
- [x] `burn plan --repo --budget --months` — forecast math on history-backed series; exits 0/3/1/2 [25]
- [x] Exhaustion date printed only when linear series is increasing (never invented) [25]
- [x] Perf budget test: 400 synthetic daily snapshots load < 250 ms (2× CI tolerance) [27]
- [x] `burn plan` 0-vs-3 on fixtures ✦ M9 acceptance

## M10 — Doctor R-5, R-6 (v4)
- [x] R-5 spend runaway: > 3× weekly growth two consecutive weeks; estImpactClass by majority class [26]
- [x] R-6 orphan spend: est $ in window, zero local git commits (read-only, silent skip non-repos) [26]
- [x] Fire + no-fire fixtures per rule

## M11 — ULP goes independent (v5)
- [x] Split: `ulp/` → standalone repo shape (spec + schema + kit + rfc/), burn keeps a vendored copy for CI
- [x] RFC process docs + `x-` namespace convention (github-style `{user}-{tool}`)
- [x] burn README/SPEC reposition: "reference implementation #1"
- [x] Same vectors pass independently from both homes [32]

## M12 — OpenTelemetry seam (v5)
- [x] `ulp/otel-mapping.md` — field table vs pinned `gen_ai.*` semconv snapshot; unmappable fields (cacheWrite provenance, WorkUnit) → ULP-namespaced attributes [29]
- [x] `burn export --otel [-o file]` — OTLP/JSON to file, offline; lossless-or-loud summary [28]
- [x] `burn ingest --otel <file>` — inverse; round-trip ≡ for core fields [28]
- [x] Mapping drift check against pinned snapshot in CI (fixture-based, no network) [29]

## M13 — Attestation + team scaffold (v5)
- [x] `pricingHash` (sha256 of effective table, 12 hex; null marker when no table applies) [30]
- [x] `burn attest [--month] [-o file.md]` — method statement, not an invoice; privacy-clean [31]
- [x] `burn init --team` — `team/usage/` + CI workflow (cron snapshot → commit → PR); idempotent; only network step is `git push` [33]
- [x] Identical fixtures + identical tables → byte-matching totals (1e-9) + shared pricingHash ✦ M13 acceptance

## Always-on gates (every cycle, v1/v2 list unchanged)
- [x] Full suite green (39 + all new vectors); zero warnings; zero runtime deps
- [x] No network in src (grep audit); no writes outside `~/.burn/` (v4 §V4.D restated)
- [x] v1/v2 JSON consumers still valid (additive-only re-check on every shape change)
