# ULP 1.0 conformance kit

Pure-JSON test vectors. Any implementation — in any language — can pass this
kit by reading **only** `SPEC.md`, `schema-1.0.json`, and this file. No
Node, no Python, no burn-specific code is required to write a runner.

Two runners already exist and MUST stay green in CI:

| Runner | Command |
|---|---|
| burn (reference implementation #1) | `node src/cli.js conformance` |
| stdlib Python reader (#2) | `python3 ulp/reference/ulp-reader.py conform` |

Both exit `0` when every vector passes and `2` on any failure.

## Vector format

Each `vectors/*.json` file is one vector:

```json
{
  "id": "K06",
  "name": "human-readable claim being proven",
  "kind": "validate | validate-both | merge",
  "bundle":  { ... },          // kind=validate / validate-both
  "bundles": [ {...}, ... ],   // kind=merge
  "expectSameReversed": true,  // optional, kind=merge only
  "expect": { ... }            // per-kind expectations, below
}
```

The vectors directory may be overridden with the `ULP_VECTORS_DIR` env var so
implementations can also run private vectors through the same tooling.

### kind: `validate`
`expect.ok` is a boolean: does `bundle` validate against
`ulp/schema-1.0.json` in **strict** mode (unknown non-`x-*` fields are
errors) — matching ULP's current-minor behavior.

### kind: `validate-both`
`expect.strictOk` and `expect.relaxOk`: the same bundle validated strictly and
then with the newer-minor relaxation (unknown non-`x-*` fields ignored). A
conformant reader answers the version question before the field question —
see SPEC.md §Negotiation.

### kind: `merge`
Merge `bundles` per ULP §Merge semantics — identity
`(deviceId, agent, sessionId, index-within-session)`, set-union, totals
**recomputed from the merged event set** (never summed from pre-aggregated
rows) — then compare against `expect.totals`:

```json
"expect": {
  "totals": {
    "events": 3, "cost": 20.25, "cacheHit": 0.7272727272727273,
    "sources": { "store": 1, "estimate": 1, "unpriced": 1 },
    "repos": { "shared-repo": 9.0, "a-only": 11.25 }
  }
}
```

Comparison tolerances: exact for counts; absolute difference `< 1e-9` for
`cost`, `cacheHit`, and each per-repo cost. `repos` must match in both the
listed costs **and** the total number of repo buckets (an extra or missing
bucket is a failure even if every listed number matches). `sources` counts
events by provenance class (`store` / `estimate` / `unpriced`).

If `expectSameReversed` is true, the merge MUST produce identical totals when
`bundles` is given in reverse order — agreement is order-free, not
order-tolerant.

## What the kit currently proves

- `K01` a minimal bundle is accepted; the schema is satisfiable.
- `K02` unknown non-`x-*` fields fail at the current minor and are ignored
  only under the newer-minor relaxation.
- `K03` `x-<impl>-*` extension fields are legal without registration.
- `K04` absolute paths (`dir`, non-`~/` store paths) are rejected — privacy P3.
- `K05` a stored cost of `0` stays provenance `store` (billed zero ≠ unpriced).
- `K06` merge unions devices, recomputes buckets from events (not sum-of-sums),
  and is order-free.
- `K07` `merge(A, A) == A` — union identity; re-ingesting cannot double-count.
- `K08` unpriced tokens still count; dollars are withheld (provenance rule R3).

## Writing a new vector

1. Add `vectors/KNN-short-name.json` following the format above.
2. Keep it a *claim about the protocol*, not about burn's UX.
3. Run both runners; they must agree. If they disagree, the protocol — not
   the implementation — is under-specified; fix SPEC.md first.
