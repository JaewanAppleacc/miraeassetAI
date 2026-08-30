import assert from "node:assert/strict";
import test from "node:test";
import { canonicalSha256, computeModelConfigSha256, computePromptTemplateSha256, computeDatasetSha256, detectCodeRevision } from "../domain/agent-comparison/reproducibility.mjs";
import { ANSWER_PROMPT_TEMPLATE, ANSWER_PROMPT_TEMPLATE_SHA256 } from "../domain/agent-comparison/flows/structured-first-agent.mjs";

test("canonicalSha256 is stable regardless of object key insertion order", () => {
  const a = { z: 1, a: 2, nested: { b: 1, a: 2 } };
  const b = { a: 2, z: 1, nested: { a: 2, b: 1 } };
  assert.equal(canonicalSha256(a), canonicalSha256(b));
});

test("computeModelConfigSha256 is deterministic for the same config and differs for a different one", () => {
  const config = { schema_version: "0.1.0", model_config_id: "model_x", kind: "FAKE_DETERMINISTIC", provider: "p", model: "m" };
  const sameAgain = { schema_version: "0.1.0", model_config_id: "model_x", kind: "FAKE_DETERMINISTIC", provider: "p", model: "m" };
  const different = { ...config, model: "different-model" };
  assert.equal(computeModelConfigSha256(config), computeModelConfigSha256(sameAgain));
  assert.notEqual(computeModelConfigSha256(config), computeModelConfigSha256(different));
});

test("computePromptTemplateSha256 is deterministic for the same text and matches structured-first-agent.mjs's own exported constant", () => {
  assert.equal(computePromptTemplateSha256(ANSWER_PROMPT_TEMPLATE), ANSWER_PROMPT_TEMPLATE_SHA256);
  assert.equal(computePromptTemplateSha256(ANSWER_PROMPT_TEMPLATE), computePromptTemplateSha256(ANSWER_PROMPT_TEMPLATE));
  assert.notEqual(computePromptTemplateSha256(ANSWER_PROMPT_TEMPLATE), computePromptTemplateSha256(`${ANSWER_PROMPT_TEMPLATE} `));
});

test("computeDatasetSha256 is deterministic over (question_id, question) pairs only -- unrelated extra fields on a question record do not change the hash", () => {
  const a = [{ question_id: "q1", question: "hello", hints: { corp_codes: ["1"] } }];
  const b = [{ question_id: "q1", question: "hello", hints: { corp_codes: ["2"] } }];
  assert.equal(computeDatasetSha256(a), computeDatasetSha256(b));
  const c = [{ question_id: "q1", question: "different question text" }];
  assert.notEqual(computeDatasetSha256(a), computeDatasetSha256(c));
});

test("detectCodeRevision never throws, even outside a git repository", () => {
  const revision = detectCodeRevision("/");
  assert.equal(typeof revision, "string");
});
