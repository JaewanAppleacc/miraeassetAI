// Side-effect module: importing this registers ONLY the DOCUMENT_FIRST_RAG
// Agent variant. Sibling to register-default-variants.mjs (which registers
// STRUCTURED_FIRST) -- a caller that wants DOCUMENT_FIRST_RAG available
// imports this file instead of editing register-default-variants.mjs or
// variant-registry.mjs (see domain/agent-comparison/IMPLEMENTATION_GUIDE.md).
import { createDocumentFirstRagFlow } from "./flows/document-first-rag-agent.mjs";
import { registerAgentVariant } from "./variant-registry.mjs";

registerAgentVariant("DOCUMENT_FIRST_RAG", (modelAdapter, options) => createDocumentFirstRagFlow(modelAdapter, options));
