// Fail-closed coverage for scripts/promote-seed-fact-batch-v06.mjs, the
// v0.17 audit's item-2 remediation: promotion must be a SEPARATE script
// from candidate authoring, must take an externally authored Owner
// decision as input, and must refuse to promote anything unless that
// decision's 6-item ID set, disposition, reviewer, and reviewed_at all
// check out. Every negative test asserts BOTH that promotion throws AND
// that no output file was written (a partial promotion on a rejected batch
// would be its own P0). Every test uses temp output paths and a temp copy
// of the candidate files -- never the real repo's candidate/verified
// files -- so this suite cannot accidentally promote anything for real.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCandidates } from "../scripts/build-seed-fact-batch-v06-candidates.mjs";
import { promoteSeedFactBatch, PromotionBlockedError } from "../scripts/promote-seed-fact-batch-v06.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const REAL_BASELINE_EVIDENCE = path.join(ROOT, "work/domain-seed/seed-evidence-verified.v0.6.jsonl");
const REAL_BASELINE_FACTS = path.join(ROOT, "work/domain-seed/seed-facts-verified.v0.4.jsonl");
const REAL_BASELINE_COVERAGE = path.join(ROOT, "work/domain-seed/seed-fact-coverage-verified.v0.4.json");

function jsonl(records) { return records.map((r) => JSON.stringify(r)).join("\n") + "\n"; }

