#!/usr/bin/env python3
"""ULP reference reader — implementation #2 of the Usage Ledger Protocol.

Stdlib only. Zero burn-specific knowledge: it loads ulp/schema-1.0.json and
walks it with the same vocabulary the burn CLI's validator supports. Its job
is existence proof: validating and aggregating a ULP document does not
require Node, burn, or any hidden state.

usage:
  ulp-reader.py validate <bundle.json> [--schema S.json] [--relax]
  ulp-reader.py totals   <bundle.json> [more...] [--schema S.json]

`validate` prints "OK" or one error per line (exit 2 on any error).
`totals` merges by the protocol identity tuple
(deviceId, agent, sessionId, index-within-session), unions the event sets,
RECOMPUTES buckets (never sums pre-aggregated rows), and prints a JSON
summary: totals + per-class source counts + repo cost map.
"""
import argparse
import json
import sys

XNS_PREFIX = "x-"
KEYWORDS = {
    "$schema", "$id", "title", "description", "$defs",
    "type", "required", "enum", "const", "pattern", "minimum",
    "properties", "patternProperties", "additionalProperties", "items",
    "anyOf", "$ref",
}


def type_ok(value, t):
    if t == "object":
        return isinstance(value, dict)
    if t == "array":
        return isinstance(value, list)
    if t == "string":
        return isinstance(value, str)
    if t == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if t == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if t == "boolean":
        return isinstance(value, bool)
    if t == "null":
        return value is None
    return False


import re


def walk(value, schema, at, root, err, relax):
    if schema is True or schema is None:
        return
    if schema is False:
        return err(f"{at}: value not allowed")
    if "$ref" in schema:
        node = root
        for part in schema["$ref"].lstrip("#/").split("/"):
            node = node.get(part) if isinstance(node, dict) else None
        if node is None:
            raise SystemExit(f"ulp schema: unresolvable $ref {schema['$ref']}")
        schema = node

    if "anyOf" in schema:
        notes = []
        for sub in schema["anyOf"]:
            probe = []
            walk(value, sub, at, root, probe.append, relax)
            if not probe:
                return
            notes.extend(probe)
        return err(f"{at}: matches no anyOf branch ({'; '.join(notes[:2])})")

    t = schema.get("type")
    if t is not None:
        types = t if isinstance(t, list) else [t]
        if not any(type_ok(value, x) for x in types):
            return err(f"{at}: expected {'|'.join(types)}, got {type(value).__name__}")

    if "enum" in schema and value not in schema["enum"]:
        err(f'{at}: {json.dumps(value)} not in enum {schema["enum"]}')
    if "const" in schema and value != schema["const"]:
        err(f"{at}: must equal {json.dumps(schema['const'])}")
    if "pattern" in schema and isinstance(value, str) and not re.search(schema["pattern"], value):
        err(f'{at}: "{value[:40]}" does not match pattern {schema["pattern"]}')
    if "minimum" in schema and isinstance(value, (int, float)) and value < schema["minimum"]:
        err(f"{at}: {value} < minimum {schema['minimum']}")

    if isinstance(value, list) and "items" in schema:
        for i, v in enumerate(value):
            walk(v, schema["items"], f"{at}[{i}]", root, err, relax)

    if isinstance(value, dict):
        for req in schema.get("required", []):
            if req not in value:
                err(f'{at}: missing required "{req}"')
        props = schema.get("properties", {})
        pprops = schema.get("patternProperties", {})
        for k, v in value.items():
            handled = False
            if k in props:
                walk(v, props[k], f"{at}.{k}", root, err, relax)
                handled = True
            else:
                for rx, sub in pprops.items():
                    if re.search(rx, k):
                        walk(v, sub, f"{at}.{k}", root, err, relax)
                        handled = True
                        break
            if not handled and schema.get("additionalProperties") is False \
                    and not relax and not k.startswith(XNS_PREFIX):
                err(f"{at}.{k}: unknown field (extensions must be under x-<impl>-)")


def load_schema(path):
    with open(path) as f:
        return json.load(f)


def validate_file(bundle_path, schema, relax=False):
    with open(bundle_path) as f:
        doc = json.load(f)
    errors = []
    walk(doc, schema, "$", schema, errors.append, relax)
    return errors


# ---- merge (protocol §6: union identity, recompute-not-sum) -----------------

def merge_totals(docs):
    by_identity = {}
    for doc in docs:
        dev = doc.get("deviceId", "unknown-device")
        counters = {}
        for ev in doc.get("events", []):
            sk = f'{dev}|{ev["agent"]}|{ev["sessionId"]}'
            idx = counters.get(sk, 0)
            counters[sk] = idx + 1
            by_identity.setdefault(f"{sk}|{idx}", ev)
    totals = {
        "events": 0, "cost": 0.0, "store": 0.0, "estimate": 0.0,
        "unpricedEvents": 0,
        "tokens": {k: 0 for k in ("input", "output", "cacheWrite", "cacheRead", "reasoning")},
    }
    sources = {"store": 0, "estimate": 0, "unpriced": 0}
    repos = {}
    for ev in by_identity.values():
        cost = ev.get("cost")
        cls = ev.get("costSource", "unpriced")
        sources[cls] = sources.get(cls, 0) + 1
        totals["events"] += 1
        if cls != "unpriced":
            totals["cost"] += cost
        if cls == "store":
            totals["store"] += cost
        if cls == "estimate":
            totals["estimate"] += cost
        if cls == "unpriced":
            totals["unpricedEvents"] += 1
        for k in totals["tokens"]:
            totals["tokens"][k] += ev.get("tokens", {}).get(k, 0) or 0
        r = repos.setdefault(ev.get("repo", "(unknown)"), {"cost": 0.0, "events": 0})
        r["events"] += 1
        if cls != "unpriced":
            r["cost"] += cost
    prompt = totals["tokens"]["input"] + totals["tokens"]["cacheWrite"] + totals["tokens"]["cacheRead"]
    totals["cacheHit"] = (totals["tokens"]["cacheRead"] / prompt) if prompt else 0
    return {"totals": totals, "sources": sources, "repos": repos}


