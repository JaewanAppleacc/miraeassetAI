// FactStore / FactProvenanceValidator (CLAUDE.md section 5). Mirrors
// citation-validator.mjs's EvidenceStore, applied to Facts instead of
// Evidence: the trusted, human-reviewed Fact store is the ONLY source of
// verification_status — nothing a Flow supplies about its own calculation
// inputs is ever treated as authoritative. Fail-closed with no adapter
// (FACT_STORE_UNAVAILABLE, never FACT_NOT_FOUND — "no store" and "not
// found" are different facts), bound to BOTH the corpus_snapshot_id and
// the fact_coverage_snapshot_id this request is running against (Fact
// usability is governed by fact-coverage-snapshot.schema.json, a distinct
// concept from the corpus snapshot — see domain/interfaces/
// fact-coverage-snapshot.schema.json), and every field of the canonical
// Fact projection — value, unit, scope, value_status, AND the temporal
// fields known_at/valid_from/valid_to — must match the stored record
// exactly before a fact is usable. A caller cannot supply its own
// favorable valid_to and have it silently accepted.
//
// CANONICAL FIELD NAMES: the stored record mirrors semantic-bundle.schema.json's
// Fact $def, including `normalized_value` (not `value`). The one explicit,
// code-visible translation into Calculator's own CalculationInput shape
// (which keeps `value` — see agent-runtime.mjs) is projectFactToCalculationInput
// below; nothing else in this module renames fields on the way through.
//
// KNOWN LIMITATION: no real adapter is implemented yet — there is no
// wiring to an actual VERIFIED Fact store/DB in this repo (BLOCKED_BY_
// HUMAN_REVIEW per domain/HANDOFF.md).

import { abortReason, RequestAbortedError } from "./abortable.mjs";

export const FACT_STORE_CODES = Object.freeze([
  "FACT_STORE_UNAVAILABLE",
  "FACT_NOT_FOUND",
  "FACT_SNAPSHOT_MISMATCH",
  "FACT_COVERAGE_SNAPSHOT_MISMATCH",
  "FACT_VALUE_MISMATCH",
  "FACT_UNIT_MISMATCH",
  "FACT_SCOPE_MISMATCH",
  "FACT_VALUE_STATUS_MISMATCH",
  "FACT_TEMPORAL_MISMATCH",
  "UNVERIFIED_DATA_FORBIDDEN",
]);

// The canonical Fact record shape (semantic-bundle.schema.json's Fact
// $def field names) projected into Calculator's CalculationInput shape.
// This is the ONLY place `normalized_value` becomes `value` — every check
// in this module compares against this projection, never against the raw
// stored record's own field names, so a store field silently missing (or
// misnamed) can't slip past as a match.
export function projectFactToCalculationInput(record) {
  return {
    fact_id: record?.fact_id,
    value: record?.normalized_value,
    unit: record?.unit,
    scope: record?.scope,
    value_status: record?.value_status,
    known_at: record?.known_at,
    valid_from: record?.valid_from,
    valid_to: record?.valid_to,
  };
}

// `context` pins the corpus_snapshot_id AND fact_coverage_snapshot_id this
// request is actually running against — the same pinning pattern
// createDocumentStore/createEvidenceStore use, extended with the second
// snapshot dimension that specifically governs Fact usability. `signal`
// (the request-scoped AbortSignal, if any — see abortable.mjs) is bound
// via closure and passed to the adapter as a SEPARATE second argument,
// never merged into `factId`. Checked immediately before the adapter call
// — this store can be used directly, not only through agent-runtime.mjs's
// wrapAsync pre-check, so it needs its own guard. A RequestAbortedError is
// thrown here — a deliberate, narrow exception to this module's usual
// { ok: false, code } return convention, so the TIMEOUT/CLIENT_DISCONNECT
// distinction survives up to ExecutionTrace.fallback_reason instead of
// collapsing into a generic FACT_STORE_UNAVAILABLE.
export function createFactStore(adapter = null, context = {}, signal) {
  return {
    // Returns { ok: true, record } or { ok: false, code }.
    async resolve(factId) {
      if (!adapter) return { ok: false, code: "FACT_STORE_UNAVAILABLE" };
      if (signal?.aborted) throw new RequestAbortedError(abortReason(signal));

      let envelope;
      try {
        envelope = await adapter.getFact(factId, { signal });
      } catch (error) {
        if (error instanceof RequestAbortedError) throw error;
        return { ok: false, code: "FACT_STORE_UNAVAILABLE" };
      }

      const record = envelope?.record;
      if (!record || record.fact_id !== factId) {
        return { ok: false, code: "FACT_NOT_FOUND" };
      }
      if (envelope.corpus_snapshot_id !== context?.corpus_snapshot_id) {
        return { ok: false, code: "FACT_SNAPSHOT_MISMATCH" };
      }
      if (envelope.fact_coverage_snapshot_id !== context?.fact_coverage_snapshot_id) {
        return { ok: false, code: "FACT_COVERAGE_SNAPSHOT_MISMATCH" };
      }
      return { ok: true, record };
    },
  };
}

export function createFactProvenanceValidator(factStore) {
  return {
    // Returns { ok: true } or { ok: false, code }. Checks every input in
    // order and stops at the first failure — one unresolvable fact fails
    // the whole calculation input set.
    async check(inputs) {
      for (const input of inputs) {
        const resolution = await factStore.resolve(input.fact_id);
        if (!resolution.ok) return resolution;

        const projected = projectFactToCalculationInput(resolution.record);
        if (projected.value !== input.value) return { ok: false, code: "FACT_VALUE_MISMATCH" };
        if ((projected.unit ?? null) !== (input.unit ?? null)) return { ok: false, code: "FACT_UNIT_MISMATCH" };
        if ((projected.scope ?? null) !== (input.scope ?? null)) return { ok: false, code: "FACT_SCOPE_MISMATCH" };
        if (projected.value_status !== input.value_status) return { ok: false, code: "FACT_VALUE_STATUS_MISMATCH" };
        if (
          (projected.known_at ?? null) !== (input.known_at ?? null) ||
          (projected.valid_from ?? null) !== (input.valid_from ?? null) ||
          (projected.valid_to ?? null) !== (input.valid_to ?? null)
        ) {
          return { ok: false, code: "FACT_TEMPORAL_MISMATCH" };
        }
        if (resolution.record.verification_status !== "VERIFIED") return { ok: false, code: "UNVERIFIED_DATA_FORBIDDEN" };
      }
      return { ok: true };
    },
  };
}
