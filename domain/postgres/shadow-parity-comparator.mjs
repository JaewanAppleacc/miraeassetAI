// Turn N3: a small, dependency-free comparison module for shadow/read-parity
// checks between the portable bundle-backed read path (authoritative
// baseline) and the PostgreSQL Reference Repository read path (shadow).
//
// This module does NOT read a bundle, does NOT connect to PostgreSQL, and
// does NOT import configured-seed-runtime.mjs or any production wiring --
// it only compares two already-fetched, in-memory record arrays/values a
// caller hands it. It never decides which side is "right": PostgreSQL is
// always treated as the shadow, the bundle-backed result is always treated
// as the baseline, and this module reports a divergence -- it never
// substitutes one for the other. It is intentionally NOT a query planner,
// NOT a retriever, and NOT a generic diffing framework -- just the smallest
// canonicalize+compare+report primitive the required parity tests (and any
// future Agent implementation wanting the same shadow check) can reuse.
//
// Mismatch reports are deliberately truncated (see truncateForReport) and
// carry only the first differing field path, never a full payload dump --
// this is a comparison utility that may run against real Evidence/Fact
// text, so its own failure messages must not become a second place to leak
// large amounts of raw corpus text.

const DEFAULT_MAX_REPORT_CHARS = 200;

export class ShadowParityMismatchError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "ShadowParityMismatchError";
    this.detail = detail;
  }
}

function truncateForReport(value, maxChars = DEFAULT_MAX_REPORT_CHARS) {
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = "undefined";
  return text.length > maxChars ? `${text.slice(0, maxChars)}...(truncated, ${text.length} chars total)` : text;
}

// Returns the first differing { path, baseline, shadow } (untruncated) or
// null if the two values are deep-equal. NaN-safe (NaN === NaN for this
// module's purposes, matching structuredClone/JSON round-trip semantics
// records already go through). Object key order never matters -- keys are
// compared as sets, not compared positionally -- only VALUES at each path
// matter, which is the correct notion of "canonical deep-equal" for JSON-
// shaped records that never carry semantically-meaningful key order.
function firstFieldDiff(baseline, shadow, path = "") {
  if (baseline === shadow) return null;
  if (typeof baseline === "number" && typeof shadow === "number" && Number.isNaN(baseline) && Number.isNaN(shadow)) return null;
  const bothObjects = baseline !== null && shadow !== null && typeof baseline === "object" && typeof shadow === "object";
  if (!bothObjects) return { path: path || "(root)", baseline, shadow };

  const baselineIsArray = Array.isArray(baseline);
  const shadowIsArray = Array.isArray(shadow);
  if (baselineIsArray !== shadowIsArray) return { path: path || "(root)", baseline, shadow };
  if (baselineIsArray && baseline.length !== shadow.length) {
    return { path: `${path || "(root)"}.length`, baseline: baseline.length, shadow: shadow.length };
  }

  const keys = new Set([...Object.keys(baseline), ...Object.keys(shadow)]);
  for (const key of keys) {
    const childPath = path ? `${path}.${key}` : String(key);
    const diff = firstFieldDiff(baseline[key], shadow[key], childPath);
    if (diff) return diff;
  }
  return null;
}

// Compares two ID lists (order-independent): every ID present in baseline
// but absent from shadow ("missing"), every ID present in shadow but absent
// from baseline ("extra"), and duplicate-within-a-single-side counts for
// each side independently -- a duplicate on either side is always a defect,
// never averaged away by the other side happening to also have one.
export function compareIdSets({ baselineIds, shadowIds }) {
  const baseSet = new Set(baselineIds);
  const shadowSet = new Set(shadowIds);
  const missing = [...baseSet].filter((id) => !shadowSet.has(id));
  const extra = [...shadowSet].filter((id) => !baseSet.has(id));
  const baselineDuplicateCount = baselineIds.length - baseSet.size;
  const shadowDuplicateCount = shadowIds.length - shadowSet.size;
  return Object.freeze({
    ok: missing.length === 0 && extra.length === 0 && baselineDuplicateCount === 0 && shadowDuplicateCount === 0,
    missing: Object.freeze(missing),
    extra: Object.freeze(extra),
    baselineDuplicateCount,
    shadowDuplicateCount,
  });
}

