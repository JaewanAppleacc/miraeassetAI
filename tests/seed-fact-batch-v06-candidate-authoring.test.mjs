// Regression coverage for the v0.17 audit's P0 finding: an automated
// builder script must never mint its own Owner approval. Two independent
// checks: (1) a functional check that every record buildCandidates()
// actually produces is CANDIDATE/PENDING-shaped, with no approver identity
// or approval timestamp anywhere; (2) a static source-text check that the
// script's own code (comments excluded) never contains the reviewer name
// or an APPROVE/VERIFIED/OWNER_ACCEPTED literal as a value. Either check
// alone could miss a reintroduced regression (the functional check misses
// a hardcoded value nothing calls a test against a code path; the source
// check misses a dynamically-constructed but still-hardcoded value) --
// together they cover both.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { buildCandidates } from "../scripts/build-seed-fact-batch-v06-candidates.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const SCRIPT_PATH = path.join(ROOT, "scripts/build-seed-fact-batch-v06-candidates.mjs");
const FORBIDDEN_LITERALS = ["최재완", '"APPROVE"', '"VERIFIED"', '"OWNER_ACCEPTED"', '"ACCEPTED"'];

test("static: the candidate-authoring script's code (comments excluded) never contains an approval literal or the reviewer's name", async () => {
  const source = await readFile(SCRIPT_PATH, "utf8");
  const codeOnly = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  for (const literal of FORBIDDEN_LITERALS) {
    assert.equal(codeOnly.includes(literal), false, `forbidden literal ${literal} found in non-comment code`);
  }
});

test("functional: every produced Evidence candidate is CANDIDATE-shaped with no approver identity/timestamp", async () => {
  const { evidence } = await buildCandidates({ generatedAt: "2026-08-14T00:00:00.000Z" });
  assert.equal(evidence.length, 6);
  for (const record of evidence) {
    assert.equal(record.verification_status, "CANDIDATE");
    assert.equal(record.metadata.review_status, "PENDING_HUMAN_REVIEW");
    assert.equal("owner_approved_by" in record.metadata.verification_provenance, false);
    assert.equal("owner_approved_at" in record.metadata.verification_provenance, false);
    assert.notEqual(record.metadata.verification_provenance.review_method, "OWNER_DIRECT_APPROVAL_CLAUDE_GROUNDING_CHECK");
  }
});

test("functional: every produced Fact candidate is CANDIDATE-shaped with owner_disposition PENDING and no approver identity/timestamp", async () => {
  const { facts } = await buildCandidates({ generatedAt: "2026-08-14T00:00:00.000Z" });
  assert.equal(facts.length, 6);
  for (const record of facts) {
    assert.equal(record.verification_status, "CANDIDATE");
    assert.equal(record.attributes.review_provenance.owner_disposition, "PENDING");
    assert.equal("owner_approved_by" in record.attributes.review_provenance, false);
    assert.equal("owner_approved_at" in record.attributes.review_provenance, false);
  }
});

test("functional: the decision TEMPLATE has all 6 items PENDING with null reviewer/reviewed_at, and its ID set matches the candidates exactly", async () => {
  const { evidence, facts, decisionTemplate } = await buildCandidates({ generatedAt: "2026-08-14T00:00:00.000Z" });
  assert.equal(decisionTemplate.length, 6);
  for (const item of decisionTemplate) {
    assert.equal(item.owner_disposition, "PENDING");
    assert.equal(item.reviewer, null);
    assert.equal(item.reviewed_at, null);
  }
  assert.deepEqual(
    new Set(decisionTemplate.map((d) => d.fact_id)),
    new Set(facts.map((f) => f.fact_id)),
  );
  assert.deepEqual(
    new Set(decisionTemplate.map((d) => d.evidence_id)),
    new Set(evidence.map((e) => e.evidence_id)),
  );
  // No duplicate review_item_id, fact_id, or evidence_id within the template.
  assert.equal(new Set(decisionTemplate.map((d) => d.review_item_id)).size, 6);
  assert.equal(new Set(decisionTemplate.map((d) => d.fact_id)).size, 6);
  assert.equal(new Set(decisionTemplate.map((d) => d.evidence_id)).size, 6);
});

test("functional: buildCandidates is deterministic given the same generatedAt (no random/time-of-day dependence beyond what's passed in)", async () => {
  const first = await buildCandidates({ generatedAt: "2026-08-14T00:00:00.000Z" });
  const second = await buildCandidates({ generatedAt: "2026-08-14T00:00:00.000Z" });
  assert.deepEqual(first.evidence, second.evidence);
  assert.deepEqual(first.facts, second.facts);
  assert.deepEqual(first.decisionTemplate, second.decisionTemplate);
});
