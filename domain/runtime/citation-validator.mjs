// DocumentStore / EvidenceStore / CitationValidator (CLAUDE.md section 5).
//
// Two independent, both-required checks, deliberately kept separate:
//
//   1. Raw citation check (DocumentStore): does document_id/file_id/
//      source_locator/quoted_text actually resolve against the real A
//      DocumentIR text in the pinned corpus snapshot? Read-only — A's
//      DocumentIR is never modified here, only queried through whatever
//      adapter is injected.
//   2. Human-review check (EvidenceStore): does evidence_id resolve to a
//      STORED evidence record (semantic-bundle.schema.json's Evidence
//      shape) whose own document_id/file_id/source_locator/quoted_text/
//      quote_sha256 match what's being claimed, AND whose
//      verification_status is VERIFIED? A Flow's own claimed
//      verification_status is never trusted — it doesn't even appear on
//      the request; verification_status comes only from this store.
//
// Both fail-closed the same way structured-store.mjs does: with no
// adapter wired, every lookup is a *_STORE_UNAVAILABLE, never a
// *_NOT_FOUND — "no store" and "not found" are different facts.
//
// KNOWN LIMITATION: no real adapter is implemented yet for either store —
// there is no wiring to an actual A DocumentIR loader or a real VERIFIED
// Evidence store/DB in this repo. This module only defines the
// fail-closed boundary and the resolution/matching logic a future adapter
// must satisfy; until both are wired, no EvidenceBundle can ever be
// confirmed (see agent-runtime.mjs's Validator.validateEvidence).

import { createHash } from "node:crypto";
import { abortReason, RequestAbortedError } from "./abortable.mjs";

export const CITATION_CODES = Object.freeze([
  "DOCUMENT_STORE_UNAVAILABLE",
  "DOCUMENT_NOT_FOUND",
  "SNAPSHOT_MISMATCH",
  "LOCATOR_NOT_FOUND",
  "QUOTE_MISMATCH",
  "EVIDENCE_STORE_UNAVAILABLE",
  "EVIDENCE_NOT_FOUND",
  "EVIDENCE_SNAPSHOT_MISMATCH",
  "EVIDENCE_DOCUMENT_MISMATCH",
  "EVIDENCE_LOCATOR_MISMATCH",
  "EVIDENCE_QUOTE_MISMATCH",
  "EVIDENCE_HASH_MISMATCH",
  "UNVERIFIED_DATA_FORBIDDEN",
]);

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// `context` pins the corpus_snapshot_id this request is actually running
// against — the same pinning pattern createStructuredStore uses. `signal`
// (the request-scoped AbortSignal, if any — see abortable.mjs) is bound
// via closure and passed to the adapter as a SEPARATE second argument,
// never merged into `documentId`. Checked immediately before the adapter
// call — this store can be used directly (e.g. from createCitationValidator
// standalone), not only through agent-runtime.mjs's wrapAsync pre-check, so
// it needs its own guard. A RequestAbortedError is thrown here — a
// deliberate, narrow exception to this module's usual { ok: false, code }
// return convention, so the TIMEOUT/CLIENT_DISCONNECT distinction survives
// up to ExecutionTrace.fallback_reason instead of collapsing into a generic
// DOCUMENT_STORE_UNAVAILABLE.
export function createDocumentStore(adapter = null, context = {}, signal) {
  return {
    // Returns { ok: true, documentIR } or { ok: false, code }.
    async resolve(documentId) {
      if (!adapter) return { ok: false, code: "DOCUMENT_STORE_UNAVAILABLE" };
      if (signal?.aborted) throw new RequestAbortedError(abortReason(signal));

      let documentIR;
      try {
        documentIR = await adapter.getDocument(documentId, { signal });
      } catch (error) {
        // A real adapter that itself observes `signal` mid-flight and
        // aborts is reporting the same condition as the pre-check above —
        // preserve it rather than collapsing it into a generic failure.
        if (error instanceof RequestAbortedError) throw error;
        return { ok: false, code: "DOCUMENT_STORE_UNAVAILABLE" };
      }

      if (!documentIR || documentIR.document_id !== documentId) {
        return { ok: false, code: "DOCUMENT_NOT_FOUND" };
      }
      if (documentIR.corpus_snapshot_id !== context?.corpus_snapshot_id) {
        return { ok: false, code: "SNAPSHOT_MISMATCH" };
      }
      return { ok: true, documentIR };
    },
  };
}

// The trusted, human-reviewed Evidence store (semantic-bundle.schema.json
// shape). This is the *only* source of verification_status — nothing a
// Flow supplies about its own evidence is ever treated as authoritative.
//
// `context` pins the corpus_snapshot_id this request is actually running
// against, same as createDocumentStore. Evidence reviewed against a
// different (e.g. older) processing snapshot is not implicitly valid for
// the current one — the semantic-bundle Evidence record itself is never
// changed to carry this; the adapter's response is wrapped in an envelope
// ({ corpus_snapshot_id, record }) that this store checks and then discards.
// `signal`: see createDocumentStore's own comment above — same pattern,
// same reasoning, applied here.
export function createEvidenceStore(adapter = null, context = {}, signal) {
  return {
    // Returns { ok: true, record } or { ok: false, code }.
    async resolve(evidenceId) {
      if (!adapter) return { ok: false, code: "EVIDENCE_STORE_UNAVAILABLE" };
      if (signal?.aborted) throw new RequestAbortedError(abortReason(signal));

      let envelope;
      try {
        envelope = await adapter.getEvidence(evidenceId, { signal });
      } catch (error) {
        if (error instanceof RequestAbortedError) throw error;
        return { ok: false, code: "EVIDENCE_STORE_UNAVAILABLE" };
      }

      const record = envelope?.record;
      if (!record || record.evidence_id !== evidenceId) {
        return { ok: false, code: "EVIDENCE_NOT_FOUND" };
      }
      if (envelope.corpus_snapshot_id !== context?.corpus_snapshot_id) {
        return { ok: false, code: "EVIDENCE_SNAPSHOT_MISMATCH" };
      }
      return { ok: true, record };
    },
  };
}

