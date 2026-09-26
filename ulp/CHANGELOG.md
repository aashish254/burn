# ULP changelog

All notable protocol changes. Versions follow the §10 negotiation rules:
1.x is additive-only; breaking changes bump the major.

## 1.0 — 2026-09-26

- First published shape: `schema-1.0.json` (JSON Schema draft 2020-12 subset:
  `$ref`, `type`, `required`, `enum`, `const`, `pattern`, `minimum`,
  `properties`, `patternProperties`, `additionalProperties`, `items`, `anyOf`).
- Event model + provenance rules R1 (billed) / R2 (estimated) / R3 (unpriced);
  unpriced tokens never gain invented dollars.
- Merge semantics: identity `(deviceId, agent, sessionId, index-within-session)`,
  set-union, idempotent, totals **recomputed from events** (never summed).
- Privacy P1–P4 enforced by the schema itself: no absolute paths (`dir` is an
  illegal field; store paths tilde-form or omit), hostname only as hash.
- Version negotiation: major mismatch → reject; newer minor → accept, ignore
  unknown fields, warn.
- Extensions legal only under `x-<impl>-*` (RFC 0001, registry-free namespaces).
- Conformance kit `conformance/vectors` (K01–K08) with two independent
  reference implementations: burn (#1) and stdlib `ulp-reader.py` (#2) —
  the two-implementation gate for 1.0 is met; ratified by cutting the spec into
  **[github.com/aashish254/ulp](https://github.com/aashish254/ulp)** — this
  directory stays a vendored mirror (identical protocol content; only the
  burn-internal cross-links differ) so burn's CI referees both homes with one
  checkout.

### Pre-history (burn-only)

- burn `specVersion` "1.0" (v1 ledger document) and "2.0" (bundles, workUnits,
  `sources`, budget) map onto ULP 1.0; both negotiate as ULP 1.0-compatible.