// Compares two record arrays for one role/query. `idOf` extracts a
// record's identity (defaults to `record.record_id`, the StructuredQuery
// descriptor shape both reference-repository.mjs and
// seed-structured-query-adapter.mjs already return; pass an explicit `idOf`
// for raw payload shapes like `{ fact_id }`/`{ evidence_id }`).
//
// orderMatters=false (the default) is the ID-set-then-canonical-sort mode
// required for any query whose row order is not itself part of a frozen
// contract: both sides' records are grouped by ID and compared payload-by-
// payload, independent of the order either side actually returned them in.
// orderMatters=true additionally requires the two arrays to be in the
// EXACT same order, position by position -- use this only where returned
// order is itself a real, intentionally-mirrored behavior (see
// reference-repository.mjs's sortRecords vs seed-structured-query-adapter.mjs's
// identical inline sort) -- never set it to true to paper over an
// unspecified order and call that "the contract".
export function compareRecordSets({ role, query, baseline, shadow, orderMatters = false, idOf = (record) => record.record_id }) {
  const baselineIds = baseline.map(idOf);
  const shadowIds = shadow.map(idOf);
  const idSetResult = compareIdSets({ baselineIds, shadowIds });
  if (!idSetResult.ok) {
    return Object.freeze({
      ok: false, role, query,
      summary: `id set mismatch: missing=${idSetResult.missing.length} extra=${idSetResult.extra.length} `
        + `baselineDuplicates=${idSetResult.baselineDuplicateCount} shadowDuplicates=${idSetResult.shadowDuplicateCount}`,
      idSetResult, firstMismatch: null,
    });
  }

  if (orderMatters) {
    for (let i = 0; i < baseline.length; i += 1) {
      if (baselineIds[i] !== shadowIds[i]) {
        return Object.freeze({
          ok: false, role, query, summary: `order mismatch at index ${i}`, idSetResult,
          firstMismatch: { id: null, path: `[${i}]`, baseline: truncateForReport(baselineIds[i]), shadow: truncateForReport(shadowIds[i]) },
        });
      }
      const diff = firstFieldDiff(baseline[i], shadow[i]);
      if (diff) {
        return Object.freeze({
          ok: false, role, query, summary: `payload mismatch at id "${baselineIds[i]}" (index ${i})`, idSetResult,
          firstMismatch: { id: baselineIds[i], path: diff.path, baseline: truncateForReport(diff.baseline), shadow: truncateForReport(diff.shadow) },
        });
      }
    }
    return Object.freeze({ ok: true, role, query, summary: `${baseline.length} records match (order-sensitive)`, idSetResult });
  }

  const shadowById = new Map(shadow.map((record) => [idOf(record), record]));
  for (const baseRecord of baseline) {
    const id = idOf(baseRecord);
    const diff = firstFieldDiff(baseRecord, shadowById.get(id));
    if (diff) {
      return Object.freeze({
        ok: false, role, query, summary: `payload mismatch at id "${id}"`, idSetResult,
        firstMismatch: { id, path: diff.path, baseline: truncateForReport(diff.baseline), shadow: truncateForReport(diff.shadow) },
      });
    }
  }
  return Object.freeze({ ok: true, role, query, summary: `${baseline.length} records match (ID-set + canonical payload)`, idSetResult });
}

// Compares two single-record lookups (getFact/getEvidence/getEvent/
// getRelation-shaped: a record or null). Both sides null is parity
// (shared NOT_FOUND semantics); exactly one side null, or two non-null
// values that differ, is a mismatch.
export function compareSingleRecord({ role, query, baseline, shadow }) {
  if (baseline === null && shadow === null) {
    return Object.freeze({ ok: true, role, query, summary: "both NOT_FOUND (null)" });
  }
  if (baseline === null || shadow === null) {
    return Object.freeze({
      ok: false, role, query, summary: "NOT_FOUND parity mismatch: exactly one side returned null",
      firstMismatch: { id: null, path: "(root)", baseline: truncateForReport(baseline), shadow: truncateForReport(shadow) },
    });
  }
  const diff = firstFieldDiff(baseline, shadow);
  if (diff) {
    return Object.freeze({
      ok: false, role, query, summary: "payload mismatch",
      firstMismatch: { id: null, path: diff.path, baseline: truncateForReport(diff.baseline), shadow: truncateForReport(diff.shadow) },
    });
  }
  return Object.freeze({ ok: true, role, query, summary: "match" });
}

// Throws ShadowParityMismatchError (never returns a falsy "ok" silently)
// when a comparator result is not ok -- the single call a test or an Agent
// caller needs to turn any of the compare*() results above into a hard
// failure, carrying role/query/id/field path in the message itself (never
// requiring a reader to go dig through a separate log for context) plus the
// full structured result as `.detail` for anything that wants it
// programmatically.
export function assertParity(result) {
  if (!result.ok) {
    const m = result.firstMismatch;
    const mismatchText = m ? ` firstMismatch: id=${m.id ?? "(none)"} path=${m.path} baseline=${m.baseline} shadow=${m.shadow}` : "";
    throw new ShadowParityMismatchError(
      `shadow parity mismatch -- role=${result.role ?? "?"} query=${result.query ?? "?"}: ${result.summary}${mismatchText}`,
      result,
    );
  }
  return result;
}
