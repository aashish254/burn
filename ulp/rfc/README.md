# ULP RFC process

ULP is governed from this folder, not from any one implementation's repo.
Changes to the protocol — core fields, merge semantics, privacy rules, the
conformance kit's meaning — go through RFCs; everything else is a bug fix.

## How to propose a change

1. Copy the shape below into `NNNN-short-title.md` (next free number), status
   `draft`.
2. Open it as a pull request against this repo. Anyone may open one; you do
   not need commit rights to propose.
3. Discussion happens on the PR. The bar to merge is **evidence, not
   authority**: at least one of the reference implementations must show the
   change is implementable, and the conformance kit gains or amends a vector
   proving the claim.
4. When published, status becomes `accepted`, the decision is summarized in
   [../CHANGELOG.md](../CHANGELOG.md), and `SPEC.md` / `schema-1.0.json` are
   updated in the same commit.

## Versioning bar (from SPEC.md §10)

- **Additive-only under 1.x**: new optional fields, new `x-*` usage, new
  vectors. Old documents MUST keep validating and old readers MUST ignore what
  they don't understand (newer-minor negotiation).
- A schema **breaking** change is a major version: `schema-2.0.json`, new
  `ulpVersion`, and negotiation rejects it until readers opt in.
- Conformance vectors are forever: a vector is never edited to make a failing
  implementation pass; a wrong vector is superseded by a new one, both kept.

## RFC shape

```
# RFC NNNN — title
status: draft | accepted | rejected | superseded-by:NNNN
created: YYYY-MM-DD
affects: spec | schema | vectors | privacy | versioning

## Problem
## Proposal
## Consequences (including which vector proves it)
```

## Index

| # | Title | Status |
|---|---|---|
| [0001](0001-extension-namespaces.md) | Registry-free `x-<impl>-` namespaces | accepted |
