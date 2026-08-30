// Side-effect module: importing this registers every Agent variant this
// Turn actually implements. A future worker adding HYBRID_RETRIEVAL/
// PLANNER/DOCUMENT_FIRST_RAG creates their own sibling
// register-<variant>-variant.mjs and imports it the same way, instead of
// editing this file (see IMPLEMENTATION_GUIDE.md).
import { createStructuredFirstFlow } from "./flows/structured-first-agent.mjs";
import { registerAgentVariant } from "./variant-registry.mjs";

registerAgentVariant("STRUCTURED_FIRST", (modelAdapter, options) => createStructuredFirstFlow(modelAdapter, options));
