# burn — TODO (derived from SPEC.md) — ALL COMPLETE

## Extractors (§2, §5)
- [x] §2.1 UsageEvent shape emitted by claude extractor (skip `<synthetic>`, UTC date, null storedCost)
- [x] §2.1 opencode extractor: per-session aggregate event, billed cost incl. genuine 0, model JSON parse
- [x] §2.2 repo label = basename, no path/home leak
- [x] §5 extractor exports `label` / `available()` / `extract()`, read-only opens, env overrides

## Pricing (§4)
- [x] §4 malformed pricing file → stderr warning, non-fatal (verified: `burn: ignoring malformed JSON at …`, exit 0)
- [x] §4 version-suffix-only family folding; variant & reverse-prefix rejected (tests 6–7: `gpt-5-micro` ⇒ unpriced)

## Ledger document (§6)
- [x] §6 `--json` shape: `specVersion:"1.0"`, `totals.key:"total"`, numeric-only costs, repos sorted cost DESC (spawned-CLI fixture test)

## CLI grammar & exit codes (§7)
- [x] commands, --since, --json, --pricing, -h, -v
- [x] --since excludes `unknown`-dated events (test)
- [x] exit 0 report / 1 no data (silent stdout) / 2 unexpected error (tests)

## Rendering & formatting (§3.1, §8)
- [x] bars scale to displayed max; USD format (`—`, `<$0.01`, 2-dec, comma-grouped)
- [x] §8 NO_COLOR ⇒ zero ANSI bytes (test; fixed bar() that leaked raw palette.gray)
- [x] §3.1 V6 cacheHit on zero-prompt bucket = exactly 0 (test)

## Privacy & integrity (§9)
- [x] no network I/O in src (audit)
- [x] P1–P4 encoded; repo labels verified username-proof

## Conformance vectors (§10)
- [x] V1 synthetic skipped · V2 billed-zero ≠ unpriced · V3 unknown model tokens-only
- [x] V4 estimate exact to 1e-9 · V5 user override wins · V6 zero-prompt cacheHit
- [x] V7 empty machine exit 1 silent stdout · V8 repo-label edges · V9 malformed JSONL tolerated

## Packaging & docs
- [x] README: exit codes + spec pointers + 14-test description
- [x] `npm test` runs with zero Node warnings (--disable-warning=ExperimentalWarning)
- [x] all files syntax-clean; suite 14/14; real-machine output unchanged

## Termination
- [x] Every item checked; 0 errors; 0 warnings; 14/14 tests pass; live regression verified
