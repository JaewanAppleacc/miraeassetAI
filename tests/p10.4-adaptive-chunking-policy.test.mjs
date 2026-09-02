import test from "node:test";
import assert from "node:assert/strict";
import { ADAPTIVE_POLICY_ID, ADAPTIVE_POLICY_VERSION, BASE_FIXED_CONFIG_ID, ADAPTIVE_CHUNK_TYPE, CONTEXT_STATE, PARENT_EXPANSION_POLICY, ADAPTIVE_INVARIANTS, TABLE_ROW_CHILD_MAX_TOKENS } from "../domain/chunking/adaptive-chunking-policy.mjs";

test("policy ID/version are fixed, non-empty strings", () => {
  assert.equal(ADAPTIVE_POLICY_ID, "adaptive-fixed512-table-aware-v0.1.0");
  assert.equal(ADAPTIVE_POLICY_VERSION, "0.1.0");
});

test("BASE_FIXED_CONFIG_ID matches the real pinned Fixed strategy config id used elsewhere in this codebase", () => {
  assert.equal(BASE_FIXED_CONFIG_ID, "fixed-token-512-o64.v0.1.0");
});

test("ADAPTIVE_CHUNK_TYPE defines exactly the required chunk kinds", () => {
  assert.deepEqual(Object.keys(ADAPTIVE_CHUNK_TYPE).sort(), ["FIXED_WINDOW", "MULTI_ROW_CONTEXT", "TABLE_PARENT_CONTEXT", "TABLE_ROW_SEGMENT_WITH_HEADERS", "TABLE_ROW_WITH_HEADERS"].sort());
});

test("CONTEXT_STATE defines exactly the 4 required states", () => {
  assert.deepEqual(Object.keys(CONTEXT_STATE).sort(), ["ABSENT_IN_SOURCE", "EXPLICIT_IN_SOURCE", "INHERITED_FROM_TABLE_CONTEXT", "PARSE_RECOVERY_REQUIRED"].sort());
});

test("PARENT_EXPANSION_POLICY centralizes all budget numbers -- no field is undefined or a magic default", () => {
  assert.equal(typeof PARENT_EXPANSION_POLICY.parent_context_max_tokens, "number");
  assert.equal(PARENT_EXPANSION_POLICY.expansion_per_child, 1);
  assert.equal(typeof PARENT_EXPANSION_POLICY.total_expansion_context_budget_tokens, "number");
});

test("TABLE_ROW_CHILD_MAX_TOKENS is a single, centralized source of truth", () => {
  assert.equal(TABLE_ROW_CHILD_MAX_TOKENS, 512);
});

test("ADAPTIVE_INVARIANTS lists every forbidden pattern this Turn's brief names", () => {
  assert.ok(ADAPTIVE_INVARIANTS.includes("NO_WHOLE_TABLE_AS_ONE_SEARCH_CHUNK"));
  assert.ok(ADAPTIVE_INVARIANTS.includes("NO_GOLD_QUESTION_OR_ANSWER_DRIVEN_CHUNKING"));
  assert.ok(ADAPTIVE_INVARIANTS.includes("NO_FABRICATED_UNIT_OR_PERIOD"));
  assert.ok(ADAPTIVE_INVARIANTS.includes("PARENT_CONTEXT_NEVER_OCCUPIES_A_TOP_K_SLOT"));
  assert.ok(Object.isFrozen(ADAPTIVE_INVARIANTS));
});