def near(a, b, eps=1e-9):
    return abs(a - b) < eps


def run_vector(vector, schema):
    """Returns a list of failure notes ([] == pass). Mirrors src/ulp/conformance.js."""
    notes = []
    kind = vector["kind"]
    if kind == "validate":
        ok = not validate_doc(vector["bundle"], schema)
        if ok != vector["expect"]["ok"]:
            notes.append(f"validate -> {'accepted' if ok else 'rejected'}, expected {vector['expect']['ok']}")
    elif kind == "validate-both":
        strict = not validate_doc(vector["bundle"], schema)
        relaxed = not validate_doc(vector["bundle"], schema, relax=True)
        if strict != vector["expect"]["strictOk"]:
            notes.append(f"strict validate -> {strict}, expected {vector['expect']['strictOk']}")
        if relaxed != vector["expect"]["relaxOk"]:
            notes.append(f"relax validate -> {relaxed}, expected {vector['expect']['relaxOk']}")
    elif kind == "merge":
        def check(t, prefix=""):
            exp = vector["expect"]["totals"]
            if exp["events"] != t["totals"]["events"]:
                notes.append(f"{prefix}events {t['totals']['events']} != {exp['events']}")
            if not near(exp["cost"], t["totals"]["cost"]):
                notes.append(f"{prefix}cost {t['totals']['cost']} != {exp['cost']}")
            for cls in ("store", "estimate", "unpriced"):
                if exp["sources"][cls] != t["sources"][cls]:
                    notes.append(f"{prefix}sources.{cls} {t['sources'][cls]} != {exp['sources'][cls]}")
            for repo, cost in exp.get("repos", {}).items():
                got = t["repos"].get(repo, {}).get("cost", 0.0)
                if not near(cost, got):
                    notes.append(f"{prefix}repos.{repo} {got} != {cost}")
            if len(exp.get("repos", {})) != len(t["repos"]):
                notes.append(f"{prefix}repos count {len(t['repos'])} != {len(exp['repos'])}")
            if "cacheHit" in exp and not near(exp["cacheHit"], t["totals"]["cacheHit"]):
                notes.append(f"{prefix}cacheHit {t['totals']['cacheHit']} != {exp['cacheHit']}")
        check(merge_totals(vector["bundles"]))
        if vector.get("expectSameReversed"):
            check(merge_totals(list(reversed(vector["bundles"]))), prefix="reversed order: ")
    else:
        notes.append(f"unknown vector kind {kind!r}")
    return notes


def validate_doc(doc, schema, relax=False):
    errors = []
    walk(doc, schema, "$", schema, errors.append, relax)
    return errors


def main():
    ap = argparse.ArgumentParser(prog="ulp-reader", description="ULP 1.0 reference reader (stdlib only)")
    ap.add_argument("--schema", default=None, help="path to a ULP JSON Schema (default: ../schema-1.0.json)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("validate")
    v.add_argument("bundle")
    v.add_argument("--relax", action="store_true", help="ignore unknown fields (newer ULP minor)")
    m = sub.add_parser("totals")
    m.add_argument("bundles", nargs="+")
    c = sub.add_parser("conform")
    c.add_argument("vectors_dir", nargs="?", default=None, help="dir of vector JSON (default: ../conformance/vectors)")
    args = ap.parse_args()

    import os
    here = os.path.dirname(os.path.abspath(__file__))
    schema_path = args.schema or os.path.join(here, "..", "schema-1.0.json")

    if args.cmd == "validate":
        errors = validate_file(args.bundle, load_schema(schema_path), relax=args.relax)
        if errors:
            for e in errors:
                print(e)
            sys.exit(2)
        print("OK")
    elif args.cmd == "totals":
        docs = [json.load(open(p)) for p in args.bundles]
        print(json.dumps(merge_totals(docs), indent=2))
    else:
        import glob
        vec_dir = args.vectors_dir or os.path.join(here, "..", "conformance", "vectors")
        schema = load_schema(schema_path)
        files = sorted(glob.glob(os.path.join(vec_dir, "*.json")))
        failed = 0
        print(f"ULP conformance kit — {len(files)} vectors (ulp-reader.py)")
        for f in files:
            vec = json.load(open(f))
            notes = run_vector(vec, schema)
            mark = "PASS" if not notes else "FAIL"
            failed += bool(notes)
            print(f"  {mark} {vec['id']} {vec['name']}")
            for n in notes:
                print(f"        {n}")
        print("  all vectors green" if not failed else f"  {failed} FAILING")
        sys.exit(2 if failed else 0)


if __name__ == "__main__":
    main()
