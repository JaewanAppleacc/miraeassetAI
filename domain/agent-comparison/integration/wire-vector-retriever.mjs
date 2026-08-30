// Turn P4: wiring-only helper that injects a pgvector-backed Retriever
// adapter into the SAME runFourVariantComparison(...) call
// (four-variant-comparison.mjs, unmodified) already used to run all four
// variants. This is the "신규 integration/wiring 파일을 통해 adapter를
// 주입한다" mechanism the Turn P4 brief requires -- it never edits
// flows/hybrid-retrieval-agent.mjs, flows/document-first-rag-agent.mjs, or
// any other variant file.
//
// STRUCTURED_FIRST and PLANNER are DELIBERATELY left untouched by this
// helper: STRUCTURED_FIRST has no retrieval code path at all (wiring a
// retriever adapter for it is a pure no-op), and PLANNER's own retrieval
// is opt-in per-question via `input.hints.enable_retrieval_fallback` --
// this helper does not set that hint, so PLANNER's behavior is byte-for-
// byte unaffected by whether a vector retriever happens to be wired into
// `serviceAdapters`.
//
// Only HYBRID_RETRIEVAL and DOCUMENT_FIRST_RAG get their `retrievalMethod`
// flow option forced to "DENSE" (both already accept this as a caller-
// supplied option, defaulting to "BM25" otherwise -- see their own
// `options.retrievalMethod` reads) so the injected adapter's
// score_type="COSINE"/component_scores.dense output actually matches what
// retrieval-result.schema.json requires for the method the request itself
// declares.
export function withVectorRetrieval({
  context = {},
  serviceAdapters = {},
  flowOptions = {},
  retrieverAdapter,
  chunkingConfigId,
  indexSnapshotId,
  retrievalMethod = "DENSE",
}) {
  if (!retrieverAdapter || typeof retrieverAdapter.retrieve !== "function") {
    throw new TypeError("withVectorRetrieval requires retrieverAdapter: { retrieve(request, options) }");
  }
  if (typeof chunkingConfigId !== "string" || chunkingConfigId === "") throw new TypeError("chunkingConfigId is required");
  if (typeof indexSnapshotId !== "string" || indexSnapshotId === "") throw new TypeError("indexSnapshotId is required");

  return {
    context: { ...context, chunking_config_id: chunkingConfigId, index_snapshot_id: indexSnapshotId },
    serviceAdapters: { ...serviceAdapters, retriever: retrieverAdapter },
    flowOptions: {
      ...flowOptions,
      HYBRID_RETRIEVAL: { ...flowOptions.HYBRID_RETRIEVAL, retrievalMethod },
      DOCUMENT_FIRST_RAG: { ...flowOptions.DOCUMENT_FIRST_RAG, retrievalMethod },
    },
  };
}
