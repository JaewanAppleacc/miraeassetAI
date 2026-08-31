// Turn P9: Gold-blind Embedding Calibration dataset generation.
//
// Reads ONLY VERIFIED Evidence/Fact records from the ALREADY-APPROVED
// v0.20-r3 bundle, via the SAME read-only, materialize-then-cleanup
// harness reference-release-loader.mjs's own importReferenceRelease already
// uses (withVerifiedReferenceBundle + collectReferenceReleaseRecords) --
// this module adds NO new bundle-reading path and needs NO PostgreSQL
// connection at all (collectReferenceReleaseRecords reads the bundle's own
// JSONL files directly off the temp-materialized directory,
// withVerifiedReferenceBundle removes that temp directory in a `finally`
// regardless of success/failure).
//
// NEVER reads: Gold/HOLDOUT/DEV_GOLD files, SEED_GOLD role records, OWNER_DECISION/
// OWNER_BATCH_DECISION role records, evaluation split membership, or any
// Candidate Pool/Anchor allocation content -- this module's onRecord filter
// only ever registers VERIFIED_EVIDENCE and VERIFIED_FACT roles; every
// other role in the bundle manifest is silently ignored, never opened for
// a reason beyond "this role is irrelevant to embedding calibration."
import { createHash } from "node:crypto";
import { withVerifiedReferenceBundle } from "../../postgres/reference-release-loader.mjs";
import { collectReferenceReleaseRecords } from "../../postgres/reference-release-contract.mjs";

export class CalibrationDatasetError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "CalibrationDatasetError";
    this.code = code ?? "CALIBRATION_DATASET_ERROR";
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function sha256Hex(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(canonicalize(value)), "utf8").digest("hex");
}

// -------------------------------------------------------------------------
// Candidate collection: VERIFIED Evidence + a VERIFIED-Fact-derived
// document_id -> corp_code map (Evidence itself carries no corp_code field
// -- same resolution reference-vector-retrieval-loader.mjs's own
// buildDocumentCorpMap already performs for the Postgres path, reproduced
// here for the portable/no-DB path instead of importing that Postgres-only
// module).
// -------------------------------------------------------------------------

// Deterministic: when more than one VERIFIED Fact's evidence_ids[] lists
// the SAME evidence_id (a real, documented possibility -- see
// coverage-authorized-fact-view.mjs's own comment on this), the
// LEXICOGRAPHICALLY SMALLEST fact_id wins. This keeps candidate generation
// a pure function of the bundle's own content, never of JSONL scan order.
export async function collectVerifiedCalibrationCandidates(bundleOptions) {
  const evidenceById = new Map();
  const documentCorpByDocumentId = new Map();
  const factIdsByEvidenceId = new Map(); // evidence_id -> Set(fact_id)

  await withVerifiedReferenceBundle(bundleOptions, async (verified) => {
    await collectReferenceReleaseRecords({
      materializedRoot: verified.materializedRoot,
      bundleManifest: verified.bundleManifest,
      onArtifact: async () => {},
      onRecord: async (record) => {
        if (record.role === "VERIFIED_FACT") {
          const payload = record.payload;
          if (payload.verification_status !== "VERIFIED") return;
          if (typeof payload.source_document_id === "string" && typeof payload.corp_code === "string") {
            documentCorpByDocumentId.set(payload.source_document_id, payload.corp_code);
          }
          if (typeof payload.fact_id === "string" && Array.isArray(payload.evidence_ids)) {
            for (const evidenceId of payload.evidence_ids) {
              if (typeof evidenceId !== "string" || evidenceId === "") continue;
              if (!factIdsByEvidenceId.has(evidenceId)) factIdsByEvidenceId.set(evidenceId, new Set());
              factIdsByEvidenceId.get(evidenceId).add(payload.fact_id);
            }
          }
          return;
        }
        if (record.role === "VERIFIED_EVIDENCE") {
          const payload = record.payload;
          if (payload.verification_status !== "VERIFIED") return; // defensive; the bundle only ever contains VERIFIED rows under this role
          if (typeof payload.quoted_text !== "string" || payload.quoted_text.trim() === "") return; // never a candidate with an empty/absent quote
          if (typeof payload.evidence_id !== "string" || payload.evidence_id === "") return;
          evidenceById.set(payload.evidence_id, payload);
        }
      },
    });
  });

  const candidates = [];
  for (const [evidenceId, payload] of evidenceById) {
    const factIds = factIdsByEvidenceId.get(evidenceId);
    if (!factIds || factIds.size === 0) continue; // no VERIFIED Fact anchors this Evidence -- excluded, calibration items always carry a fact_id
    const factId = [...factIds].sort()[0];
    const corpCode = documentCorpByDocumentId.get(payload.document_id) ?? null;
    if (!corpCode) continue; // no resolvable corp_code -- excluded, corp_code metadata-filter smoke needs a real value
    candidates.push({
      evidenceId, factId, sourceDocumentId: payload.document_id, corpCode,
      quotedText: payload.quoted_text, inputTextSha256: sha256Hex(payload.quoted_text),
    });
  }
  // Stable, content-derived order (never JSONL scan order) so downstream
  // deterministic sampling is a pure function of bundle CONTENT alone.
  candidates.sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
  return candidates;
}

// -------------------------------------------------------------------------
// Deterministic, salted, bounded-stratified sampling.
// -------------------------------------------------------------------------

