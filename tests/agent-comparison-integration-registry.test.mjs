import assert from "node:assert/strict";
import test from "node:test";
import { listRegisteredAgentVariantIds } from "../domain/agent-comparison/variant-registry.mjs";
import { REQUIRED_VARIANT_IDS, assertAllFourVariantsRegistered, MissingAgentVariantRegistrationError } from "../domain/agent-comparison/integration/four-variant-comparison.mjs";
import "../domain/agent-comparison/integration/register-all-variants.mjs";

test("registering all four variants (register-all-variants.mjs) results in exactly the 4 required ids, no duplicates, no extras", () => {
  const registered = listRegisteredAgentVariantIds();
  assert.equal(registered.length, 4);
  assert.deepEqual([...new Set(registered)].sort(), [...REQUIRED_VARIANT_IDS].sort());
});

test("assertAllFourVariantsRegistered passes once all four are registered", () => {
  assert.doesNotThrow(() => assertAllFourVariantsRegistered(listRegisteredAgentVariantIds()));
});

test("assertAllFourVariantsRegistered throws MissingAgentVariantRegistrationError naming exactly the missing id(s), without touching any variant's own registration file", () => {
  const before = listRegisteredAgentVariantIds();
  try {
    assert.throws(
      () => assertAllFourVariantsRegistered(["STRUCTURED_FIRST", "HYBRID_RETRIEVAL", "PLANNER"]),
      (error) => {
        assert.ok(error instanceof MissingAgentVariantRegistrationError);
        assert.deepEqual(error.missing, ["DOCUMENT_FIRST_RAG"]);
        return true;
      },
    );
    assert.throws(
      () => assertAllFourVariantsRegistered([]),
      (error) => {
        assert.deepEqual([...error.missing].sort(), [...REQUIRED_VARIANT_IDS].sort());
        return true;
      },
    );
  } finally {
    // This test only ever calls assertAllFourVariantsRegistered with a
    // synthetic id LIST -- it never calls _clearRegistryForTests or
    // registerAgentVariant, so the real registry (populated by the
    // top-level register-all-variants.mjs import) was never touched.
    assert.deepEqual(listRegisteredAgentVariantIds(), before);
  }
});
