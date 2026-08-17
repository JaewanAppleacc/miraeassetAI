import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareSeedStructuredReview, REVIEW_ITEM_TYPES } from "../scripts/prepare-seed-structured-review.mjs";

async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), "seed-structured-review-"));
  const work = path.join(root, "work");
  await mkdir(work, { recursive: true });
  const paths = {
    facts: "work/facts.jsonl", events: "work/events.jsonl", coverage: "work/coverage.json", queue: "work/queue.jsonl",
    outputCoverage: "work/coverage-v2.json", outputSummary: "work/summary.json",
    outputOwnerChecklist: "work/owner.md", outputOwnerDecisions: "work/owner-decisions.jsonl", outputClaudePrompt: "work/claude.md",
  };
  await writeFile(path.join(root, paths.facts), `${JSON.stringify({ fact_id: "fact_1", verification_status: "CANDIDATE" })}\n`);
  await writeFile(path.join(root, paths.events), `${JSON.stringify({ event_id: "event_1", verification_status: "CANDIDATE" })}\n`);
  await writeFile(path.join(root, paths.coverage), JSON.stringify({ slots: [
    { slot_key: "q1::x", candidate_status: "VERIFIED_FACT_AVAILABLE", verification_status: "PENDING_HUMAN_REVIEW" },
    { slot_key: "q1::y", candidate_status: "NOT_APPLICABLE", verification_status: "PENDING_HUMAN_REVIEW" },
  ] }));
  await writeFile(path.join(root, paths.queue), `${JSON.stringify({ item_type: REVIEW_ITEM_TYPES[0], priority: "MEDIUM" })}\n`);
  try { await run({ root, paths }); } finally { await rm(root, { recursive: true, force: true }); }
}

test("relabels ambiguous candidate coverage without promoting anything", async () => {
  await fixture(async ({ root, paths }) => {
    const result = await prepareSeedStructuredReview({ root, paths });
    assert.deepEqual(result.coverage.slots.map((slot) => slot.candidate_status), ["FACT_CANDIDATE_AVAILABLE", "NOT_APPLICABLE"]);
    assert.ok(result.coverage.slots.every((slot) => slot.verification_status === "PENDING_HUMAN_REVIEW"));
    assert.equal(result.summary.promotion_allowed, false);
    assert.equal(result.summary.fact_count, 1);
    assert.equal(result.summary.event_count, 1);
    assert.equal(result.summary.coverage_slot_count, 2);
    assert.doesNotMatch(await readFile(path.join(root, paths.outputCoverage), "utf8"), /VERIFIED_FACT_AVAILABLE/);
    assert.match(await readFile(path.join(root, paths.outputOwnerChecklist), "utf8"), /Owner 최종 확인/);
    const decisions = (await readFile(path.join(root, paths.outputOwnerDecisions), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].decision, "PENDING");
    assert.match(await readFile(path.join(root, paths.outputClaudePrompt), "utf8"), /독립 검수/);
  });
});

test("fails closed if a Fact is already promoted or an excluded question leaks in", async () => {
  await fixture(async ({ root, paths }) => {
    await writeFile(path.join(root, paths.facts), `${JSON.stringify({ fact_id: "fact_1", verification_status: "VERIFIED" })}\n`);
    await assert.rejects(() => prepareSeedStructuredReview({ root, paths, writeOutputs: false }), /is not CANDIDATE/);
    await writeFile(path.join(root, paths.facts), `${JSON.stringify({ fact_id: "fact_1", verification_status: "CANDIDATE", question_id: "question_seed_v07_03" })}\n`);
    await assert.rejects(() => prepareSeedStructuredReview({ root, paths, writeOutputs: false }), /must remain excluded/);
  });
});

test("fails closed on unknown review types or non-pending coverage", async () => {
  await fixture(async ({ root, paths }) => {
    await writeFile(path.join(root, paths.queue), `${JSON.stringify({ item_type: "MADE_UP", priority: "LOW" })}\n`);
    await assert.rejects(() => prepareSeedStructuredReview({ root, paths, writeOutputs: false }), /unknown review item_type/);
    await writeFile(path.join(root, paths.queue), `${JSON.stringify({ item_type: REVIEW_ITEM_TYPES[0], priority: "LOW" })}\n`);
    await writeFile(path.join(root, paths.coverage), JSON.stringify({ slots: [
      { slot_key: "q1::x", candidate_status: "VERIFIED_FACT_AVAILABLE", verification_status: "VERIFIED" },
    ] }));
    await assert.rejects(() => prepareSeedStructuredReview({ root, paths, writeOutputs: false }), /not pending human review/);
  });
});

test("real Seed candidates preserve the reported 54/24/69/42 boundary", async () => {
  const { summary, coverage, ownerDecisionTemplate } = await prepareSeedStructuredReview({ writeOutputs: false });
  assert.equal(summary.fact_count, 54);
  assert.equal(summary.event_count, 24);
  assert.equal(summary.coverage_slot_count, 69);
  assert.equal(summary.review_queue_count, 42);
  assert.equal(summary.review_item_types.EVENT_CHAIN_ALIGNMENT_REVIEW, 24);
  assert.equal(summary.review_item_types.NARRATIVE_FACT_CLASSIFICATION_REVIEW, 13);
  assert.ok(coverage.slots.every((slot) => slot.verification_status === "PENDING_HUMAN_REVIEW"));
  assert.doesNotMatch(JSON.stringify(coverage), /question_seed_v07_(03|22)/);
  assert.equal(ownerDecisionTemplate.length, 42);
  assert.equal(new Set(ownerDecisionTemplate.map((record) => record.review_item_id)).size, 42);
  assert.ok(ownerDecisionTemplate.every((record) => record.decision === "PENDING"));
});
