import test from "node:test";
import assert from "node:assert/strict";
import configs from "../domain/chunking/strategy-configs.v0.1.json" with { type: "json" };
import { FROZEN_HIERARCHICAL_CONFIG } from "../domain/agent-comparison/chunking-comparison/frozen-hierarchical-config.mjs";

test("FROZEN_HIERARCHICAL_CONFIG is read directly from strategy-configs.v0.1.json's own PRIMARY entry (same object identity by value), never hand-copied", () => {
  const sharedPrimary = configs.strategies.find((s) => s.role === "PRIMARY");
  assert.deepEqual(FROZEN_HIERARCHICAL_CONFIG, sharedPrimary);
});

test("matches this Turn's brief's exact frozen parameters (parent=1024, child=384/48, table_row=256/8)", () => {
  assert.equal(FROZEN_HIERARCHICAL_CONFIG.chunking_config_id, "doctype-hier-parent-child-table-dual.v0.2.0");
  assert.equal(FROZEN_HIERARCHICAL_CONFIG.parent_max_tokens, 1024);
  assert.equal(FROZEN_HIERARCHICAL_CONFIG.child_max_tokens, 384);
  assert.equal(FROZEN_HIERARCHICAL_CONFIG.child_overlap_tokens, 48);
  assert.equal(FROZEN_HIERARCHICAL_CONFIG.table_row_child_max_tokens, 256);
  assert.equal(FROZEN_HIERARCHICAL_CONFIG.table_row_child_max_rows, 8);
});

test("is a DIFFERENT config object than P10's parent=1536 variant (never accidentally aliased)", () => {
  assert.notEqual(FROZEN_HIERARCHICAL_CONFIG.chunking_config_id, "doctype-hier-parent-child-table-dual.v0.2.0-p10-parent1536");
});