async function setupCandidates(t) {
  const dir = await mkdtemp(path.join(ROOT, "work", "promote-v06-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { evidence, facts, decisionTemplate } = await buildCandidates({ generatedAt: "2026-08-14T00:00:00.000Z" });
  const evidenceCandidatesPath = path.join(dir, "evidence-candidates.jsonl");
  const factCandidatesPath = path.join(dir, "fact-candidates.jsonl");
  await writeFile(evidenceCandidatesPath, jsonl(evidence));
  await writeFile(factCandidatesPath, jsonl(facts));
  return { dir, evidence, facts, decisionTemplate, evidenceCandidatesPath, factCandidatesPath };
}

function fullyApproved(decisionTemplate, { reviewer = "TEST_FIXTURE_REVIEWER", reviewedAt = "2026-08-14T12:00:00.000Z" } = {}) {
  return decisionTemplate.map((item) => ({ ...item, owner_disposition: "APPROVE", reviewer, reviewed_at: reviewedAt }));
}

function outputPaths(dir) {
  return {
    outputEvidencePath: path.join(dir, "out-evidence.jsonl"),
    outputFactsPath: path.join(dir, "out-facts.jsonl"),
    outputCoveragePath: path.join(dir, "out-coverage.json"),
    receiptPath: path.join(dir, "receipt.json"),
  };
}

async function assertNoOutputWritten(paths) {
  for (const p of [paths.outputEvidencePath, paths.outputFactsPath, paths.outputCoveragePath, paths.receiptPath]) {
    await assert.rejects(stat(p), /ENOENT/, `expected ${p} to not exist`);
  }
}

test("positive: a fully valid, externally-authored decision (6/6 APPROVE) promotes successfully", async (t) => {
  const { dir, decisionTemplate, evidenceCandidatesPath, factCandidatesPath } = await setupCandidates(t);
  const decisionPath = path.join(dir, "decision.jsonl");
  const decisionText = jsonl(fullyApproved(decisionTemplate));
  await writeFile(decisionPath, decisionText);
  const decisionBytesBefore = await readFile(decisionPath);

  const receipt = await promoteSeedFactBatch({
    decisionPath,
    evidenceCandidatesPath, factCandidatesPath,
    baselineEvidencePath: REAL_BASELINE_EVIDENCE, baselineFactsPath: REAL_BASELINE_FACTS, baselineCoveragePath: REAL_BASELINE_COVERAGE,
    ...outputPaths(dir),
    promotedAt: "2026-08-14T12:05:00.000Z",
  });

  assert.equal(receipt.output_evidence_count, 213 + 6);
  assert.equal(receipt.output_facts_count, 67 + 6);
  assert.equal(receipt.output_coverage_slot_count, 82 + 6);
  assert.equal(receipt.promoted_items.length, 6);
  for (const item of receipt.promoted_items) assert.equal(item.reviewer, "TEST_FIXTURE_REVIEWER");

  // Promotion never writes to the decision artifact itself.
  const decisionBytesAfter = await readFile(decisionPath);
  assert.deepEqual(decisionBytesBefore, decisionBytesAfter);

  const outFacts = (await readFile(path.join(dir, "out-facts.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const newlyPromoted = outFacts.filter((f) => f.attributes.review_provenance.owner_approved_by === "TEST_FIXTURE_REVIEWER");
  assert.equal(newlyPromoted.length, 6);
  for (const f of newlyPromoted) {
    assert.equal(f.verification_status, "VERIFIED");
    assert.equal(f.attributes.review_provenance.owner_disposition, "ACCEPTED");
    assert.equal(f.attributes.review_provenance.owner_approved_at, "2026-08-14T12:00:00.000Z");
  }
});

test("negative: a decision missing one of the 6 items is refused, no output written", async (t) => {
  const { dir, decisionTemplate, evidenceCandidatesPath, factCandidatesPath } = await setupCandidates(t);
  const decisionPath = path.join(dir, "decision.jsonl");
  await writeFile(decisionPath, jsonl(fullyApproved(decisionTemplate).slice(0, 5)));
  const paths = outputPaths(dir);
  await assert.rejects(
    promoteSeedFactBatch({ decisionPath, evidenceCandidatesPath, factCandidatesPath, baselineEvidencePath: REAL_BASELINE_EVIDENCE, baselineFactsPath: REAL_BASELINE_FACTS, baselineCoveragePath: REAL_BASELINE_COVERAGE, ...paths }),
    (error) => { assert.ok(error instanceof PromotionBlockedError); assert.match(error.message, /missing an entry|expected exactly 6/); return true; },
  );
  await assertNoOutputWritten(paths);
});

test("negative: a decision with an extra, non-candidate item is refused, no output written", async (t) => {
  const { dir, decisionTemplate, evidenceCandidatesPath, factCandidatesPath } = await setupCandidates(t);
  const decisionPath = path.join(dir, "decision.jsonl");
  const items = fullyApproved(decisionTemplate);
  items.push({ ...items[0], review_item_id: "structured_review_v06_batch_extra", fact_id: "fact_notacandidate000000000", evidence_id: "evidence_notacandidate00000" });
  await writeFile(decisionPath, jsonl(items));
  const paths = outputPaths(dir);
  await assert.rejects(
    promoteSeedFactBatch({ decisionPath, evidenceCandidatesPath, factCandidatesPath, baselineEvidencePath: REAL_BASELINE_EVIDENCE, baselineFactsPath: REAL_BASELINE_FACTS, baselineCoveragePath: REAL_BASELINE_COVERAGE, ...paths }),
    (error) => { assert.ok(error instanceof PromotionBlockedError); assert.match(error.message, /not among the 6 candidate items|expected exactly 6/); return true; },
  );
  await assertNoOutputWritten(paths);
});

test("negative: a decision with a duplicate item is refused, no output written", async (t) => {
  const { dir, decisionTemplate, evidenceCandidatesPath, factCandidatesPath } = await setupCandidates(t);
  const decisionPath = path.join(dir, "decision.jsonl");
  const items = fullyApproved(decisionTemplate);
  items[5] = { ...items[4] }; // duplicate item 4 into slot 5, losing item 5's real coverage
  await writeFile(decisionPath, jsonl(items));
  const paths = outputPaths(dir);
  await assert.rejects(
    promoteSeedFactBatch({ decisionPath, evidenceCandidatesPath, factCandidatesPath, baselineEvidencePath: REAL_BASELINE_EVIDENCE, baselineFactsPath: REAL_BASELINE_FACTS, baselineCoveragePath: REAL_BASELINE_COVERAGE, ...paths }),
    PromotionBlockedError,
  );
  await assertNoOutputWritten(paths);
});

test("negative: 5/6 APPROVE + 1 still PENDING blocks the WHOLE batch, not a partial 5-item promotion", async (t) => {
  const { dir, decisionTemplate, evidenceCandidatesPath, factCandidatesPath } = await setupCandidates(t);
  const decisionPath = path.join(dir, "decision.jsonl");
  const items = fullyApproved(decisionTemplate);
  items[3] = { ...items[3], owner_disposition: "PENDING", reviewer: null, reviewed_at: null };
  await writeFile(decisionPath, jsonl(items));
  const paths = outputPaths(dir);
  await assert.rejects(
    promoteSeedFactBatch({ decisionPath, evidenceCandidatesPath, factCandidatesPath, baselineEvidencePath: REAL_BASELINE_EVIDENCE, baselineFactsPath: REAL_BASELINE_FACTS, baselineCoveragePath: REAL_BASELINE_COVERAGE, ...paths }),
    (error) => { assert.ok(error instanceof PromotionBlockedError); assert.match(error.message, /owner_disposition is "PENDING", not "APPROVE"/); return true; },
  );
  await assertNoOutputWritten(paths);
});

test("negative: a REJECT disposition also blocks the whole batch (not treated as a silent skip)", async (t) => {
  const { dir, decisionTemplate, evidenceCandidatesPath, factCandidatesPath } = await setupCandidates(t);
  const decisionPath = path.join(dir, "decision.jsonl");
  const items = fullyApproved(decisionTemplate);
  items[0] = { ...items[0], owner_disposition: "REJECT", reviewer: "TEST_FIXTURE_REVIEWER", reviewed_at: "2026-08-14T12:00:00.000Z" };
  await writeFile(decisionPath, jsonl(items));
  const paths = outputPaths(dir);
  await assert.rejects(
    promoteSeedFactBatch({ decisionPath, evidenceCandidatesPath, factCandidatesPath, baselineEvidencePath: REAL_BASELINE_EVIDENCE, baselineFactsPath: REAL_BASELINE_FACTS, baselineCoveragePath: REAL_BASELINE_COVERAGE, ...paths }),
    PromotionBlockedError,
  );
  await assertNoOutputWritten(paths);
});

test("negative: a missing reviewer is refused, no output written", async (t) => {
  const { dir, decisionTemplate, evidenceCandidatesPath, factCandidatesPath } = await setupCandidates(t);
  const decisionPath = path.join(dir, "decision.jsonl");
  const items = fullyApproved(decisionTemplate);
  items[2] = { ...items[2], reviewer: "" };
  await writeFile(decisionPath, jsonl(items));
  const paths = outputPaths(dir);
  await assert.rejects(
    promoteSeedFactBatch({ decisionPath, evidenceCandidatesPath, factCandidatesPath, baselineEvidencePath: REAL_BASELINE_EVIDENCE, baselineFactsPath: REAL_BASELINE_FACTS, baselineCoveragePath: REAL_BASELINE_COVERAGE, ...paths }),
    (error) => { assert.ok(error instanceof PromotionBlockedError); assert.match(error.message, /reviewer must be a non-empty string/); return true; },
  );
  await assertNoOutputWritten(paths);
});

test("negative: a missing/invalid reviewed_at is refused, no output written", async (t) => {
  const { dir, decisionTemplate, evidenceCandidatesPath, factCandidatesPath } = await setupCandidates(t);
  const decisionPath = path.join(dir, "decision.jsonl");
  const items = fullyApproved(decisionTemplate);
  items[1] = { ...items[1], reviewed_at: "not-a-date" };
  await writeFile(decisionPath, jsonl(items));
  const paths = outputPaths(dir);
  await assert.rejects(
    promoteSeedFactBatch({ decisionPath, evidenceCandidatesPath, factCandidatesPath, baselineEvidencePath: REAL_BASELINE_EVIDENCE, baselineFactsPath: REAL_BASELINE_FACTS, baselineCoveragePath: REAL_BASELINE_COVERAGE, ...paths }),
    (error) => { assert.ok(error instanceof PromotionBlockedError); assert.match(error.message, /reviewed_at must be a valid ISO date-time/); return true; },
  );
  await assertNoOutputWritten(paths);
});

test("negative: --expected-sha256 mismatch (decision swapped after review) is refused before parsing", async (t) => {
  const { dir, decisionTemplate, evidenceCandidatesPath, factCandidatesPath } = await setupCandidates(t);
  const decisionPath = path.join(dir, "decision.jsonl");
  await writeFile(decisionPath, jsonl(fullyApproved(decisionTemplate)));
  const paths = outputPaths(dir);
  await assert.rejects(
    promoteSeedFactBatch({ decisionPath, expectedSha256: "0".repeat(64), evidenceCandidatesPath, factCandidatesPath, baselineEvidencePath: REAL_BASELINE_EVIDENCE, baselineFactsPath: REAL_BASELINE_FACTS, baselineCoveragePath: REAL_BASELINE_COVERAGE, ...paths }),
    (error) => { assert.ok(error instanceof PromotionBlockedError); assert.match(error.message, /sha256 mismatch/); return true; },
  );
  await assertNoOutputWritten(paths);
});

test("negative: a non-existent decision path is refused, no output written", async (t) => {
  const { dir, evidenceCandidatesPath, factCandidatesPath } = await setupCandidates(t);
  const paths = outputPaths(dir);
  await assert.rejects(
    promoteSeedFactBatch({ decisionPath: path.join(dir, "does-not-exist.jsonl"), evidenceCandidatesPath, factCandidatesPath, baselineEvidencePath: REAL_BASELINE_EVIDENCE, baselineFactsPath: REAL_BASELINE_FACTS, baselineCoveragePath: REAL_BASELINE_COVERAGE, ...paths }),
    PromotionBlockedError,
  );
  await assertNoOutputWritten(paths);
});

test("the real, still-PENDING v0.7 (period-fix) template on disk is itself refused (nothing has actually been approved yet)", async () => {
  // scripts/promote-seed-fact-batch-v06.mjs's default candidate paths now
  // point at v0.9/v0.7 (the corrected, period-fixed candidates) -- this
  // uses the matching v0.7-batch template with no explicit candidate paths
  // to prove the DEFAULTS line up, not just an explicit override.
  const templatePath = path.join(ROOT, "work/domain-seed/seed-structured-owner-decision.v0.7-batch.template.jsonl");
  const dir = await mkdtemp(path.join(ROOT, "work", "promote-v06-realcheck-"));
  try {
    await assert.rejects(
      promoteSeedFactBatch({
        decisionPath: templatePath,
        baselineEvidencePath: REAL_BASELINE_EVIDENCE, baselineFactsPath: REAL_BASELINE_FACTS, baselineCoveragePath: REAL_BASELINE_COVERAGE,
        outputEvidencePath: path.join(dir, "out-evidence.jsonl"), outputFactsPath: path.join(dir, "out-facts.jsonl"),
        outputCoveragePath: path.join(dir, "out-coverage.json"), receiptPath: path.join(dir, "receipt.json"),
      }),
      (error) => { assert.ok(error instanceof PromotionBlockedError); assert.match(error.message, /owner_disposition is "PENDING", not "APPROVE"/); return true; },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the OLD v0.6 (flawed-period) template no longer matches the promotion script's default candidates (superseded, not silently accepted)", async () => {
  const templatePath = path.join(ROOT, "work/domain-seed/seed-structured-owner-decision.v0.6-batch.template.jsonl");
  const dir = await mkdtemp(path.join(ROOT, "work", "promote-v06-realcheck-old-"));
  try {
    await assert.rejects(
      promoteSeedFactBatch({
        decisionPath: templatePath,
        baselineEvidencePath: REAL_BASELINE_EVIDENCE, baselineFactsPath: REAL_BASELINE_FACTS, baselineCoveragePath: REAL_BASELINE_COVERAGE,
        outputEvidencePath: path.join(dir, "out-evidence.jsonl"), outputFactsPath: path.join(dir, "out-facts.jsonl"),
        outputCoveragePath: path.join(dir, "out-coverage.json"), receiptPath: path.join(dir, "receipt.json"),
      }),
      PromotionBlockedError,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
