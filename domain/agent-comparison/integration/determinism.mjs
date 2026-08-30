// Turn P3: deterministic hashing helpers for ComparisonRecord.
// answer_sha256/execution_trace_sha256 exist so a comparison artifact never
// stores raw answer text or a raw ExecutionTrace (which would otherwise
// carry think_trace-adjacent content) -- only a content hash, plus
// whatever already-aggregated counts/flags TelemetryEvent provides.
//
// latency_ms (both the top-level ExecutionTrace field and every per-call
// `started_at`/`latency_ms` inside `operations`/`tool_calls`/`hcx_calls`)
// is a real wall-clock OBSERVATION -- it varies run to run even for
// byte-identical input, by design (see domain/runtime/agent-runtime.mjs's
// TraceRecorder). computeExecutionTraceSha256 strips every such volatile
// key recursively BEFORE hashing, so two runs of the SAME variant over the
// SAME input produce the SAME execution_trace_sha256 even though their
// real latency differs -- this is exactly what
// tests/agent-comparison-integration-comparison.test.mjs's execution-order
// independence check relies on.
import { createHash } from "node:crypto";

const VOLATILE_KEYS = Object.freeze(new Set(["latency_ms", "started_at"]));

function stripVolatile(value) {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (VOLATILE_KEYS.has(key)) continue;
      out[key] = stripVolatile(item);
    }
    return out;
  }
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function sha256Hex(text) {
  return createHash("sha256").update(typeof text === "string" ? text : "", "utf8").digest("hex");
}

// Exported separately (not just the hash) so a test can assert on the
// canonicalized SHAPE directly when a hash mismatch needs a human-readable
// diff, without re-deriving the stripping/sorting logic itself.
export function canonicalizeExecutionTrace(executionTrace) {
  return canonicalize(stripVolatile(executionTrace ?? {}));
}

export function computeExecutionTraceSha256(executionTrace) {
  return sha256Hex(JSON.stringify(canonicalizeExecutionTrace(executionTrace)));
}

export function computeAnswerSha256(answerText) {
  return sha256Hex(answerText);
}
