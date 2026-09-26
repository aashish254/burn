# burn v2 — execution plan (from SPEC-2.md §I)

Autonomous-loop backlog. Each item is independently verifiable; acceptance
inherits SPEC-2 §H conformance numbers in brackets.

## M1 — Work attribution (the v2 headline)
- [x] Capture `gitBranch` from Claude user-lines into UsageEvent (native confidence)
- [x] Read-only git joiner: timestamp→HEAD mapping via `git log` (no lock/fetch/write; skip non-repos silently) [H10]
- [x] WorkUnit resolution: explicit `--unit` > branch > repo fallback; `unattributed` bucket never silently dropped
- [x] `burn work` (per-WorkUnit costs, class split, confidence column)
- [x] `burn blame <ref>` — branch-name and `A..B` commit-range forms [H10]
- [x] `burn attribute <session> --unit <name>` persisted in `~/.burn/attributes.json`
- [x] Reconciliation invariant test: Σ workUnits == totals (property test on fixtures) [H11]
- [x] Privacy re-check: blame/work output carries no paths beyond repo basename (v1 §9)

## M2 — Agent matrix + gates
- [x] Verify Codex rollout JSONL format on real data, then implement extractor [H15] (source-verified at line level + byte-faithful fixture test)
- [x] Verify Gemini CLI chat format on real data, then implement extractor [H15] (source-verified; no double-count of cached slice)
- [x] ~~OpenClaw~~ → HELD per H15: live store is SQLite with unconfirmed table names; extractor stays unregistered, `supportedAgents` omits it (SPEC-2 §A updated)
- [x] `burn sources` (paths, counts, date range, cost class per source) — reports absent sources honestly
- [x] `burn budget --repo --max [--period]` with exit 3 = over-budget [H13]
- [x] `burn watch` — fs-poll per-turn cost stream; no SQLite hot loop
- [x] `--confidence` filter on work units [§G]
- [x] Example PR-badge GitHub Action (user's CI does network; core stays offline)
- [x] `supportedAgents[]` truthfulness field in `--json` [H15]

## M3 — Forward money + advice
- [x] `burn forecast` (priced events only, window size printed, `est-forecast` label) [H13]
- [x] `burn counterfactual --route` (pure arithmetic, `—` for unpriced, `estimate-of-estimate` label) [H13]
- [x] `burn doctor` R-1..R-4 rules; findings carry `estImpactClass` [H14]
- [x] fire/no-fire fixtures per rule; snapshot tests for forecast math

## M4 — Teams without a backend
- [x] `deviceId` at `~/.burn/id` (uuid, never name-derived) + `hostnameHash`
- [x] `burn export` bundle (additive §F fields, `--compact`)
- [x] `burn merge` union semantics, idempotent, order-independent, recompute-not-sum [H12]
- [x] `burn merge --audit` duplicate-deviceId detection
- [x] `burn team` view + optional local `roster.json` labels
- [x] specVersion "2.0" + `supportedAgents[]` truthfulness gate in CI [H15]
- [x] Extract ledger format section into standalone ULP draft doc (ULP.md)

## Always-on gates (every cycle)
- [x] v1 suite stays 100% green (ledger shape is additive-only) — 39/39 pass
- [x] npm test: zero warnings; zero runtime dependencies; no network in src (grep audit)
