// Turn N4.22 Part E: unit coverage for the canonical active-decision pin.
// Pure-function tests only -- no filesystem, no process spawning. Exists
// to lock in the fail-closed behavior that
// build-gold-300-owner-decision-v0.2-verification-v04202.mjs's hard gates
// depend on.
import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVE_DECISION_PIN,
  SUPERSEDED_DECISIONS,
  isSupersededDecisionId,
  verifyActiveDecisionPin,
  verifyDecisionAgainstPin,
} from "../domain/evaluation/gold-300-owner-decision-provenance.mjs";

test("SUPERSEDED_DECISIONS: the chat-reconstructed decision (e266789a...) is listed as SUPERSEDED_UNTRUSTED_CHAT_RECONSTRUCTION and explicitly not usable for authorization", () => {
  const entry = SUPERSEDED_DECISIONS.find((d) => d.decision_id === "e266789a-5263-4015-9dc1-7fa8e6eb36c2");
  assert.ok(entry, "e266789a... must be present in SUPERSEDED_DECISIONS");
  assert.equal(entry.status, "SUPERSEDED_UNTRUSTED_CHAT_RECONSTRUCTION");
  assert.equal(entry.usable_for_authoring_authorization, false);
  assert.equal(entry.source_type, "CHAT_PASTED_TEXT");
});

test("ACTIVE_DECISION_PIN: pins exactly the real, file-verified decision (93c5b69c...) with its real raw SHA-256", () => {
  assert.equal(ACTIVE_DECISION_PIN.decision_id, "93c5b69c-6e37-46fd-b319-17179a0d6402");
  assert.equal(ACTIVE_DECISION_PIN.sha256, "db5ea49b9b4e29c1076cbcc26f5002a8060b4004a50730e2a184fac2324ab13e");
  assert.equal(ACTIVE_DECISION_PIN.source_type, "REAL_BROWSER_DOWNLOAD_FILE");
});

test("isSupersededDecisionId: true only for the listed untrusted decision_id, false for the active one and for an unrelated id", () => {
  assert.equal(isSupersededDecisionId("e266789a-5263-4015-9dc1-7fa8e6eb36c2"), true);
  assert.equal(isSupersededDecisionId("93c5b69c-6e37-46fd-b319-17179a0d6402"), false);
  assert.equal(isSupersededDecisionId("00000000-0000-0000-0000-000000000000"), false);
});

test("verifyActiveDecisionPin: the real active decision_id + real SHA passes with zero violations", () => {
  const result = verifyActiveDecisionPin({ decisionId: ACTIVE_DECISION_PIN.decision_id, decisionSha256: ACTIVE_DECISION_PIN.sha256 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
});

test("verifyActiveDecisionPin: the superseded chat-reconstructed decision_id is REJECTED even if paired with the correct SHA (SHA alone is never sufficient)", () => {
  const result = verifyActiveDecisionPin({ decisionId: "e266789a-5263-4015-9dc1-7fa8e6eb36c2", decisionSha256: ACTIVE_DECISION_PIN.sha256 });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.type === "DECISION_ID_IS_SUPERSEDED"));
  assert.ok(result.violations.some((v) => v.type === "DECISION_ID_NOT_ACTIVE_PIN"));
});

test("verifyActiveDecisionPin: the correct decision_id paired with a WRONG SHA is rejected (id alone is never sufficient either)", () => {
  const result = verifyActiveDecisionPin({ decisionId: ACTIVE_DECISION_PIN.decision_id, decisionSha256: "0".repeat(64) });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.type === "DECISION_SHA256_NOT_ACTIVE_PIN"));
});

test("verifyActiveDecisionPin: a completely unrelated decision_id/SHA pair is rejected with both mismatch violations, and never mistaken for superseded", () => {
  const result = verifyActiveDecisionPin({ decisionId: "unrelated-id", decisionSha256: "unrelated-sha" });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.type === "DECISION_ID_NOT_ACTIVE_PIN"));
  assert.ok(result.violations.some((v) => v.type === "DECISION_SHA256_NOT_ACTIVE_PIN"));
  assert.equal(result.violations.some((v) => v.type === "DECISION_ID_IS_SUPERSEDED"), false);
});

test("verifyDecisionAgainstPin: with pin=null, fails closed with NO_CANONICAL_DECISION_PINNED regardless of how correct decisionId/decisionSha256 look", () => {
  const result = verifyDecisionAgainstPin({ decisionId: ACTIVE_DECISION_PIN.decision_id, decisionSha256: ACTIVE_DECISION_PIN.sha256, pin: null });
  assert.equal(result.ok, false);
  assert.deepEqual(result.violations, [{ type: "NO_CANONICAL_DECISION_PINNED" }]);
});

test("verifyDecisionAgainstPin: a pin missing decision_id or sha256 also fails closed, never treated as an open/permissive pin", () => {
  assert.equal(verifyDecisionAgainstPin({ decisionId: "x", decisionSha256: "y", pin: { decision_id: "x" } }).ok, false);
  assert.equal(verifyDecisionAgainstPin({ decisionId: "x", decisionSha256: "y", pin: { sha256: "y" } }).ok, false);
  assert.equal(verifyDecisionAgainstPin({ decisionId: "x", decisionSha256: "y", pin: {} }).ok, false);
});

test("verifyDecisionAgainstPin: a caller-supplied pin that matches the given decisionId/decisionSha256 passes -- confirms the check logic itself, independent of the hardcoded module constants", () => {
  const customPin = { decision_id: "custom-id", sha256: "custom-sha" };
  const result = verifyDecisionAgainstPin({ decisionId: "custom-id", decisionSha256: "custom-sha", pin: customPin, supersededIds: [] });
  assert.equal(result.ok, true);
});
