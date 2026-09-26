// SPEC-3-5 §V5.B — the OpenTelemetry seam: TRANSLATION, not adoption.
// `burn export --otel` writes OTLP/JSON to a FILE (pure transform, offline);
// `burn ingest --otel` reads it back. Core never opens a collector socket.
// Field-by-field rationale lives in ulp/otel-mapping.md, pinned against
// ulp/semconv-genai-pin.json (vector 29 keeps them honest, offline).

import crypto from "node:crypto";
import { aggregateEvents } from "../aggregate.js";
import { toUlpDocument } from "./ulp.js";

const TOKEN_ATTRS = {
  input: "gen_ai.usage.input_tokens",
  output: "gen_ai.usage.output_tokens",
  cacheRead: "gen_ai.usage.cache_read.input_tokens",
  cacheWrite: "gen_ai.usage.cache_write.input_tokens",
  reasoning: "gen_ai.usage.reasoning.output_tokens",
};

const kvStr = (key, value) => ({ key, value: { stringValue: String(value) } });
const kvInt = (key, value) => ({ key, value: { intValue: String(value) } });
const kvDbl = (key, value) => ({ key, value: { doubleValue: value } });

function attrValue(v) {
  if ("stringValue" in v) return v.stringValue;
  if ("intValue" in v) return Number(v.intValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("boolValue" in v) return v.boolValue;
  return null;
}

const attrsToMap = (attrs) => Object.fromEntries((attrs || []).map((a) => [a.key, attrValue(a.value)]));

function spanIds(deviceId, agent, sessionId, index) {
  const h = crypto.createHash("sha256").update(`${deviceId}|${agent}|${sessionId}|${index}`).digest("hex");
  return { traceId: h.slice(0, 32), spanId: h.slice(32, 48) };
}

// bundle: a purified ULP document ({deviceId, generatedAt, events[]}).
// Returns { otlp, summary }. Lossless-or-loud: every event field is either a
// gen_ai.* attribute or a documented ulp.* one; anything else lands in
// summary.dropped and the caller MUST fail on it.
export function toOtlp(bundle) {
  const deviceId = bundle.deviceId || "unknown-device";
  const dropped = [];
  const spans = [];
  const counters = new Map();
  const MAPPED_KEYS = new Set([
    "agent", "sessionId", "model", "repo", "date", "ts", "tokens",
    "storedCost", "cost", "costSource", "gitBranch", "attribution", "ulpVersion",
  ]);

  for (const ev of bundle.events || []) {
    const sk = `${ev.agent}|${ev.sessionId}`;
    const index = counters.get(sk) || 0;
    counters.set(sk, index + 1);

    for (const k of Object.keys(ev)) {
      if (!MAPPED_KEYS.has(k) && !/^x-/.test(k)) dropped.push(`events[].${k}`);
    }

    const ts = typeof ev.ts === "number" ? ev.ts
      : ev.date && ev.date !== "unknown" ? Date.parse(ev.date + "T00:00:00Z") : 0;
    const attrs = [
      kvStr("gen_ai.operation.name", "chat"),
      kvStr("gen_ai.request.model", ev.model ?? "unknown"),
      kvStr("gen_ai.conversation.id", ev.sessionId),
    ];
    for (const [field, name] of Object.entries(TOKEN_ATTRS)) {
      if (ev.tokens?.[field]) attrs.push(kvInt(name, ev.tokens[field]));
    }
    attrs.push(
      kvStr("ulp.agent", ev.agent),
      kvStr("ulp.repo", ev.repo ?? "(unknown)"),
      kvStr("ulp.date", ev.date ?? "unknown"),
      kvStr("ulp.costSource", ev.costSource),
      kvInt("ulp.eventIndex", index)
    );
    if (typeof ev.cost === "number") attrs.push(kvDbl("ulp.cost", ev.cost));
    if (typeof ev.storedCost === "number") attrs.push(kvDbl("ulp.storedCost", ev.storedCost));
    if (ev.gitBranch) attrs.push(kvStr("ulp.gitBranch", ev.gitBranch));
    if (ev.attribution) {
      attrs.push(
        kvStr("ulp.attribution.kind", ev.attribution.kind),
        kvStr("ulp.attribution.ref", ev.attribution.ref),
        kvStr("ulp.attribution.confidence", ev.attribution.confidence)
      );
    }

    const { traceId, spanId } = spanIds(deviceId, ev.agent, ev.sessionId, index);
    const nano = String(BigInt(ts) * 1000000n);
    spans.push({
      traceId,
      spanId,
      name: `chat ${ev.model ?? "unknown"}`,
      kind: "SPAN_KIND_CLIENT",
      startTimeUnixNano: nano,
      endTimeUnixNano: nano,
      attributes: attrs,
    });
  }

  const otlp = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            kvStr("service.name", "ulp"),
            kvStr("ulp.deviceId", deviceId),
            kvStr("ulp.ulpVersion", bundle.ulpVersion || "1.0"),
            kvStr("ulp.generatedAt", bundle.generatedAt || new Date(0).toISOString()),
          ],
        },
        scopeSpans: [
          { scope: { name: "ulp", version: "1.0" }, spans },
        ],
      },
    ],
  };

  return {
    otlp,
    summary: {
      spans: spans.length,
      mapped: ["gen_ai.operation.name", "gen_ai.request.model", "gen_ai.conversation.id", ...Object.values(TOKEN_ATTRS)],
      namespaced: [
        "ulp.agent", "ulp.repo", "ulp.date", "ulp.cost", "ulp.costSource", "ulp.storedCost",
        "ulp.gitBranch", "ulp.attribution.kind", "ulp.attribution.ref", "ulp.attribution.confidence", "ulp.eventIndex",
      ],
      dropped: [...new Set(dropped)],
      buckets: "not transported — ULP consumers recompute from events",
    },
  };
}

