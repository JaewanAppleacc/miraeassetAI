import assert from "node:assert/strict";
import test from "node:test";
import { buildSemanticLinkReview } from "../scripts/build-seed-semantic-link-review.mjs";

test("builds a fail-closed, pending-only semantic-link review packet from Seed v0.11", async () => {
  const { records, summary } = await buildSemanticLinkReview({ writeOutputs: false });
  assert.equal(summary.source_link_occurrences, 142);
  assert.equal(summary.unique_link_count, 140);
  assert.equal(summary.duplicate_source_occurrences_collapsed, 2);
  assert.equal(records.length, 140);
  assert.ok(records.every((item) => item.semantic_link_status === "PENDING_HUMAN_REVIEW"));
  assert.ok(records.every((item) => Object.values(item.semantic_dimension_checks).every((value) => value === null)));
  assert.ok(summary.by_risk.CRITICAL > 0);
});

test("every declared table link resolves in its exact row and column, not merely somewhere in the block", async () => {
  const { records } = await buildSemanticLinkReview({ writeOutputs: false });
  const tableRecords = records.filter((item) => item.source_context.block_type === "TABLE");
  assert.ok(tableRecords.length > 0);
  for (const item of tableRecords) {
    assert.equal(typeof item.source_context.row, "number");
    assert.equal(typeof item.source_context.column, "number");
    assert.match(item.source_context.selected_cell_text, new RegExp(item.quoted_text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

