// Turn P10: the REAL, resolvable document universe available in this
// worktree for chunking comparison. The full 4,204-document corpus is NOT
// materialized here (see domain/adapters/a-document-ir-reader.mjs's own
// comment: "the full corpus ... was never materialized in this repo").
// What IS materialized is the seed-release-v0.20-r3.candidate bundle's
// CANONICAL_DOCUMENT_IR_BASE + _DELTA DocumentIR records (68 total before
// dedup) plus VERIFIED_FACT/VERIFIED_EVIDENCE/COMPANY_DIRECTORY roles.
//
// chunk.schema.json requires a REAL 8-digit metadata.corp_code per chunk.
// This bundle's DocumentIR records do not carry corp_code directly (see
// b-canonical-to-chunker-input.mjs's header comment); the only real,
// non-fabricated source of document_id -> corp_code in this bundle is
// VERIFIED_FACT.source_document_id -> VERIFIED_FACT.corp_code (the SAME
// resolution domain/agent-comparison/embedding-calibration/dataset.mjs
// already performs for the 98-item calibration set). A document with no
// resolvable corp_code is EXCLUDED here, never assigned a placeholder.
//
// This deliberately reuses the same bundle-reading harness (reference-
// release-loader.mjs / reference-release-contract.mjs) every other P9/P10
// bundle reader already uses -- no second bundle-parsing path.
import { withVerifiedReferenceBundle } from "../../postgres/reference-release-loader.mjs";
import { collectReferenceReleaseRecords } from "../../postgres/reference-release-contract.mjs";

export const P10_BUNDLE_OPTIONS_FACTORY = (root) => Object.freeze({
  root,
  bundleDir: `${root}/domain/releases/bundles/seed-release-v0.20-r3.candidate`,
  bundleManifestPath: `${root}/domain/releases/bundles/seed-release-v0.20-r3.candidate/bundle-manifest.json`,
  finalManifestPath: `${root}/domain/releases/seed-release.v0.20.manifest.json`,
  finalDecisionPath: `${root}/domain/releases/seed-release.v0.20.decision.json`,
  expectedReleaseId: "seed-release-v0.20",
});

// Collects, read-only, from the materialized (then cleaned-up) bundle:
//  - canonicalByDocumentId: document_id -> canonical DocumentIR record
//    (BASE loaded first; DELTA entries overwrite same-document_id BASE
//    entries -- base+delta is the documented seed-release semantics)
//  - corpCodeByDocumentId: document_id -> corp_code, resolved ONLY via a
//    VERIFIED_FACT whose source_document_id equals this document_id
//  - companyByCorpCode: corp_code -> { corpName, listedName }
export async function collectResolvableBundleCorpus(bundleOptions) {
  const canonicalByDocumentId = new Map();
  const canonicalRoleByDocumentId = new Map(); // document_id -> "CANONICAL_DOCUMENT_IR_BASE" | "_DELTA", for audit
  const corpCodeByDocumentId = new Map();
  const companyByCorpCode = new Map();

  await withVerifiedReferenceBundle(bundleOptions, async (verified) => {
    await collectReferenceReleaseRecords({
      materializedRoot: verified.materializedRoot,
      bundleManifest: verified.bundleManifest,
      onArtifact: async () => {},
      onRecord: async (record) => {
        if (record.role === "CANONICAL_DOCUMENT_IR_BASE" || record.role === "CANONICAL_DOCUMENT_IR_DELTA") {
          canonicalByDocumentId.set(record.payload.document_id, record.payload);
          canonicalRoleByDocumentId.set(record.payload.document_id, record.role);
          return;
        }
        if (record.role === "VERIFIED_FACT") {
          const payload = record.payload;
          if (payload.verification_status !== "VERIFIED") return;
          if (typeof payload.source_document_id === "string" && typeof payload.corp_code === "string") {
            corpCodeByDocumentId.set(payload.source_document_id, payload.corp_code);
          }
          return;
        }
        if (record.role === "COMPANY_DIRECTORY") {
          const payload = record.payload;
          if (typeof payload.corp_code === "string") {
            companyByCorpCode.set(payload.corp_code, { corpName: payload.corp_name ?? null, listedName: payload.listed_name ?? null });
          }
        }
      },
    });
  });

  return Object.freeze({
    canonicalByDocumentId,
    canonicalRoleByDocumentId,
    corpCodeByDocumentId,
    companyByCorpCode,
  });
}

// Reduces a collected corpus to the resolvable subset: documents that have
// BOTH a canonical DocumentIR record AND a resolved corp_code. Returns an
// array sorted by document_id (deterministic iteration order for every
// downstream consumer -- never Map insertion order, which depends on JSONL
// scan order).
export function resolvableDocumentEntries(corpus) {
  const entries = [];
  for (const [documentId, canonicalRecord] of corpus.canonicalByDocumentId) {
    const corpCode = corpus.corpCodeByDocumentId.get(documentId);
    if (!corpCode) continue;
    const company = corpus.companyByCorpCode.get(corpCode) ?? { corpName: null, listedName: null };
    entries.push({
      documentId,
      canonicalRecord,
      corpCode,
      corpName: company.corpName,
      listedName: company.listedName,
      canonicalRole: corpus.canonicalRoleByDocumentId.get(documentId),
    });
  }
  entries.sort((a, b) => a.documentId.localeCompare(b.documentId));
  return entries;
}
