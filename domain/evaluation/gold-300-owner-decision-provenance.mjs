// Turn N4.22: pins the SINGLE canonical, file-verified Owner decision for
// the Gold-300 plan approval, and records the earlier chat-reconstructed
// decision as explicitly superseded and untrusted. Nothing here is
// inferred from a decision file's own content -- the whole point is to
// defend against a decision file that passes every OTHER check (domain
// invariants, packet SHAs, even a genuine com.apple.quarantine marker on
// some unrelated real download) but simply isn't the one the Owner
// actually approved. A decision is only ever "active" when both its
// decision_id AND its raw file SHA-256 match this pin exactly.
//
// This module intentionally hardcodes a single point-in-time approval.
// A future Owner decision (e.g. a v0.3 re-approval) requires an explicit,
// reviewed update to ACTIVE_DECISION_PIN in a later Turn -- it is never
// inferred automatically from "the most recently ingested file".

export const SUPERSEDED_DECISIONS = Object.freeze([
  Object.freeze({
    decision_id: "e266789a-5263-4015-9dc1-7fa8e6eb36c2",
    status: "SUPERSEDED_UNTRUSTED_CHAT_RECONSTRUCTION",
    source_type: "CHAT_PASTED_TEXT",
    sha256: null,
    usable_for_authoring_authorization: false,
    evidence_note:
      "Pasted directly into chat as JSON text, never confirmed against a real downloaded file. No on-disk byte source for this content was ever produced by a genuine browser download, so no file SHA-256 can be computed for it. Historical trace preserved in commit 512799f27806d287dd0add0043872d34213885e8 (a test-fixture assertion referencing this decision_id), which is left untouched -- never amended, reverted, or force-pushed -- per this project's forward-only history discipline.",
  }),
]);

export const ACTIVE_DECISION_PIN = Object.freeze({
  decision_id: "93c5b69c-6e37-46fd-b319-17179a0d6402",
  sha256: "db5ea49b9b4e29c1076cbcc26f5002a8060b4004a50730e2a184fac2324ab13e",
  status: "ACTIVE_FILE_VERIFIED_OWNER_DECISION",
  source_type: "REAL_BROWSER_DOWNLOAD_FILE",
  pinned_turn: "N4.22",
});

export function isSupersededDecisionId(decisionId) {
  return SUPERSEDED_DECISIONS.some((d) => d.decision_id === decisionId);
}

// Parameterized, pure core check -- takes the pin and superseded-id list as
// explicit arguments so tests can exercise the fail-closed "no canonical
// pin" branch directly, without needing to mutate this module's own
// frozen exports.
export function verifyDecisionAgainstPin({ decisionId, decisionSha256, pin, supersededIds = [] }) {
  const violations = [];
  if (!pin || typeof pin.decision_id !== "string" || pin.decision_id.length === 0 || typeof pin.sha256 !== "string" || pin.sha256.length === 0) {
    violations.push({ type: "NO_CANONICAL_DECISION_PINNED" });
    return Object.freeze({ ok: false, violations });
  }
  if (supersededIds.includes(decisionId)) {
    violations.push({ type: "DECISION_ID_IS_SUPERSEDED", decision_id: decisionId });
  }
  if (decisionId !== pin.decision_id) {
    violations.push({ type: "DECISION_ID_NOT_ACTIVE_PIN", expected: pin.decision_id, actual: decisionId });
  }
  if (decisionSha256 !== pin.sha256) {
    violations.push({ type: "DECISION_SHA256_NOT_ACTIVE_PIN", expected: pin.sha256, actual: decisionSha256 });
  }
  return Object.freeze({ ok: violations.length === 0, violations });
}

// Production entry point: always checks against this module's own hardcoded
// ACTIVE_DECISION_PIN and SUPERSEDED_DECISIONS -- never accepts a
// caller-supplied pin, so no runtime code path can silently widen what
// counts as "active".
export function verifyActiveDecisionPin({ decisionId, decisionSha256 }) {
  return verifyDecisionAgainstPin({
    decisionId,
    decisionSha256,
    pin: ACTIVE_DECISION_PIN,
    supersededIds: SUPERSEDED_DECISIONS.map((d) => d.decision_id),
  });
}
