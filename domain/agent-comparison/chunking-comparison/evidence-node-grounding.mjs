// Turn P10: evidence_id -> { documentId, sourceNodeId } grounding, read
// directly from VERIFIED_EVIDENCE records in the same bundle domain/
// agent-comparison/embedding-calibration/dataset.mjs already reads for the
// 98-item calibration set. This is a SEPARATE, parallel read (dataset.mjs
// itself is never modified) needed because selectCalibrationDataset()'s
// returned items intentionally do not carry node-level grounding -- E2's
// "positive evidence" judgment (chunk relevance) needs it, joined back in
// by evidence_id after dataset.mjs's own selection has run.
import { withVerifiedReferenceBundle } from "../../postgres/reference-release-loader.mjs";
import { collectReferenceReleaseRecords } from "../../postgres/reference-release-contract.mjs";

export async function collectEvidenceNodeGrounding(bundleOptions) {
  const groundingByEvidenceId = new Map();
  await withVerifiedReferenceBundle(bundleOptions, async (verified) => {
    await collectReferenceReleaseRecords({
      materializedRoot: verified.materializedRoot,
      bundleManifest: verified.bundleManifest,
      onArtifact: async () => {},
      onRecord: async (record) => {
        if (record.role !== "VERIFIED_EVIDENCE") return;
        const payload = record.payload;
        if (payload.verification_status !== "VERIFIED") return;
        if (typeof payload.evidence_id !== "string") return;
        groundingByEvidenceId.set(payload.evidence_id, {
          documentId: payload.document_id ?? null,
          sourceNodeId: payload.metadata?.source_node_id ?? null,
        });
      },
    });
  });
  return groundingByEvidenceId;
}
