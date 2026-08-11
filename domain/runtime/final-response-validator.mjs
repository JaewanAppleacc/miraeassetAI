// FinalResponse v0.1 validator (CLAUDE.md section 2). The single source of
// truth for "is this a valid FinalResponse" is domain/interfaces/
// final-response.schema.json, compiled once here with the same Ajv2020 +
// ajv-formats pattern domain/runtime/retriever-store.mjs and
// domain/runtime/structured-store.mjs already use for their own request/
// result boundaries. agent-runtime.mjs's createSerializer() imports
// validateFinalResponse() rather than re-checking fields by hand, so the
// manual coercion logic there (safeString/safeArray/safePlainObject, which
// exists to COERCE malformed input into a valid shape — something a JSON
// Schema alone cannot do) and this schema-based gate can never silently
// drift apart. An external Evaluation Harness should import this same
// function (or compile the schema file itself) instead of hand-rolling its
// own response validation rules.

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import finalResponseSchema from "../interfaces/final-response.schema.json" with { type: "json" };

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateFinalResponseSchema = ajv.compile(finalResponseSchema);

// Trust-boundary hardening: `candidate` is caller-controlled, adversarial
// input, not data we already trust. Three independent failure modes have to
// be handled, not just one:
//
//   1. The Ajv-compiled validator can itself THROW instead of returning
//      false — a circular object recursed into by the schema's own
//      recursive $defs.jsonValue overflows the call stack (RangeError), and
//      a getter that throws on property access propagates that exception
//      straight out of Ajv's generated code. Neither is "invalid input
//      reported normally"; both must be caught here, not left to escape to
//      the caller.
//   2. Passing the schema is NECESSARY but not SUFFICIENT: $defs.jsonValue
//      constrains every nested value to null/boolean/finite-number/string/
//      array/object, which rules out BigInt/function/Symbol/undefined/NaN/
//      Infinity — but a schema is still just a static shape description,
//      not a live guarantee. The only real proof a value is JSON-safe is
//      running the actual serializer, so a real JSON.stringify()/JSON.parse()
//      round trip is a second, independent gate — also wrapped, since the
//      same throwing-getter shape that could defeat Ajv could just as
//      easily defeat JSON.stringify on its own.
//   3. Even a clean stringify/parse round trip is not enough: a `toJSON()`
//      method (including a non-enumerable one Ajv never saw while walking
//      `candidate`'s own properties) can make JSON.stringify() substitute a
//      completely different value onto the wire. So the actual parsed wire
//      value is schema-checked again, using this same compiled validator —
//      the object that got schema-checked and the object that gets shipped
//      must be proven to be the same shape, not just the one Ajv happened
//      to see first.
//
// A value is valid only if the raw candidate passes this check, the
// stringify/parse round trip succeeds, AND the parsed wire value passes
// this same check too.
function safeSchemaCheck(candidate) {
  try {
    const ok = validateFinalResponseSchema(candidate);
    return ok ? { ok: true } : { ok: false, errors: validateFinalResponseSchema.errors ?? [] };
  } catch (error) {
    return { ok: false, thrown: error };
  }
}

// candidate.toJSON() (even a non-enumerable one Ajv never sees while
// walking candidate's own properties) can make JSON.stringify() serialize a
// completely different value than the one that was just schema-checked. So
// passing the raw-candidate schema check is necessary but not sufficient:
// the actual parsed wire value has to be schema-checked too. This helper
// only proves stringify/parse round-trip cleanly; it does not judge shape.
function safeStringifyThenParse(candidate) {
  let serialized;
  try {
    serialized = JSON.stringify(candidate);
  } catch (error) {
    return { ok: false, thrown: error };
  }
  if (typeof serialized !== "string") {
    return { ok: false, message: "JSON.stringify did not return a string (a toJSON() may have returned undefined)" };
  }
  try {
    return { ok: true, parsed: JSON.parse(serialized) };
  } catch (error) {
    return { ok: false, thrown: error };
  }
}

function describeThrown(error) {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return "(unprintable thrown value)";
  }
}

// Returns [] when valid, otherwise a list of human-readable error strings —
// same shape as retriever-store.mjs's validateRetrievalRequest. Never
// throws, regardless of what `candidate` is. Valid requires ALL of: the raw
// candidate satisfies the schema, JSON.stringify(candidate) succeeds and
// returns a string, JSON.parse of that string succeeds, and the resulting
// parsed wire value ALSO satisfies the same schema (reusing safeSchemaCheck
// for both checks, so there is exactly one schema-checking code path).
export function validateFinalResponse(candidate) {
  const rawSchemaResult = safeSchemaCheck(candidate);
  if (!rawSchemaResult.ok) {
    if (rawSchemaResult.thrown) return [`schema validation threw: ${describeThrown(rawSchemaResult.thrown)}`];
    return rawSchemaResult.errors.map((error) => `${error.instancePath || "(root)"} ${error.message}`);
  }

  const wireResult = safeStringifyThenParse(candidate);
  if (!wireResult.ok) {
    if (wireResult.thrown) return [`JSON.stringify/JSON.parse failed: ${describeThrown(wireResult.thrown)}`];
    return [wireResult.message];
  }

  const wireSchemaResult = safeSchemaCheck(wireResult.parsed);
  if (!wireSchemaResult.ok) {
    if (wireSchemaResult.thrown) return [`parsed wire value schema validation threw: ${describeThrown(wireSchemaResult.thrown)}`];
    return wireSchemaResult.errors.map((error) => `(wire) ${error.instancePath || "(root)"} ${error.message}`);
  }

  return [];
}

// A candidate is valid only if it satisfies final-response.schema.json, is
// actually JSON.stringify/JSON.parse round-trippable, AND the resulting
// parsed wire value also satisfies final-response.schema.json — never
// throws.
export function isValidFinalResponse(candidate) {
  return validateFinalResponse(candidate).length === 0;
}
