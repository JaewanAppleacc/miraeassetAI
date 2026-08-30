import assert from "node:assert/strict";
import test from "node:test";
import {
  registerAgentVariant, getAgentVariantFactory, listRegisteredAgentVariantIds, _clearRegistryForTests,
} from "../domain/agent-comparison/variant-registry.mjs";
import { InvalidAgentVariantIdError } from "../domain/agent-comparison/contracts.mjs";

test.afterEach(() => _clearRegistryForTests());

test("registerAgentVariant rejects an id outside AGENT_VARIANT_IDS", () => {
  assert.throws(() => registerAgentVariant("NOT_A_REAL_VARIANT", () => ({})), InvalidAgentVariantIdError);
});

test("registerAgentVariant + getAgentVariantFactory round-trip for a known id", () => {
  const factory = (modelAdapter) => ({ id: "PLANNER", run: async () => ({ final_response: {} }) });
  registerAgentVariant("PLANNER", factory);
  assert.equal(getAgentVariantFactory("PLANNER"), factory);
  assert.deepEqual(listRegisteredAgentVariantIds(), ["PLANNER"]);
});

test("getAgentVariantFactory throws a clear error for a valid-but-unregistered id", () => {
  assert.throws(() => getAgentVariantFactory("HYBRID_RETRIEVAL"), /no AgentFlow is registered/);
});

test("importing register-default-variants.mjs registers STRUCTURED_FIRST", async () => {
  await import("../domain/agent-comparison/register-default-variants.mjs");
  assert.ok(listRegisteredAgentVariantIds().includes("STRUCTURED_FIRST"));
});