// Per-cell containment, never a joined/concatenated string — a quote must
// live entirely inside ONE cell's own text. Joining header/body cells with
// a separator (the previous approach) let a quote span across a cell
// boundary and still "match"; this cannot.
function tableCellTexts(table) {
  const rows = [...(table?.header_rows ?? []), ...(table?.body_rows ?? [])];
  return rows.flat().map((cell) => (cell === null || cell === undefined ? "" : String(cell)));
}

function quoteResolvesInBlock(block, quote) {
  if (typeof block?.text === "string") return block.text.includes(quote);
  if (block?.table) return tableCellTexts(block.table).some((cell) => cell.includes(quote));
  return false;
}

// A canonical block locator may be narrowed to one physical table cell.
// The base DocumentIR remains immutable and keeps its block-level locator;
// the suffix is an Evidence occurrence selector used when identical text
// appears in multiple cells of the same table (for example, "before" and
// "after" values that happen to be equal).
//
//   document/file.xml#node=1&row=4&col=1
//
// Unknown/partial suffixes are not silently treated as block locators.
function parseEvidenceLocator(locator) {
  if (typeof locator !== "string") return null;
  if (!locator.includes("&row=") && !locator.includes("&col=")) {
    return { blockLocator: locator, row: null, col: null };
  }
  const marker = locator.match(/^(.*#node=\d+)&row=(\d+)&col=(\d+)$/);
  if (!marker) return null;
  return {
    blockLocator: marker[1],
    row: marker[2] === undefined ? null : Number(marker[2]),
    col: marker[3] === undefined ? null : Number(marker[3]),
  };
}

function quoteResolvesAtLocator(block, parsedLocator, quote) {
  if (parsedLocator.row === null) return quoteResolvesInBlock(block, quote);
  const cells = block?.table?.raw_rows?.flat?.() ?? [];
  const cell = cells.find((candidate) => candidate?.row === parsedLocator.row && candidate?.col === parsedLocator.col);
  return typeof cell?.text === "string" && cell.text.includes(quote);
}

export function createCitationValidator(documentStore, evidenceStore) {
  return {
    // Returns { ok: true } or { ok: false, code }.
    async check(evidenceBundle) {
      // (1) Human-review check first: resolve the claimed evidence_id
      // against the trusted store and confirm every field the request
      // makes matches what was actually reviewed, and that it was
      // actually VERIFIED (never taken from the request itself).
      const resolution = await evidenceStore.resolve(evidenceBundle.evidence_id);
      if (!resolution.ok) return resolution;

      const record = resolution.record;
      if (record.document_id !== evidenceBundle.document_id || record.file_id !== evidenceBundle.file_id) {
        return { ok: false, code: "EVIDENCE_DOCUMENT_MISMATCH" };
      }
      if (record.source_locator !== evidenceBundle.source_locator) {
        return { ok: false, code: "EVIDENCE_LOCATOR_MISMATCH" };
      }
      if (record.quoted_text !== evidenceBundle.quoted_text) {
        return { ok: false, code: "EVIDENCE_QUOTE_MISMATCH" };
      }
      // The hash is not just compared as opaque strings — it must actually
      // be SHA256(quoted_text), on both sides. Two equal-but-fabricated
      // strings (e.g. both "aaaa...") must not pass.
      const actualHash = sha256Hex(evidenceBundle.quoted_text);
      if (
        !record.quote_sha256 ||
        !evidenceBundle.quote_sha256 ||
        actualHash !== evidenceBundle.quote_sha256 ||
        actualHash !== record.quote_sha256
      ) {
        return { ok: false, code: "EVIDENCE_HASH_MISMATCH" };
      }
      if (record.verification_status !== "VERIFIED") {
        return { ok: false, code: "UNVERIFIED_DATA_FORBIDDEN" };
      }

      // (2) Raw citation check, independent of human review: the claimed
      // quote must ALSO actually resolve against the real corpus text.
      const doc = await documentStore.resolve(evidenceBundle.document_id);
      if (!doc.ok) return doc;

      const parsedLocator = parseEvidenceLocator(evidenceBundle.source_locator);
      if (!parsedLocator) return { ok: false, code: "LOCATOR_NOT_FOUND" };
      const block = (doc.documentIR.blocks ?? []).find(
        (candidate) => candidate.file_id === evidenceBundle.file_id && candidate.source_locator === parsedLocator.blockLocator,
      );
      if (!block) return { ok: false, code: "LOCATOR_NOT_FOUND" };

      if (!evidenceBundle.quoted_text || !quoteResolvesAtLocator(block, parsedLocator, evidenceBundle.quoted_text)) {
        return { ok: false, code: "QUOTE_MISMATCH" };
      }

      return { ok: true };
    },
  };
}
