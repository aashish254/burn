# ULP ↔ OpenTelemetry GenAI mapping

status: informative (a translation table, not a adoption mandate)
semconv pin: [semantic-conventions-genai@e57c543b4889](./semconv-genai-pin.json)
pinned date: 2026-09-24 (registry file `docs/registry/attributes/gen-ai.md`)

ULP and OTel GenAI solve different problems: OTel traces **one call** as a span
inside a distributed system; ULP counts **money** as a mergeable event. The seam
therefore translates: `burn export --otel` writes OTLP/JSON **to a file**
(offline, pure transform), `burn ingest --otel <file>` reads it back. Core
never opens a collector socket — shipping telemetry to a backend is your
pipeline's job, the same boundary as the CI badge.

**Re-verification rule:** every `gen_ai.*` name below was read from the pinned
registry snapshot, and a conformance test (vector 29) fails CI if the two ever
drift apart. Updating the mapping means re-fetching the registry and bumping
the pin — in the same commit.

## UsageEvent → OTLP span

One ULP event = one span in `resourceSpans[].scopeSpans[].spans[]`.

| ULP field | OTel attribute | Kind | Notes |
|---|---|---|---|
| `model` | `gen_ai.request.model` | mapped | |
| `sessionId` | `gen_ai.conversation.id` | mapped | "conversation (session, thread)" per semconv |
| `tokens.input` | `gen_ai.usage.input_tokens` | mapped | int |
| `tokens.output` | `gen_ai.usage.output_tokens` | mapped | int |
| `tokens.cacheRead` | `gen_ai.usage.cache_read.input_tokens` | mapped | int |
| `tokens.cacheWrite` | `gen_ai.usage.cache_write.input_tokens` | mapped | int |
| `tokens.reasoning` | `gen_ai.usage.reasoning.output_tokens` | mapped | int |
| — (span name) | `gen_ai.operation.name` = `"chat"` | mapped | ULP events are all model turns |
| — | `gen_ai.provider.name` | **not emitted** | burn records the *agent*, not the provider; inventing a provider would be a guess. Producer-side ULP emitters that know theirs MAY set it. |

## Fields with no OTel slot → ULP namespace (RFC 0001 style)

Documented, never smuggled: these ride as span attributes named `ulp.*`.

| ULP field | Span attribute | Why no gen_ai slot |
|---|---|---|
| `agent` | `ulp.agent` | semconv has provider, not client-tool |
| `repo` | `ulp.repo` | no source-control attributes in gen-ai registry |
| `date` | `ulp.date` | derived from `startTimeUnixNano` on read; kept for exactness |
| `cost` | `ulp.cost` | **money is absent from OTel GenAI entirely** — this mapping's whole reason to exist |
| `costSource` | `ulp.costSource` | provenance (store/estimate/unpriced) has no OTel slot |
| `storedCost` | `ulp.storedCost` | ditto |
| `gitBranch` | `ulp.gitBranch` | attribution input |
| `attribution.*` | `ulp.attribution.kind` / `.ref` / `.confidence` | WorkUnit attribution has no OTel slot |
| session order | `ulp.eventIndex` | preserves the §E.2 identity `(deviceId, agent, sessionId, index)` |

Span identity: `traceId` = first 32 hex of `sha256(deviceId|agent|sessionId|index)`,
`spanId` = next 16 hex — deterministic, so re-export is byte-identical and
round-trips don't invent churn. `startTimeUnixNano` = event `ts` (an instant:
start = end, ULP has no duration). Bundle identity travels as resource
attributes `ulp.deviceId`, `ulp.ulpVersion`, `ulp.generatedAt`;
`service.name` = `"ulp"`.

## Inverse (`burn ingest --otel`)

Every `ulp.*` attribute above is read back; the five usage token counters
supply tokens;
`ulp.cost`/`ulp.costSource`/`ulp.storedCost` restore money **exactly as the
producer recorded it** — ingested estimates are checked against local pricing
and *reported*, never repaired (§V3.B, unchanged).

## Lossless-or-loud

`burn export --otel` prints a summary naming: fields written as `gen_ai.*`
(mapped), fields written as `ulp.*` (namespaced — representable only because
this document says so), and fields **dropped** — which must be none for core
ULP; a non-empty drop list is a conformance failure, and burn exits 2 on it.
Report buckets (`repos[]`, `models[]`, …) are never transported: consumers
recompute them from events, per ULP's recompute-not-sum rule.

## Vectors

- **28**: `export --otel` output parses as OTLP/JSON; summary names every
  unmappable field; `ingest(export(x)) ≡ x` on core fields, costs to 1e-9.
- **29**: every `gen_ai.*` name here exists in
  [semconv-genai-pin.json](semconv-genai-pin.json); drift fails CI, offline.
