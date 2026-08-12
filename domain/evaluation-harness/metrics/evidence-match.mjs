// Shared evidence-matching helper for both closed-metric.mjs and
// open-metric.mjs. A retrieved_context entry is jsonValue-shaped on the
// wire (final-response.schema.json), so its fields are whatever the
// answering Flow chose to populate — this defensively reads only the
// conventional evidence field names already used throughout this repo's
// Evidence artifacts (evidence_id/document_id/source_locator/quoted_text).
//
// Priority: if a context entry carries an evidence_id, that is the
// authoritative identity check against this slot's real evidence_id set
// (from Gold's extensions.evidence_verification). A context entry with an
// evidence_id that does NOT match is never allowed to fall through to the
// weaker document_id+source_locator check — that would let a wrong
// evidence_id "pass" via a coincidental locator match.
//
// A matching evidence_id is NOT unconditionally trusted, either: if the
// same context entry also asserts document_id/source_locator/quoted_text,
// those must not CONTRADICT what Gold's evidence_verification record for
// that evidence_id actually says (document_id, canonical_source_locator,
// quote_sha256). A Flow that echoes a real evidence_id alongside a
// different document/locator/quote (e.g. a bug that mislabels evidence, or
// an adversarial response trying to borrow a valid id's trust) must not
// pass just because the id string matched.
//
// When no evidence_id is present on the wire at all, the match must be
// document_id + source_locator + the quoted text itself (quoted_text or
// evidence_span) all agreeing with one acceptable_source — matching
// document_id+source_locator alone would let a different value from the
// same block/cell silently pass.
import { createHash } from "node:crypto";

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// evidence_id -> the Gold-recognized evidence_verification record for this
// slot_name (not just the bare id set), so a matching id can still be
// cross-checked against what Gold actually knows about it.
function relevantEvidenceVerifications(goldExtensions, slotName) {
  const verification = goldExtensions?.evidence_verification;
  const map = new Map();
  if (!Array.isArray(verification)) return map;
  for (const entry of verification) {
    if (entry && entry.slot_name === slotName && typeof entry.evidence_id === "string") {
      map.set(entry.evidence_id, entry);
    }
  }
  return map;
}

// Returns true if the wire context's own document_id/source_locator/
// quoted_text (only the fields it actually provides) contradict the Gold
// record for this evidence_id. Missing fields on the wire are not treated
// as contradictions — this only catches an actual disagreement, never
// penalizes a context entry for being terse.
function contradictsProvenance(ctx, verification) {
  if (typeof ctx.document_id === "string" && ctx.document_id !== verification.document_id) {
    return true;
  }
  const canonicalLocator = verification.canonical_source_locator;
  if (typeof ctx.source_locator === "string" && typeof canonicalLocator === "string" && ctx.source_locator !== canonicalLocator) {
    return true;
  }
  const quotedText = typeof ctx.quoted_text === "string" ? ctx.quoted_text : typeof ctx.evidence_span === "string" ? ctx.evidence_span : undefined;
  if (quotedText !== undefined && typeof verification.quote_sha256 === "string") {
    if (sha256Hex(quotedText) !== verification.quote_sha256) return true;
  }
  return false;
}

// Returns true only if some context entry proves this slot per the rules
// above. Never throws regardless of what shape the wire contexts are.
export function slotIsGrounded(slot, contexts, goldExtensions) {
  if (!slot || !Array.isArray(slot.acceptable_sources) || slot.acceptable_sources.length === 0) return false;
  const verifications = relevantEvidenceVerifications(goldExtensions, slot.slot_name);
  for (const ctx of Array.isArray(contexts) ? contexts : []) {
    if (!ctx || typeof ctx !== "object") continue;
    if (typeof ctx.evidence_id === "string" && ctx.evidence_id !== "") {
      const verification = verifications.get(ctx.evidence_id);
      if (verification && !contradictsProvenance(ctx, verification)) return true;
      continue; // evidence_id present (unrecognized OR self-contradicting) -> never fall through to the weaker check
    }
    const quotedText = typeof ctx.quoted_text === "string" ? ctx.quoted_text : ctx.evidence_span;
    if (typeof quotedText !== "string") continue;
    for (const source of slot.acceptable_sources) {
      if (
        ctx.document_id === source.document_id &&
        ctx.source_locator === source.source_locator &&
        quotedText === source.evidence_span
      ) {
        return true;
      }
    }
  }
  return false;
}
