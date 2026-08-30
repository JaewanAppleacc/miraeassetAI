// Side-effect module: importing this registers the HYBRID_RETRIEVAL Agent
// variant. Mirrors register-default-variants.mjs's own pattern exactly
// (see IMPLEMENTATION_GUIDE.md) -- this file never touches
// register-default-variants.mjs or any other variant's registration.
import { createHybridRetrievalFlow } from "./flows/hybrid-retrieval-agent.mjs";
import { registerAgentVariant } from "./variant-registry.mjs";

registerAgentVariant("HYBRID_RETRIEVAL", (modelAdapter, options) => createHybridRetrievalFlow(modelAdapter, options));