function saltedRank(salt, key) {
  return sha256Hex(`${salt}:${key}`);
}

// Same generic shape as the domain/evaluation deterministic-sampling
// pattern (sha256(salt+id), sort by hex digest, take a bounded prefix) --
// reimplemented locally rather than imported, so this module has zero
// coupling to domain/evaluation/** (never modified, never depended upon,
// per this Turn's own invariance list).
function deterministicSaltedOrder(items, keyOf, salt) {
  return [...items].sort((a, b) => saltedRank(salt, keyOf(a)).localeCompare(saltedRank(salt, keyOf(b))));
}

// Bounded stratification: walks the salted order and skips an item once its
// OWN corp_code would exceed maxPerCorp -- never reshuffles the salted
// order otherwise, so the accepted subset is still a deterministic function
// of (candidates, salt, maximumItemCount, maxCorpShare) alone.
export function selectCalibrationDataset({ candidates, maximumItemCount, sampleSalt, maxCorpShare = 0.25 }) {
  if (!Array.isArray(candidates)) throw new TypeError("candidates is required");
  if (!Number.isInteger(maximumItemCount) || maximumItemCount < 1) throw new TypeError("maximumItemCount must be a positive integer");
  if (typeof sampleSalt !== "string" || sampleSalt === "") throw new TypeError("sampleSalt is required");

  const seenEvidenceIds = new Set();
  const deduped = candidates.filter((c) => {
    if (seenEvidenceIds.has(c.evidenceId)) return false;
    seenEvidenceIds.add(c.evidenceId);
    return true;
  });

  const ordered = deterministicSaltedOrder(deduped, (c) => c.evidenceId, sampleSalt);
  const maxPerCorp = Math.max(1, Math.ceil(maximumItemCount * maxCorpShare));
  const countByCorp = new Map();
  const selected = [];
  for (const candidate of ordered) {
    if (selected.length >= maximumItemCount) break;
    const currentCount = countByCorp.get(candidate.corpCode) ?? 0;
    if (currentCount >= maxPerCorp) continue;
    countByCorp.set(candidate.corpCode, currentCount + 1);
    selected.push(candidate);
  }

  return selected.map((candidate) => {
    const calibrationItemId = `calitem_${saltedRank(sampleSalt, candidate.evidenceId).slice(0, 24)}`;
    return {
      calibrationItemId,
      factId: candidate.factId,
      evidenceId: candidate.evidenceId,
      sourceDocumentId: candidate.sourceDocumentId,
      corpCode: candidate.corpCode,
      inputTextSha256: candidate.inputTextSha256,
      expectedSelfMatchId: calibrationItemId,
      // textContent is carried ONLY on this in-memory item -- never written
      // to a manifest/report (see toManifestItems() below, which omits it).
      textContent: candidate.quotedText,
    };
  });
}

// -------------------------------------------------------------------------
// Manifest projection + deterministic dataset SHA.
// -------------------------------------------------------------------------

// The persisted-to-disk shape: IDs and a per-item SHA256 only. Never the
// quoted text itself -- reading this file back can never reconstruct any
// Evidence content, only confirm (via input_text_sha256) that a specific
// already-known text was the one used, or detect drift if it was not.
export function toManifestItems(datasetItems) {
  return datasetItems.map((item) => ({
    calibration_item_id: item.calibrationItemId,
    fact_id: item.factId,
    evidence_id: item.evidenceId,
    source_document_id: item.sourceDocumentId,
    corp_code: item.corpCode,
    input_text_sha256: item.inputTextSha256,
    expected_self_match_id: item.expectedSelfMatchId,
  }));
}

// Sensitive to BOTH content and ORDER changes -- deliberately never sorted
// before hashing (contrast with domain/agent-comparison/benchmark/item-sha.mjs's
// own computeDatasetItemsSha256, which sorts first so array order never
// matters for THAT hash). Two identical-membership datasets presented in a
// different order are, by design, two different calibration_dataset_sha256
// values here, because the selection ORDER (a function of sample_salt) is
// itself part of what this Turn's determinism requirement pins. Running the
// SAME generation twice from the SAME candidates+salt always reproduces the
// SAME order, so this remains fully reproducible.
export function computeCalibrationDatasetSha256(manifestItems) {
  const canonicalItems = manifestItems.map((item) => canonicalize(item));
  return sha256Hex(JSON.stringify(canonicalItems));
}

export function buildCalibrationDatasetManifest({ datasetId, sampleSalt, datasetManifestSha256Override, datasetItems, candidatePoolSize }) {
  const manifestItems = toManifestItems(datasetItems);
  const datasetSha256 = datasetManifestSha256Override ?? computeCalibrationDatasetSha256(manifestItems);
  const corpCounts = {};
  for (const item of manifestItems) corpCounts[item.corp_code] = (corpCounts[item.corp_code] ?? 0) + 1;
  return Object.freeze({
    schema_version: "0.1.0",
    dataset_id: datasetId,
    sample_salt: sampleSalt,
    candidate_pool_size: candidatePoolSize,
    item_count: manifestItems.length,
    distinct_evidence_count: new Set(manifestItems.map((i) => i.evidence_id)).size,
    corp_code_distribution: corpCounts,
    calibration_dataset_sha256: datasetSha256,
    items: manifestItems,
    ranking_performed: false,
    dev_gold_accessed: false,
    holdout_accessed: false,
  });
}
