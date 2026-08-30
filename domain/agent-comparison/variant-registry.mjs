// Generic AgentFlow-variant registry (Turn P1). Kept empty by default so a
// future worker adding HYBRID_RETRIEVAL/PLANNER/DOCUMENT_FIRST_RAG can do so
// from their own file with a single registerAgentVariant call, without
// touching this module or any other variant's file -- see
// domain/agent-comparison/IMPLEMENTATION_GUIDE.md. STRUCTURED_FIRST's own
// registration lives in register-default-variants.mjs, not here, for the
// same reason.
import { assertKnownAgentVariantId } from "./contracts.mjs";

const registry = new Map();

// `factory` is `(modelAdapter, options?) -> AgentFlow` -- a fresh AgentFlow
// per call, so a caller can construct one per question with a freshly
// instrumented ModelAdapter (see telemetry.mjs's instrumentModelAdapter)
// without any state leaking between questions.
export function registerAgentVariant(variantId, factory) {
  assertKnownAgentVariantId(variantId);
  if (typeof factory !== "function") throw new TypeError("factory must be a function: (modelAdapter, options?) -> AgentFlow");
  registry.set(variantId, factory);
}

export function getAgentVariantFactory(variantId) {
  assertKnownAgentVariantId(variantId);
  const factory = registry.get(variantId);
  if (!factory) throw new Error(`no AgentFlow is registered for agent_variant_id ${variantId} yet`);
  return factory;
}

export function listRegisteredAgentVariantIds() {
  return Object.freeze([...registry.keys()]);
}

// Test-only escape hatch (used by tests/agent-comparison-variant-registry.test.mjs
// to avoid cross-test leakage); not exported for production use.
export function _clearRegistryForTests() {
  registry.clear();
}
