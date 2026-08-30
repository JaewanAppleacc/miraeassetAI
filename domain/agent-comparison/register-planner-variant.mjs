// Side-effect module (Turn P2-P): importing this registers the PLANNER
// Agent variant. Mirrors register-default-variants.mjs's own pattern
// exactly (see domain/agent-comparison/IMPLEMENTATION_GUIDE.md) -- a
// sibling file per variant, never editing register-default-variants.mjs
// or variant-registry.mjs itself.
import { createPlannerFlow } from "./flows/planner-agent.mjs";
import { registerAgentVariant } from "./variant-registry.mjs";

registerAgentVariant("PLANNER", (modelAdapter, options) => createPlannerFlow(modelAdapter, options));
