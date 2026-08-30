// Turn P3: derives `agent_variant_revision` (BenchmarkRunManifest's own
// documented pin, see domain/agent-comparison/interfaces/
// benchmark-run-manifest.schema.json's description: "e.g. a git revision")
// as the exact git BLOB hash of the variant's own primary flow file at a
// given ref. This is read-only and never modifies any variant file -- it
// answers "which exact committed version of this implementation produced
// this run" precisely, without needing any variant file to export its own
// version constant.
import { execFileSync } from "node:child_process";

export const VARIANT_FLOW_PATHS = Object.freeze({
  STRUCTURED_FIRST: "domain/agent-comparison/flows/structured-first-agent.mjs",
  HYBRID_RETRIEVAL: "domain/agent-comparison/flows/hybrid-retrieval-agent.mjs",
  PLANNER: "domain/agent-comparison/flows/planner-agent.mjs",
  DOCUMENT_FIRST_RAG: "domain/agent-comparison/flows/document-first-rag-agent.mjs",
});

// Best-effort, never throws: falls back to "unknown" the same way
// domain/agent-comparison/reproducibility.mjs's detectCodeRevision does --
// a manifest pin of "unknown" is still valid and honest; failing the whole
// comparison run over a git lookup is not warranted.
export function computeAgentVariantRevision(variantId, { cwd = process.cwd(), ref = "HEAD" } = {}) {
  const relativePath = VARIANT_FLOW_PATHS[variantId];
  if (!relativePath) return "unknown";
  try {
    return execFileSync("git", ["rev-parse", `${ref}:${relativePath}`], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

export function computeAllAgentVariantRevisions(options) {
  return Object.fromEntries(Object.keys(VARIANT_FLOW_PATHS).map((id) => [id, computeAgentVariantRevision(id, options)]));
}