// OTLP/JSON → purified ULP bundle. Validates nothing itself beyond shape;
// the ingest pipeline's negotiate+validate does that on the way in.
export function fromOtlp(otlp) {
  if (!otlp || !Array.isArray(otlp.resourceSpans) || !otlp.resourceSpans.length) {
    throw new Error("not OTLP/JSON: no resourceSpans[]");
  }
  const events = [];
  let deviceId = null, generatedAt = null, ulpVersion = null;
  for (const rs of otlp.resourceSpans) {
    const res = attrsToMap(rs.resource?.attributes);
    deviceId = deviceId || res["ulp.deviceId"] || "unknown-device";
    generatedAt = generatedAt || res["ulp.generatedAt"] || new Date(0).toISOString();
    ulpVersion = ulpVersion || res["ulp.ulpVersion"] || "1.0";
    for (const ss of rs.scopeSpans || []) {
      for (const span of ss.spans || []) {
        const a = attrsToMap(span.attributes);
        const tsStart = Number(span.startTimeUnixNano || 0);
        const tok = {
          input: Number(a["gen_ai.usage.input_tokens"] || 0),
          output: Number(a["gen_ai.usage.output_tokens"] || 0),
          cacheWrite: Number(a["gen_ai.usage.cache_write.input_tokens"] || 0),
          cacheRead: Number(a["gen_ai.usage.cache_read.input_tokens"] || 0),
          reasoning: Number(a["gen_ai.usage.reasoning.output_tokens"] || 0),
        };
        const ev = {
          agent: a["ulp.agent"] ?? "unknown",
          sessionId: a["gen_ai.conversation.id"] ?? "unknown",
          model: a["gen_ai.request.model"] ?? "unknown",
          repo: a["ulp.repo"] ?? "(unknown)",
          date: a["ulp.date"] ?? "unknown",
          ts: tsStart ? Math.round(tsStart / 1e6) : null,
          tokens: tok,
          storedCost: typeof a["ulp.storedCost"] === "number" ? a["ulp.storedCost"] : null,
          cost: typeof a["ulp.cost"] === "number" ? a["ulp.cost"] : null,
          costSource: a["ulp.costSource"] ?? (a["ulp.cost"] == null ? "unpriced" : "estimate"),
          gitBranch: a["ulp.gitBranch"] ?? null,
        };
        if (a["ulp.attribution.kind"]) {
          ev.attribution = {
            kind: a["ulp.attribution.kind"],
            ref: a["ulp.attribution.ref"],
            confidence: a["ulp.attribution.confidence"],
          };
        }
        events.push({ __idx: Number(a["ulp.eventIndex"] || events.length), ev });
      }
    }
  }
  // session order is identity-relevant (§E.2 index-within-session): restore
  // the producer's per-session numbering before regrouping by session.
  events.sort((x, y) => x.__idx - y.__idx);
  const ordered = [];
  const seen = new Map();
  for (const { ev } of events) {
    const want = seen.get(`${ev.agent}|${ev.sessionId}`) || 0;
    seen.set(`${ev.agent}|${ev.sessionId}`, want + 1);
    ordered.push(ev);
  }
  const ledger = aggregateEvents(ordered, { includeEvents: true });
  const doc = toUlpDocument({
    specVersion: "2.0",
    generatedAt,
    deviceId,
    ...ledger,
    events: ordered, // raw events, not ledger's unit-stamped copies
  });
  doc.ulpVersion = ulpVersion || "1.0";
  return doc;
}
