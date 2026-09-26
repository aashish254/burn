// A hand-rolled validator for EXACTLY the JSON Schema vocabulary that
// ulp/schema-1.0.json uses — no dependency, ever (zero-deps law). Supported
// keywords: $ref (#/$defs only), type, required, enum, const, pattern,
// minimum, properties, patternProperties, additionalProperties (bool), items,
// anyOf. A schema using anything outside this vocabulary is a bug in our own
// schema file, caught by the unit test that asserts the vocabulary.
//
// relaxUnknown: when validating a document whose ULP minor
// is NEWER than this schema, unknown properties are ignored instead of
// rejected — "consumers MUST ignore unknown fields".

const XNS = /^x-[a-z0-9]+(-[a-z0-9]+)*$/;
const SUPPORTED_KEYWORDS = new Set([
  "$schema", "$id", "title", "description", "$defs",
  "type", "required", "enum", "const", "pattern", "minimum",
  "properties", "patternProperties", "additionalProperties", "items", "anyOf", "$ref",
]);

function typeOk(value, t) {
  switch (t) {
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "integer": return Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: return false;
  }
}

const short = (s) => (s.length > 40 ? s.slice(0, 40) + "…" : s);

export function validate(doc, schema, options = {}) {
  const relax = options.relaxUnknown === true;

  function resolve(s) {
    if (s && typeof s.$ref === "string") {
      let node = schema;
      for (const p of s.$ref.replace(/^#\//, "").split("/")) node = node?.[p];
      if (node === undefined) throw new Error(`ulp schema: unresolvable $ref ${s.$ref}`);
      return node;
    }
    return s;
  }

  function walk(value, s, at, err) {
    s = resolve(s);
    if (s === true || s === undefined) return;
    if (s === false) return err(`${at}: value not allowed`);

    if (s.anyOf) {
      const notes = [];
      let matched = false;
      for (const sub of s.anyOf) {
        const probe = [];
        walk(value, sub, at, (m) => probe.push(m));
        if (!probe.length) { matched = true; break; }
        notes.push(...probe);
      }
      if (!matched) err(`${at}: matches no anyOf branch (${notes.slice(0, 2).join("; ")})`);
      return;
    }

    if (s.type) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      if (!types.some((t) => typeOk(value, t))) {
        return err(`${at}: expected ${types.join("|")}, got ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}`);
      }
    }
    if (s.enum && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
      err(`${at}: ${JSON.stringify(value)} not in enum [${s.enum.join(", ")}]`);
    }
    if ("const" in s && JSON.stringify(s.const) !== JSON.stringify(value)) {
      err(`${at}: must equal ${JSON.stringify(s.const)}`);
    }
    if (s.pattern !== undefined && typeof value === "string" && !new RegExp(s.pattern).test(value)) {
      err(`${at}: "${short(value)}" does not match pattern ${s.pattern}`);
    }
    if (s.minimum !== undefined && typeof value === "number" && value < s.minimum) {
      err(`${at}: ${value} < minimum ${s.minimum}`);
    }

    if (Array.isArray(value) && s.items) {
      value.forEach((v, i) => walk(v, s.items, `${at}[${i}]`, err));
    }

    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const req of s.required || []) {
        if (!(req in value)) err(`${at}: missing required "${req}"`);
      }
      for (const [k, v] of Object.entries(value)) {
        let handled = false;
        if (s.properties && k in s.properties) {
          walk(v, s.properties[k], `${at}.${k}`, err);
          handled = true;
        } else {
          for (const [rx, sub] of Object.entries(s.patternProperties || {})) {
            if (new RegExp(rx).test(k)) { walk(v, sub, `${at}.${k}`, err); handled = true; break; }
          }
        }
        if (!handled && s.additionalProperties === false && !relax && !XNS.test(k)) {
          err(`${at}.${k}: unknown field (extensions must be under x-<impl>-)`);
        }
      }
    }
  }

  const errors = [];
  walk(doc, schema, "$", (m) => errors.push(m));
  return errors;
}

// Asserts our own schema stays inside the validator's vocabulary (zero-dep
// law with teeth: adding an unsupported keyword fails loudly here).
export function schemaVocabularyCheck(schema, at = "$") {
  const problems = [];
  function chk(s, path) {
    if (s === null || typeof s !== "object" || Array.isArray(s)) return; // bool schema or plain data
    for (const [k, v] of Object.entries(s)) {
      if (!SUPPORTED_KEYWORDS.has(k)) {
        problems.push(`${path}.${k}: keyword outside validator vocabulary`);
        continue;
      }
      if (k === "properties" || k === "patternProperties" || k === "$defs") {
        for (const [name, sub] of Object.entries(v || {})) chk(sub, `${path}.${k}.${name}`);
      } else if (k === "items") {
        chk(v, `${path}.items`);
      } else if (k === "anyOf" && Array.isArray(v)) {
        v.forEach((x, i) => chk(x, `${path}.anyOf[${i}]`));
      } else if (k === "additionalProperties") {
        chk(v, `${path}.additionalProperties`);
      }
    }
  }
  chk(schema, at);
  return problems;
}
