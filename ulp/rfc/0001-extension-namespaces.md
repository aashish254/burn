# RFC 0001 — Registry-free extension namespaces

status: accepted
created: 2026-09-26
affects: spec, privacy, versioning

## Problem

Implementations need to attach fields ULP doesn't know — burn's device
bookkeeping, an org's cost-center tags, an agent's internal tier labels —
without waiting on protocol change and without stepping on each other. A
central registry of namespaces is a bureaucratic server: ULP's whole point is
zero-infrastructure trust.

## Proposal

Extensions live under top-level (or per-object) keys matching
`x-<impl>-<field>` where `<impl>` is a GitHub-style string:
`{repo-or-user}-{tool}`, lowercase, e.g. `x-burn-snapshotKind`,
`x-acme-finops-costCenter` for user `acme`'s `finops` tool.

- **Self-declared**: an implementation names itself in its own bundles; there
  is nothing to register with anyone.
- **Collision-resistant, not collision-proof**: `{repo-or-user}-{tool}` mirrors
  GitHub's own uniqueness, so the practical cost of squatting is a rename.
  Two parties MAY coordinate by forking the namespace out-of-band; ULP takes
  no position.
- **Gate behavior unchanged**: unknown keys NOT matching `x-*-` remain errors
  at the current minor (strict) and are ignored only under newer-minor
  relaxation — so `x-` is the only legal way to grow a document, and a reader
  can always tell "protocol violation" from "someone else's dialect".
- Privacy rules P1–P4 apply to extension payloads exactly as to core fields:
  an extension that carries absolute paths, hostnames, or session content is
  non-conformant data even though the shape is legal.

## Consequences

`schema-1.0.json` already encodes the rule (`patternProperties` on `^x-[a-z0-9-]+`,
`additionalProperties: false` elsewhere), and vectors `K02` (unknown non-x
rejected; ignored under relax) and `K03` (x-* legal without registration)
prove both halves. Documentation in SPEC.md §"Extensions" points here once the
folder becomes its own repo's root.
