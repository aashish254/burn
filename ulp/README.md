# ULP — Usage Ledger Protocol

A tiny, privacy-first wire format for **what your coding agents cost**: tokens,
dollars, provenance, and the work they attach to — as plain JSON a team can
merge across machines without a server, an account, or a network.

This folder is the protocol's home. It is self-contained: nothing here needs
Node, Python, or any particular tool — just JSON and this repository's files.

## What's here

| Path | What it is |
|---|---|
| [SPEC.md](SPEC.md) | The normative protocol: event model, provenance R1–R3, merge semantics, privacy P1–P4, version negotiation. |
| [schema-1.0.json](schema-1.0.json) | JSON Schema (draft 2020-12 subset) for a ULP bundle. |
| [conformance/](conformance/README.md) | Pure-JSON test vectors — the kit any implementation runs against, in any language. |
| [reference/ulp-reader.py](reference/ulp-reader.py) | Reference implementation **#2**: a stdlib-only Python reader, validator, merger, and kit runner. |
| [rfc/](rfc/README.md) | The open change process and published decisions. |
| [CHANGELOG.md](CHANGELOG.md) | Version history of the protocol itself. |

## Reference implementations

1. **[burn](../)** — the cross-agent cost ledger CLI that grew the protocol.
   `node src/cli.js conformance` referees the kit; `export --ulp` emits,
   `ingest` accepts.
2. **[ulp-reader.py](reference/ulp-reader.py)** — proof that conformance needs
   no hidden Node-ness: one file, standard library only, same vectors green.

Both MUST pass every vector; disagreement is resolved by amending SPEC.md, not
by patching one implementation (see the kit README).

## Extending ULP

Core fields never change under 1.x (additive-only). Anything implementation-
specific goes under `x-<impl>-*`, where `<impl>` follows the
[{repo-or-user}-{tool} convention](rfc/0001-extension-namespaces.md) —
registry-free, self-declared, no domain squatting. Behavior changes, new core
fields with changed meaning, or new merge rules require an
[RFC](rfc/README.md).

## Status

1.0 (draft): the two-implementation gate is met. Ratification = the version
field stops being a draft in [CHANGELOG.md](CHANGELOG.md) once the spec is cut
into its own repository; until then this directory is vendored inside burn so
CI can referee both homes with one checkout.
