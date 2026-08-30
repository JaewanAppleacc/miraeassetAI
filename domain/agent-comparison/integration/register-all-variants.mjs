// Turn P3: side-effect module that registers ALL FOUR Agent variants into
// the one shared variant-registry.mjs. Each variant's own registration
// file (register-default-variants.mjs, register-hybrid-retrieval-variant.mjs,
// register-planner-variant.mjs, register-document-first-rag-variant.mjs) is
// imported as-is, unmodified -- this file does not itself call
// registerAgentVariant and does not duplicate any variant's factory logic.
// Importing this module (for its side effects) is the ONE place the
// four-variant comparison harness needs to touch to guarantee all four are
// present in the registry before running a comparison.
import "../register-default-variants.mjs";
import "../register-hybrid-retrieval-variant.mjs";
import "../register-planner-variant.mjs";
import "../register-document-first-rag-variant.mjs";
