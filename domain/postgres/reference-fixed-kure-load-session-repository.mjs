// Turn P11-F0: durable state for the Resumable Bounded-Memory
// Fixed-512-o64 x KURE-v1 Hybrid Retrieval Loader
// (006_reference_fixed_kure_load_sessions.sql). Mirrors
// reference-dedup-load-session-repository.mjs's (Turn P8) exact pattern --
// every method issues a parameterized statement against the CALLER's own
// client/transaction; this module never opens or commits a transaction
// itself (the orchestrator in reference-fixed-kure-resumable-loader.mjs
// owns transaction boundaries).
//
// THE ONE THING EVERY METHOD HERE EXISTS TO AVOID: holding the full
// ~442k-chunk / ~442k-unique-text set in process memory. Every batch
// method takes and returns only the ONE batch it was given -- dedup is
// enforced by the table's own PRIMARY KEY via `ON CONFLICT ... DO
// NOTHING`, never by an in-process Set/Map.
//
// UNLIKE the dedup loader's materialization (canonical-text-per-row into
// 004's reference_dedup_canonical_texts, occurrence-per-row into
// reference_dedup_occurrences), THIS loader's finished output is
// CHUNK-per-row into 003's EXISTING reference_retrieval_chunks
// (source_kind='DOCUMENT_CHUNK') -- one row per chunk_id, each carrying
// its own copy of the embedding vector looked up from the matching
// canonical_queue row by embed_text_sha256 at materialization time. 003's
// schema was designed for exactly this (its own header: "source_kind =
// 'DOCUMENT_CHUNK' is reserved for the future full-corpus chunking
// pipeline").
import { createHash } from "node:crypto";

export class FixedKureLoadSessionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "FixedKureLoadSessionError";
    this.code = code ?? "FIXED_KURE_LOAD_SESSION_ERROR";
  }
}

function sha256Hex(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

// load_session_id is deterministic in the SAME pins -> SAME id sense as
// computeDedupLoadSessionId (Turn P8) -- one (corpus_snapshot_id,
// chunking_policy, embedding_config) identity, one session, one index.
export function computeFixedKureRetrievalIndexId({ releaseId, corpusSnapshotId, embeddingProvider, embeddingModel, embeddingRevision, chunkingPolicyId }) {
  return `fixed_kure_index_${sha256Hex({ releaseId, corpusSnapshotId, embeddingProvider, embeddingModel, embeddingRevision, chunkingPolicyId }).slice(0, 32)}`;
}

export function computeFixedKureLoadSessionId(pins) {
  return computeFixedKureRetrievalIndexId(pins).replace(/^fixed_kure_index_/, "fixed_kure_session_");
}

export function computeEmbeddingConfigSha256({ provider, model, revision, dimension, distanceMetric }) {
  return sha256Hex({ provider, model, revision, dimension, distance_metric: distanceMetric });
}

// Turn AC-FULL-LOAD-V2: the logical/attempt identity split (see
// 008_reference_fixed_kure_load_sessions_v2_identity.sql's header for the
// full rationale). logical_load_id is UNCHANGED from computeFixedKureLoadSessionId
// above -- same pins, same formula, same value -- given its own name because
// it is now ONE of two identities a row carries, not the only one.
export function computeFixedKureLogicalLoadId(pins) {
  return computeFixedKureLoadSessionId(pins);
}

// execution_attempt_id additionally folds in loaderContractVersion and
// codeRevision (006's existing code_revision column, reused -- not a new
// column), so two attempts of the SAME logical load under two DIFFERENT
// code revisions get two DIFFERENT ids/rows instead of colliding into
// createOrGetSession's CODE_REVISION_MISMATCH refusal.
export function computeFixedKureExecutionAttemptId({ logicalLoadId, loaderContractVersion, codeRevision }) {
  assertNonEmptyString(logicalLoadId, "logicalLoadId");
  assertNonEmptyString(loaderContractVersion, "loaderContractVersion");
  assertNonEmptyString(codeRevision, "codeRevision");
  return `fixed_kure_attempt_${sha256Hex({ logicalLoadId, loaderContractVersion, codeRevision }).slice(0, 32)}`;
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value === "") throw new TypeError(`${name} is required and must be a non-empty string`);
}

function toPgvectorLiteral(vector) {
  return `[${vector.join(",")}]`;
}

const SESSION_COLUMNS = `
  load_session_id, retrieval_index_id, release_id, corpus_snapshot_id, corpus_manifest_sha256,
  chunking_policy_id, chunking_policy_sha256, embedding_config_sha256, embedding_provider, embedding_model,
  embedding_revision, embedding_dimension, distance_metric, batch_size, discovery_batch_size, max_retry_attempts,
  lease_duration_ms, code_revision, status, source_files_progress, discovery_pass_number,
  pass1_chunk_stream_sha256, pass2_chunk_stream_sha256,
  expected_document_count, expected_total_chunk_count, expected_search_eligible_count, expected_unique_embeddable_count,
  discovered_document_count, discovered_total_chunk_count, discovered_search_eligible_count, discovered_unique_text_count,
  embedded_unique_text_count, materialized_chunk_count, last_error_code, created_at, updated_at,
  logical_load_id, execution_attempt_id, loader_contract_version, supersedes_load_session_id,
  terminal_diagnostics
`;

function trimmedSessionRow(row) {
  if (!row) return null;
  return Object.freeze({ ...row });
}

// Turn AC-STREAMING-FIXED-DISCOVERY: real-corpus reproduction (see the
// Turn's final report) showed the full-corpus OOM lives in this write path,
// not in domain/chunking/chunker.mjs (which measurement exonerated --
// unmodified per this Turn's own instructions). insertCanonicalBatch/
// insertChunkBatch now split their caller-given row array into row-count-
// AND payload-byte-bounded sub-batches before issuing any SQL, so a single
// discoveryBatchSize (document-count) batch that happens to contain a large
// document's many chunks never builds one oversized node-postgres text[]
// array-literal parameter in one client.query() call. Row/document/chunk
// count and content are UNCHANGED -- only how many SQL round trips they are
// split across.
//
// Caps fixed from real corpus per-chunk byte measurements (periodic-001.jsonl
// documents averaged ~2.5-3KB raw_text/chunk) BEFORE the real-corpus
// validation run, never tuned to its outcome: row count (750) is the
// expected binding constraint in the typical case; the payload-byte cap
// (12 MiB) is the safety net for outlier documents with unusually large
// individual chunks/metadata/source_spans.
const PG_WRITE_MAX_ROWS_PER_SUBBATCH = 750;
const PG_WRITE_MAX_PAYLOAD_BYTES_PER_SUBBATCH = 12 * 1024 * 1024;

// Opt-in, zero-cost-when-unset instrumentation: row/byte counts and
// heap/RSS only, NEVER raw chunk/document text.
const PG_TRACE = process.env.P11F0_PG_TRACE === "1";
function pgTrace(stage, extra = {}) {
  if (!PG_TRACE) return;
  const mem = process.memoryUsage();
  console.error(JSON.stringify({
    trace: "pg_write_trace", stage,
    heap_used: mem.heapUsed, heap_total: mem.heapTotal, rss: mem.rss,
    ...extra,
  }));
}

function byteLen(value) {
  if (value == null) return 0;
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

// Splits `rows` into sub-batches respecting BOTH PG_WRITE_MAX_ROWS_PER_SUBBATCH
// and PG_WRITE_MAX_PAYLOAD_BYTES_PER_SUBBATCH (estimated per row via
// `estimateRowBytes`). A single row whose own estimated size exceeds the
// payload cap still gets its own (oversized) sub-batch rather than being
// dropped, truncated, or merged -- every row is always inserted; only SQL
// round-trip granularity changes.
function splitIntoSubBatches(rows, estimateRowBytes) {
  const subBatches = [];
  let current = [];
  let currentBytes = 0;
  for (const row of rows) {
    const rowBytes = estimateRowBytes(row);
    const wouldExceedRows = current.length + 1 > PG_WRITE_MAX_ROWS_PER_SUBBATCH;
    const wouldExceedBytes = current.length > 0 && currentBytes + rowBytes > PG_WRITE_MAX_PAYLOAD_BYTES_PER_SUBBATCH;
    if (current.length > 0 && (wouldExceedRows || wouldExceedBytes)) {
      subBatches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(row);
    currentBytes += rowBytes;
  }
  if (current.length > 0) subBatches.push(current);
  return subBatches;
}

export function createFixedKureLoadSessionRepository({ client }) {
  if (!client || typeof client.query !== "function") throw new TypeError("client is required");

  async function getSession(loadSessionId) {
    assertNonEmptyString(loadSessionId, "loadSessionId");
    const result = await client.query(
      `SELECT ${SESSION_COLUMNS} FROM disclosure_reference.reference_fixed_kure_load_sessions WHERE load_session_id = $1`,
      [loadSessionId],
    );
    return trimmedSessionRow(result.rows[0]);
  }

  // Creates a CREATED session row if none exists; if one exists, verifies
  // the identity/config pins match exactly (fail-closed on any mismatch)
  // and returns it unmodified.
  async function createOrGetSession(pins) {
    const {
      releaseId, corpusSnapshotId, corpusManifestSha256,
      embeddingProvider, embeddingModel, embeddingRevision, embeddingDimension, distanceMetric,
      chunkingPolicyId, chunkingPolicySha256,
      batchSize, discoveryBatchSize, maxRetryAttempts, leaseDurationMs, codeRevision,
    } = pins;
    for (const [name, value] of Object.entries({
      releaseId, corpusSnapshotId, corpusManifestSha256, embeddingProvider, embeddingModel,
      embeddingRevision, chunkingPolicyId, chunkingPolicySha256, codeRevision,
    })) {
      assertNonEmptyString(value, name);
    }
    if (!Number.isInteger(embeddingDimension) || embeddingDimension < 1) throw new TypeError("embeddingDimension must be a positive integer");
    if (!["cosine", "l2", "inner_product"].includes(distanceMetric)) throw new TypeError("distanceMetric must be cosine|l2|inner_product");

    const loadSessionId = computeFixedKureLoadSessionId({ releaseId, corpusSnapshotId, embeddingProvider, embeddingModel, embeddingRevision, chunkingPolicyId });
    const retrievalIndexId = computeFixedKureRetrievalIndexId({ releaseId, corpusSnapshotId, embeddingProvider, embeddingModel, embeddingRevision, chunkingPolicyId });
    const embeddingConfigSha256 = computeEmbeddingConfigSha256({
      provider: embeddingProvider, model: embeddingModel, revision: embeddingRevision, dimension: embeddingDimension, distanceMetric,
    });

    const existing = await getSession(loadSessionId);
    if (existing) {
      // Additive fail-closed guard: code_revision is recorded on the row
      // but is NOT part of the load_session_id hash above (identity is
      // corpus/embedding/chunking pins only), so without this check a
      // session started under one code_revision could be silently resumed
      // -- and have checkpoint data written into it -- by a DIFFERENT
      // code_revision, with nothing recording that the two passes ran
      // under different code. Refuse instead of guessing which revision
      // is authoritative; the caller must resolve this explicitly (e.g.
      // an operator decision to supersede the old attempt) rather than
      // have this function pick a side.
      if (existing.code_revision !== codeRevision) {
        throw new FixedKureLoadSessionError(
          `load session "${loadSessionId}" already exists with a DIFFERENT code_revision `
          + `(recorded="${existing.code_revision}", requested="${codeRevision}") -- refusing to resume `
          + "under a different revision than it was started with; this would silently mix checkpoint "
          + "data across code versions",
          "CODE_REVISION_MISMATCH",
        );
      }
      if (existing.embedding_config_sha256 !== embeddingConfigSha256) {
        throw new FixedKureLoadSessionError(
          `load session "${loadSessionId}" already exists with a DIFFERENT embedding_config_sha256`,
          "EMBEDDING_CONFIG_MISMATCH",
        );
      }
      if (existing.corpus_manifest_sha256 !== corpusManifestSha256) {
        throw new FixedKureLoadSessionError(
          `load session "${loadSessionId}" already exists with a DIFFERENT corpus_manifest_sha256 -- refusing to reuse it against different source data`,
          "CORPUS_MANIFEST_MISMATCH",
        );
      }
      if (existing.chunking_policy_sha256 !== chunkingPolicySha256) {
        throw new FixedKureLoadSessionError(
          `load session "${loadSessionId}" already exists with a DIFFERENT chunking_policy_sha256`,
          "CHUNKING_POLICY_MISMATCH",
        );
      }
      return { session: existing, created: false };
    }

    // logical_load_id/execution_attempt_id are both set equal to
    // loadSessionId -- exactly the backfill invariant 008's migration
    // applied to every pre-existing row (see that migration's header): a
    // v1-API-created session IS its own logical load's only attempt.
    await client.query(
      `INSERT INTO disclosure_reference.reference_fixed_kure_load_sessions
         (load_session_id, retrieval_index_id, release_id, corpus_snapshot_id, corpus_manifest_sha256,
          chunking_policy_id, chunking_policy_sha256, embedding_config_sha256, embedding_provider, embedding_model,
          embedding_revision, embedding_dimension, distance_metric, batch_size, discovery_batch_size,
          max_retry_attempts, lease_duration_ms, code_revision, status, logical_load_id, execution_attempt_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'CREATED',$1,$1)`,
      [
        loadSessionId, retrievalIndexId, releaseId, corpusSnapshotId, corpusManifestSha256,
        chunkingPolicyId, chunkingPolicySha256, embeddingConfigSha256, embeddingProvider, embeddingModel,
        embeddingRevision, embeddingDimension, distanceMetric, batchSize, discoveryBatchSize,
        maxRetryAttempts, leaseDurationMs, codeRevision,
      ],
    );
    return { session: await getSession(loadSessionId), created: true };
  }

  // Turn AC-FULL-LOAD-V2 official supersession API. Marks a CREATED or
  // DISCOVERING row SUPERSEDED_ZERO_PROGRESS -- the row's OWN trigger
  // (008_reference_fixed_kure_load_sessions_v2_identity.sql) independently
  // re-verifies every discovered/embedded/materialized counter is exactly
  // zero and rejects (ILLEGAL_TRANSITION, from the transitionStatus RETURNING
  // 0 rows below) if not; this function does not trust its own caller's
  // belief that progress is zero, it relies on the DB-side guard being the
  // actual authority. The row is never deleted or reused -- only its status
  // and last_error_code change; load_session_id, logical_load_id, and every
  // other identity/pin column stay exactly as they were (enforced by the
  // same trigger).
  async function supersedeZeroProgressSession(loadSessionId, { reasonCode = "SUPERSEDED_ZERO_PROGRESS" } = {}) {
    return transitionStatus(loadSessionId, ["CREATED", "DISCOVERING"], "SUPERSEDED_ZERO_PROGRESS", {
      last_error_code: reasonCode,
    });
  }

  // Turn AC-VFINAL-ALIGNMENT-AND-DISCOVERY, section L official API: marks a
  // DISCOVERING row FAILED_DISCOVERY_RESOURCE_EXHAUSTED -- for an attempt
  // that made REAL, non-zero discovery progress before terminating due to
  // resource exhaustion (the real full-corpus OOM this Turn's own
  // investigation root-caused), as opposed to supersedeZeroProgressSession's
  // zero-progress case above. The row's OWN trigger
  // (010_reference_fixed_kure_failed_resource_exhausted_transition.sql)
  // independently re-verifies embedded_unique_text_count and
  // materialized_chunk_count are exactly zero and rejects
  // (ILLEGAL_TRANSITION, from transitionStatus's RETURNING 0 rows below) if
  // not -- this function does not trust its own caller's belief that
  // embedding/materialization never ran; discovery progress itself
  // (documents/chunks/unique-text counters) is preserved untouched, never
  // zeroed. The row is never deleted or reused -- only its status and
  // last_error_code change; every identity/pin column and every discovery
  // counter stay exactly as they were (enforced by the same trigger). Also
  // excluded from the active-attempt uniqueness gate (010's index), exactly
  // like SUPERSEDED_ZERO_PROGRESS, so a fresh attempt of the same logical
  // load may be created without colliding with this terminal row.
  async function failDiscoveryResourceExhausted(loadSessionId, { reasonCode = "FAILED_DISCOVERY_RESOURCE_EXHAUSTED" } = {}) {
    return transitionStatus(loadSessionId, ["DISCOVERING"], "FAILED_DISCOVERY_RESOURCE_EXHAUSTED", {
      last_error_code: reasonCode,
    });
  }

  // Turn AC-VFINAL-ALIGNMENT-AND-DISCOVERY (post-hoc correction) official
  // API: marks a DISCOVERY_COMPLETE row INVALID_DISCOVERY_CANONICAL_SCOPE
  // -- for an attempt whose discovered_unique_text_count/
  // expected_unique_embeddable_count include "orphan" canonical rows (a
  // unique embed_text referenced by NO retrieval_eligible=true chunk --
  // v1's pre-existing, unmodified-by-this-Turn unique-text tracking adds
  // every chunk's hash to the canonical queue regardless of eligibility).
  // chunk_staging/canonical_queue rows themselves are NOT deleted or
  // altered by this call -- only this row's own status/diagnostics change.
  // The trigger (012) independently re-verifies embedded_unique_text_count
  // and materialized_chunk_count are exactly zero and rejects otherwise;
  // this function does not trust its own caller's belief that neither ran.
  // Excluded from the active-attempt uniqueness gate, like
  // SUPERSEDED_ZERO_PROGRESS/FAILED_DISCOVERY_RESOURCE_EXHAUSTED.
  async function markInvalidDiscoveryCanonicalScope(loadSessionId, diagnostics) {
    return transitionStatus(loadSessionId, ["DISCOVERY_COMPLETE"], "INVALID_DISCOVERY_CANONICAL_SCOPE", {
      last_error_code: "INVALID_DISCOVERY_CANONICAL_SCOPE",
      terminal_diagnostics: JSON.stringify(diagnostics),
    });
  }

  // Turn AC-FULL-LOAD-V2 v2 attempt creation. Unlike createOrGetSession
  // (whose load_session_id hash excludes code_revision -- see that
  // function's own comment), this computes a load_session_id
  // (=execution_attempt_id) that DOES fold in loaderContractVersion +
  // codeRevision, so a fresh attempt of a logical load whose PRIOR attempt
  // was superseded gets its own distinct row/PK instead of colliding with
  // (and being fail-closed-refused by) the superseded row's identity.
  // retrieval_index_id is still computed from logical pins ONLY (unchanged
  // formula) -- see 008's migration header for why: the eventual
  // materialized index is named by logical identity, not by which attempt
  // produced it.
  async function createOrGetAttempt(pins) {
    const {
      releaseId, corpusSnapshotId, corpusManifestSha256,
      embeddingProvider, embeddingModel, embeddingRevision, embeddingDimension, distanceMetric,
      chunkingPolicyId, chunkingPolicySha256,
      batchSize, discoveryBatchSize, maxRetryAttempts, leaseDurationMs, codeRevision,
      loaderContractVersion, supersedesLoadSessionId = null,
    } = pins;
    assertNonEmptyString(loaderContractVersion, "loaderContractVersion");

    const logicalLoadId = computeFixedKureLogicalLoadId({ releaseId, corpusSnapshotId, embeddingProvider, embeddingModel, embeddingRevision, chunkingPolicyId });
    const retrievalIndexId = computeFixedKureRetrievalIndexId({ releaseId, corpusSnapshotId, embeddingProvider, embeddingModel, embeddingRevision, chunkingPolicyId });
    const executionAttemptId = computeFixedKureExecutionAttemptId({ logicalLoadId, loaderContractVersion, codeRevision });
    const embeddingConfigSha256 = computeEmbeddingConfigSha256({
      provider: embeddingProvider, model: embeddingModel, revision: embeddingRevision, dimension: embeddingDimension, distanceMetric,
    });

    const existing = await getSession(executionAttemptId);
    if (existing) {
      if (existing.logical_load_id !== logicalLoadId) {
        throw new FixedKureLoadSessionError(
          `execution attempt "${executionAttemptId}" already exists with a DIFFERENT logical_load_id (this should be impossible -- hash collision or corrupted row)`,
          "LOGICAL_LOAD_ID_MISMATCH",
        );
      }
      return { session: existing, created: false };
    }

    if (supersedesLoadSessionId) {
      const superseded = await getSession(supersedesLoadSessionId);
      if (!superseded) {
        throw new FixedKureLoadSessionError(`supersedesLoadSessionId "${supersedesLoadSessionId}" does not exist`, "SUPERSEDED_SESSION_NOT_FOUND");
      }
      if (superseded.status !== "SUPERSEDED_ZERO_PROGRESS") {
        throw new FixedKureLoadSessionError(
          `supersedesLoadSessionId "${supersedesLoadSessionId}" is not SUPERSEDED_ZERO_PROGRESS (status=${superseded.status}) -- supersede it via supersedeZeroProgressSession() before creating a replacement attempt`,
          "SUPERSEDED_SESSION_NOT_ACTUALLY_SUPERSEDED",
        );
      }
      if (superseded.logical_load_id !== logicalLoadId) {
        throw new FixedKureLoadSessionError(
          `supersedesLoadSessionId "${supersedesLoadSessionId}" has a DIFFERENT logical_load_id than this attempt -- refusing to link provenance across unrelated logical loads`,
          "SUPERSEDED_SESSION_LOGICAL_LOAD_MISMATCH",
        );
      }
    }

    await client.query(
      `INSERT INTO disclosure_reference.reference_fixed_kure_load_sessions
         (load_session_id, retrieval_index_id, release_id, corpus_snapshot_id, corpus_manifest_sha256,
          chunking_policy_id, chunking_policy_sha256, embedding_config_sha256, embedding_provider, embedding_model,
          embedding_revision, embedding_dimension, distance_metric, batch_size, discovery_batch_size,
          max_retry_attempts, lease_duration_ms, code_revision, status,
          logical_load_id, execution_attempt_id, loader_contract_version, supersedes_load_session_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'CREATED',$19,$20,$21,$22)`,
      [
        executionAttemptId, retrievalIndexId, releaseId, corpusSnapshotId, corpusManifestSha256,
        chunkingPolicyId, chunkingPolicySha256, embeddingConfigSha256, embeddingProvider, embeddingModel,
        embeddingRevision, embeddingDimension, distanceMetric, batchSize, discoveryBatchSize,
        maxRetryAttempts, leaseDurationMs, codeRevision,
        logicalLoadId, executionAttemptId, loaderContractVersion, supersedesLoadSessionId,
      ],
    );
    return { session: await getSession(executionAttemptId), created: true };
  }

  async function transitionStatus(loadSessionId, fromStatuses, toStatus, extraSet = {}) {
    const params = [loadSessionId, fromStatuses, toStatus];
    const setClauses = ["status = $3"];
    for (const [column, value] of Object.entries(extraSet)) {
      params.push(value);
      setClauses.push(`${column} = $${params.length}`);
    }
    const result = await client.query(
      `UPDATE disclosure_reference.reference_fixed_kure_load_sessions
       SET ${setClauses.join(", ")}
       WHERE load_session_id = $1 AND status::text = ANY($2::text[])
       RETURNING ${SESSION_COLUMNS}`,
      params,
    );
    if (result.rows.length === 0) {
      throw new FixedKureLoadSessionError(
        `load session "${loadSessionId}": cannot transition to ${toStatus} (not currently in one of [${fromStatuses.join(", ")}])`,
        "ILLEGAL_TRANSITION",
      );
    }
    return trimmedSessionRow(result.rows[0]);
  }

  async function updateDiscoveryCheckpoint(loadSessionId, { sourceFilesProgress, newDocumentCount, newTotalChunkCount, newSearchEligibleCount, newUniqueTextCount }) {
    const result = await client.query(
      `UPDATE disclosure_reference.reference_fixed_kure_load_sessions
       SET source_files_progress = $2::jsonb,
           discovered_document_count = discovered_document_count + $3,
           discovered_total_chunk_count = discovered_total_chunk_count + $4,
           discovered_search_eligible_count = discovered_search_eligible_count + $5,
           discovered_unique_text_count = discovered_unique_text_count + $6
       WHERE load_session_id = $1
       RETURNING ${SESSION_COLUMNS}`,
      [loadSessionId, JSON.stringify(sourceFilesProgress), newDocumentCount, newTotalChunkCount, newSearchEligibleCount, newUniqueTextCount],
    );
    return trimmedSessionRow(result.rows[0]);
  }

  // Turn AC-FULL-LOAD-V2 crash-recovery helper. runDiscoveryPass (the v1
  // streaming pass, unchanged) does not itself seek/resume from
  // source_files_progress -- a re-invocation always restreams the corpus
  // from its start. That is safe to let insertCanonicalBatch/insertChunkBatch
  // no-op-dedup on (ON CONFLICT DO NOTHING), but updateDiscoveryCheckpoint's
  // counters are INCREMENTS, not SETs -- restarting pass 1 without first
  // zeroing them would double-count. This only clears STAGING data for the
  // current, still-in-flight DISCOVERING attempt (never READY/FAILED/
  // SUPERSEDED_ZERO_PROGRESS -- the trigger's own terminal-status
  // immutability, and this function's own explicit status check, both
  // block that), so it never touches another attempt's rows and never
  // rewrites what a completed attempt already reported.
  async function resetDiscoveryCheckpoint(loadSessionId) {
    const session = await getSession(loadSessionId);
    if (!session) throw new FixedKureLoadSessionError(`load session "${loadSessionId}" not found`, "SESSION_NOT_FOUND");
    if (session.status !== "DISCOVERING") {
      throw new FixedKureLoadSessionError(
        `load session "${loadSessionId}": resetDiscoveryCheckpoint only allowed while DISCOVERING (status=${session.status})`,
        "ILLEGAL_RESET",
      );
    }
    await client.query("DELETE FROM disclosure_reference.reference_fixed_kure_chunk_staging WHERE load_session_id = $1", [loadSessionId]);
    await client.query("DELETE FROM disclosure_reference.reference_fixed_kure_canonical_queue WHERE load_session_id = $1", [loadSessionId]);
    const result = await client.query(
      `UPDATE disclosure_reference.reference_fixed_kure_load_sessions
       SET source_files_progress = '{}'::jsonb, discovery_pass_number = 0,
           pass1_chunk_stream_sha256 = NULL, pass2_chunk_stream_sha256 = NULL,
           discovered_document_count = 0, discovered_total_chunk_count = 0,
           discovered_search_eligible_count = 0, discovered_unique_text_count = 0
       WHERE load_session_id = $1 AND status = 'DISCOVERING'
       RETURNING ${SESSION_COLUMNS}`,
      [loadSessionId],
    );
    if (result.rows.length === 0) {
      throw new FixedKureLoadSessionError(`load session "${loadSessionId}": reset failed (status changed concurrently?)`, "ILLEGAL_RESET");
    }
    return trimmedSessionRow(result.rows[0]);
  }

  async function recordPassStreamSha256(loadSessionId, passNumber, streamSha256) {
    const column = passNumber === 1 ? "pass1_chunk_stream_sha256" : "pass2_chunk_stream_sha256";
    const result = await client.query(
      `UPDATE disclosure_reference.reference_fixed_kure_load_sessions
       SET ${column} = $2, discovery_pass_number = $3
       WHERE load_session_id = $1
       RETURNING ${SESSION_COLUMNS}`,
      [loadSessionId, streamSha256, passNumber],
    );
    return trimmedSessionRow(result.rows[0]);
  }

  async function completeDiscovery(loadSessionId) {
    const session = await getSession(loadSessionId);
    return transitionStatus(loadSessionId, ["DISCOVERING"], "DISCOVERY_COMPLETE", {
      expected_document_count: session.discovered_document_count,
      expected_total_chunk_count: session.discovered_total_chunk_count,
      expected_search_eligible_count: session.discovered_search_eligible_count,
      expected_unique_embeddable_count: session.discovered_unique_text_count,
    });
  }

  // Bulk-insert one discovery batch's DISTINCT-within-batch unique
  // embed_text rows. ON CONFLICT DO NOTHING is the entire cross-batch dedup
  // mechanism.
  async function insertCanonicalBatch(loadSessionId, rows) {
    if (rows.length === 0) return { insertedHashes: [] };
    const subBatches = splitIntoSubBatches(rows, (r) => byteLen(r.embedText) + byteLen(r.embedTextSha256) + 8);
    const insertedHashes = [];
    for (const subBatch of subBatches) {
      const hashes = subBatch.map((r) => r.embedTextSha256);
      const payloadBytes = subBatch.reduce((sum, r) => sum + byteLen(r.embedText), 0);

      pgTrace("before_canonical_select", { load_session_id: loadSessionId, row_count: subBatch.length, raw_text_bytes: payloadBytes, estimated_payload_bytes: payloadBytes + hashes.length * 64 });
      const existing = await client.query(
        `SELECT embed_text_sha256, embed_text FROM disclosure_reference.reference_fixed_kure_canonical_queue
         WHERE load_session_id = $1 AND embed_text_sha256 = ANY($2::text[])`,
        [loadSessionId, hashes],
      );
      const existingByHash = new Map(existing.rows.map((r) => [r.embed_text_sha256, r.embed_text]));
      for (const row of subBatch) {
        const priorText = existingByHash.get(row.embedTextSha256);
        if (priorText !== undefined && priorText !== row.embedText) {
          throw new FixedKureLoadSessionError(
            `embed_text_sha256 collision with different text content: ${row.embedTextSha256}`,
            "TEXT_SHA256_COLLISION",
          );
        }
      }

      pgTrace("before_canonical_insert", { load_session_id: loadSessionId, row_count: subBatch.length, raw_text_bytes: payloadBytes, estimated_payload_bytes: payloadBytes + hashes.length * 64 });
      // Turn AC-STREAMING-FIXED-DISCOVERY: jsonb_to_recordset instead of
      // unnest($n::text[]) -- a single JSON.stringify'd parameter goes
      // through node-postgres as a plain string (prepareValue's `typeof val
      // !== 'object'` branch), never through arrayString/escapeElement's
      // per-element regex .replace() loop (lib/utils.js), which real-corpus
      // reproduction traced the OOM into. Row/hash/text/char_length content
      // and ON CONFLICT DO NOTHING dedup semantics are unchanged.
      const canonicalPayload = subBatch.map((r) => ({
        t: r.embedTextSha256, c: r.embedText, l: r.charLength,
      }));
      const inserted = await client.query(
        `INSERT INTO disclosure_reference.reference_fixed_kure_canonical_queue (load_session_id, embed_text_sha256, embed_text, char_length)
         SELECT $1, x.t, x.c, x.l FROM jsonb_to_recordset($2::jsonb) AS x(t text, c text, l int)
         ON CONFLICT (load_session_id, embed_text_sha256) DO NOTHING
         RETURNING embed_text_sha256`,
        [loadSessionId, JSON.stringify(canonicalPayload)],
      );
      insertedHashes.push(...inserted.rows.map((r) => r.embed_text_sha256));
    }
    return { insertedHashes };
  }

  // Bulk-insert one discovery batch's chunk canonical-digest rows (the full
  // per-chunk provenance CLAUDE.md Turn P11-F0 section C requires).
  async function insertChunkBatch(loadSessionId, rows) {
    if (rows.length === 0) return { insertedCount: 0 };
    const subBatches = splitIntoSubBatches(rows, (r) =>
      byteLen(r.rawText) + byteLen(r.sectionPath) + byteLen(r.sourceLocator) + byteLen(r.sourceSpans) + byteLen(r.metadata) + 128);
    let insertedCount = 0;
    for (const subBatch of subBatches) {
      let rawTextBytes = 0;
      let spansMetadataBytes = 0;
      // Turn AC-STREAMING-FIXED-DISCOVERY: jsonb_to_recordset instead of
      // unnest($n::text[], ...) -- see insertCanonicalBatch's comment above
      // for why (a single JSON.stringify'd parameter bypasses node-postgres'
      // arrayString/escapeElement per-element regex .replace() loop, the
      // code path real-corpus reproduction traced the OOM into). Column
      // names/types/order and ON CONFLICT DO NOTHING semantics unchanged.
      const chunkPayload = subBatch.map((r) => {
        if (PG_TRACE) {
          rawTextBytes += byteLen(r.rawText);
          spansMetadataBytes += byteLen(r.sourceSpans) + byteLen(r.metadata) + byteLen(r.sectionPath);
        }
        return {
          chunk_id: r.chunkId, document_id: r.documentId, chunk_index: r.chunkIndex, chunk_type: r.chunkType,
          parent_chunk_id: r.parentChunkId ?? null, content_sha256: r.contentSha256,
          raw_text: r.rawText, embed_text_sha256: r.embedTextSha256, token_count: r.tokenCount,
          corp_code: r.corpCode ?? null, doc_group: r.docGroup, receipt_date: r.receiptDate ?? null,
          section_path: r.sectionPath ?? [], source_locator: r.sourceLocator, source_spans: r.sourceSpans ?? [],
          chunking_policy_id: r.chunkingPolicyId, chunking_policy_version: r.chunkingPolicyVersion,
          retrieval_eligible: r.retrievalEligible, metadata: r.metadata ?? {},
        };
      });
      pgTrace("before_chunk_insert", {
        load_session_id: loadSessionId, row_count: subBatch.length,
        raw_text_bytes: rawTextBytes, spans_metadata_bytes: spansMetadataBytes,
        estimated_payload_bytes: rawTextBytes + spansMetadataBytes,
      });
      const result = await client.query(
        `INSERT INTO disclosure_reference.reference_fixed_kure_chunk_staging
           (load_session_id, chunk_id, document_id, chunk_index, chunk_type, parent_chunk_id, content_sha256,
            raw_text, embed_text_sha256, token_count,
            corp_code, doc_group, receipt_date, section_path, source_locator, source_spans,
            chunking_policy_id, chunking_policy_version, retrieval_eligible, metadata)
         SELECT $1, x.chunk_id, x.document_id, x.chunk_index, x.chunk_type, x.parent_chunk_id, x.content_sha256,
                x.raw_text, x.embed_text_sha256, x.token_count,
                x.corp_code, x.doc_group, x.receipt_date, x.section_path, x.source_locator, x.source_spans,
                x.chunking_policy_id, x.chunking_policy_version, x.retrieval_eligible, x.metadata
         FROM jsonb_to_recordset($2::jsonb) AS x(
           chunk_id text, document_id text, chunk_index int, chunk_type text, parent_chunk_id text, content_sha256 text,
           raw_text text, embed_text_sha256 text, token_count int,
           corp_code text, doc_group text, receipt_date text, section_path jsonb, source_locator text, source_spans jsonb,
           chunking_policy_id text, chunking_policy_version text, retrieval_eligible boolean, metadata jsonb)
         ON CONFLICT (load_session_id, chunk_id) DO NOTHING
         RETURNING chunk_id`,
        [loadSessionId, JSON.stringify(chunkPayload)],
      );
      insertedCount += result.rows.length;
    }
    return { insertedCount };
  }

  // Lease (FOR UPDATE SKIP LOCKED) up to `limit` unique-text rows that are
  // either PENDING or whose previous lease has expired.
  async function leaseCanonicalBatch(loadSessionId, { limit, leaseOwner, leaseDurationMs }) {
    const result = await client.query(
      `WITH candidates AS (
         SELECT embed_text_sha256 FROM disclosure_reference.reference_fixed_kure_canonical_queue
         WHERE load_session_id = $1
           AND (status = 'PENDING' OR (status = 'LEASED' AND lease_expires_at < now()))
         ORDER BY embed_text_sha256
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       UPDATE disclosure_reference.reference_fixed_kure_canonical_queue q
       SET status = 'LEASED', lease_owner = $3, lease_expires_at = now() + ($4 || ' milliseconds')::interval,
           attempt_count = q.attempt_count + 1
       FROM candidates
       WHERE q.load_session_id = $1 AND q.embed_text_sha256 = candidates.embed_text_sha256
       RETURNING q.embed_text_sha256, q.embed_text, q.attempt_count`,
      [loadSessionId, limit, leaseOwner, String(leaseDurationMs)],
    );
    return result.rows;
  }

  async function markEmbedded(loadSessionId, entries) {
    if (entries.length === 0) return;
    await client.query(
      `UPDATE disclosure_reference.reference_fixed_kure_canonical_queue q
       SET status = 'EMBEDDED', embedding = x.embedding::vector, lease_owner = NULL, lease_expires_at = NULL, last_error_code = NULL
       FROM unnest($2::text[], $3::text[]) AS x(embed_text_sha256, embedding)
       WHERE q.load_session_id = $1 AND q.embed_text_sha256 = x.embed_text_sha256`,
      [loadSessionId, entries.map((e) => e.embedTextSha256), entries.map((e) => toPgvectorLiteral(e.embedding))],
    );
    await client.query(
      `UPDATE disclosure_reference.reference_fixed_kure_load_sessions
       SET embedded_unique_text_count = embedded_unique_text_count + $2 WHERE load_session_id = $1`,
      [loadSessionId, entries.length],
    );
  }

  async function markEmbeddingBatchFailed(loadSessionId, textHashes, { maxRetryAttempts, errorCode }) {
    const result = await client.query(
      `UPDATE disclosure_reference.reference_fixed_kure_canonical_queue
       SET status = (CASE WHEN attempt_count >= $3 THEN 'FAILED' ELSE 'PENDING' END)::disclosure_reference.fixed_kure_queue_status,
           lease_owner = NULL, lease_expires_at = NULL, last_error_code = $4
       WHERE load_session_id = $1 AND embed_text_sha256 = ANY($2::text[])
       RETURNING embed_text_sha256, status`,
      [loadSessionId, textHashes, maxRetryAttempts, errorCode],
    );
    return {
      permanentlyFailed: result.rows.filter((r) => r.status === "FAILED").map((r) => r.embed_text_sha256),
      requeued: result.rows.filter((r) => r.status === "PENDING").map((r) => r.embed_text_sha256),
    };
  }

  async function queueStatusCounts(loadSessionId) {
    const result = await client.query(
      `SELECT status, count(*)::int AS n FROM disclosure_reference.reference_fixed_kure_canonical_queue
       WHERE load_session_id = $1 GROUP BY status`,
      [loadSessionId],
    );
    const counts = { PENDING: 0, LEASED: 0, EMBEDDED: 0, FAILED: 0 };
    for (const row of result.rows) counts[row.status] = row.n;
    return counts;
  }

  async function ensureRetrievalIndexRow({ retrievalIndexId, releaseId, corpusSnapshotId, embeddingProvider, embeddingModel, embeddingRevision, embeddingDimension, distanceMetric, chunkingPolicyId, chunkingPolicySha256, manifestSha256 }) {
    await client.query(
      `INSERT INTO disclosure_reference.reference_retrieval_indexes
         (retrieval_index_id, release_id, source_snapshot_id, embedding_provider, embedding_model, embedding_revision,
          embedding_dimension, distance_metric, chunking_policy_id, chunking_policy_sha256, index_status, manifest_sha256)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'LOADING',$11)
       ON CONFLICT (retrieval_index_id) DO NOTHING`,
      [retrievalIndexId, releaseId, corpusSnapshotId, embeddingProvider, embeddingModel, embeddingRevision, embeddingDimension, distanceMetric, chunkingPolicyId, chunkingPolicySha256, manifestSha256],
    );
  }

  // Materializes one batch of staged chunks into 003's
  // reference_retrieval_chunks (source_kind='DOCUMENT_CHUNK'), joining each
  // chunk's embed_text_sha256 against the canonical_queue's EMBEDDED
  // embedding. A chunk whose embed_text is not yet EMBEDDED is simply not
  // selected this pass (picked up on a later call once embedding catches
  // up) -- never materialized with a placeholder/null vector.
  async function materializeChunkBatch(loadSessionId, retrievalIndexId, limit) {
    const candidates = await client.query(
      `SELECT s.chunk_id, s.document_id, s.corp_code, s.chunk_index, s.chunk_type, s.parent_chunk_id,
              s.source_locator, s.content_sha256, s.raw_text, s.metadata,
              q.embed_text_sha256, q.embedding
       FROM disclosure_reference.reference_fixed_kure_chunk_staging s
       JOIN disclosure_reference.reference_fixed_kure_canonical_queue q
         ON q.load_session_id = s.load_session_id AND q.embed_text_sha256 = s.embed_text_sha256 AND q.status = 'EMBEDDED'
       WHERE s.load_session_id = $1 AND s.materialized = false
       ORDER BY s.chunk_id LIMIT $2 FOR UPDATE OF s SKIP LOCKED`,
      [loadSessionId, limit],
    );
    if (candidates.rows.length === 0) return { materializedCount: 0, done: true };
    const chunkIds = candidates.rows.map((r) => r.chunk_id);
    // chunk_type/parent_chunk_id have no dedicated column on 003's
    // reference_retrieval_chunks (a table shared with VERIFIED_EVIDENCE
    // rows that have no such concept) -- folded into `metadata` instead,
    // where the RetrieverAdapter reads them back for
    // RetrieverResult.chunk_type/parent_chunk_id.
    const mergedMetadata = candidates.rows.map((r) => JSON.stringify({ ...(r.metadata ?? {}), chunk_type: r.chunk_type, parent_chunk_id: r.parent_chunk_id }));
    await client.query(
      `INSERT INTO disclosure_reference.reference_retrieval_chunks
         (retrieval_index_id, chunk_id, source_kind, record_key, evidence_id, source_document_id, corp_code,
          source_locator, chunk_ordinal, text_content, text_sha256, metadata, embedding)
       SELECT $1, x.chunk_id, 'DOCUMENT_CHUNK', x.chunk_id, NULL, x.document_id, x.corp_code,
              x.source_locator, x.chunk_index, x.raw_text, x.content_sha256, x.metadata, x.embedding::vector
       FROM unnest(
         $2::text[], $3::text[], $4::text[], $5::int[], $6::text[], $7::text[], $8::text[], $9::jsonb[], $10::text[]
       ) AS x(chunk_id, document_id, corp_code, chunk_index, source_locator, raw_text, content_sha256, metadata, embedding)
       ON CONFLICT (retrieval_index_id, chunk_id) DO NOTHING`,
      [
        retrievalIndexId, chunkIds,
        candidates.rows.map((r) => r.document_id), candidates.rows.map((r) => r.corp_code),
        candidates.rows.map((r) => r.chunk_index), candidates.rows.map((r) => r.source_locator),
        candidates.rows.map((r) => r.raw_text), candidates.rows.map((r) => r.content_sha256),
        mergedMetadata, candidates.rows.map((r) => r.embedding),
      ],
    );
    await client.query(
      `UPDATE disclosure_reference.reference_fixed_kure_chunk_staging SET materialized = true
       WHERE load_session_id = $1 AND chunk_id = ANY($2::text[])`,
      [loadSessionId, chunkIds],
    );
    await client.query(
      `UPDATE disclosure_reference.reference_fixed_kure_load_sessions
       SET materialized_chunk_count = materialized_chunk_count + $2 WHERE load_session_id = $1`,
      [loadSessionId, chunkIds.length],
    );
    return { materializedCount: chunkIds.length, done: false };
  }

  async function finalize(loadSessionId, retrievalIndexId) {
    const session = await getSession(loadSessionId);
    const chunkActual = await client.query(
      "SELECT count(*)::int AS n FROM disclosure_reference.reference_retrieval_chunks WHERE retrieval_index_id = $1 AND source_kind = 'DOCUMENT_CHUNK'",
      [retrievalIndexId],
    );
    const chunkCount = chunkActual.rows[0].n;
    const mismatches = [];
    if (session.discovered_search_eligible_count !== session.expected_search_eligible_count) mismatches.push("discovered_search_eligible_count != expected_search_eligible_count");
    if (session.discovered_unique_text_count !== session.expected_unique_embeddable_count) mismatches.push("discovered_unique_text_count != expected_unique_embeddable_count");
    if (session.embedded_unique_text_count !== session.discovered_unique_text_count) mismatches.push("embedded_unique_text_count != discovered_unique_text_count");
    if (session.materialized_chunk_count !== session.discovered_search_eligible_count) mismatches.push("materialized_chunk_count != discovered_search_eligible_count");
    if (chunkCount !== session.discovered_search_eligible_count) mismatches.push(`actual chunk row count (${chunkCount}) != discovered_search_eligible_count (${session.discovered_search_eligible_count})`);
    if (!session.pass1_chunk_stream_sha256 || session.pass1_chunk_stream_sha256 !== session.pass2_chunk_stream_sha256) mismatches.push("pass1_chunk_stream_sha256 != pass2_chunk_stream_sha256 (double-pass determinism check failed)");

    if (mismatches.length > 0) {
      throw new FixedKureLoadSessionError(`finalization refused -- READY guard failed: ${mismatches.join("; ")}`, "FINALIZATION_MISMATCH");
    }

    await client.query(
      `UPDATE disclosure_reference.reference_retrieval_indexes
       SET index_status = 'READY', ready_at = now(), record_count = $2
       WHERE retrieval_index_id = $1`,
      [retrievalIndexId, chunkCount],
    );
    return transitionStatus(loadSessionId, ["MATERIALIZING"], "READY");
  }

  // Turn AC-STREAMING-FIXED-DISCOVERY: runs `fn` (which may itself issue
  // several sub-batched insertCanonicalBatch/insertChunkBatch round trips --
  // see splitIntoSubBatches above) inside one BEGIN/COMMIT. A caller that
  // wraps insertCanonicalBatch + insertChunkBatch + updateDiscoveryCheckpoint
  // in this gets atomicity across all of them: on any error, ROLLBACK
  // guarantees no half-applied discovery batch (some chunk rows written,
  // checkpoint counters not updated, or vice versa) is ever left behind.
  async function runInTransaction(fn) {
    await client.query("BEGIN");
    try {
      const result = await fn();
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }

  return Object.freeze({
    getSession, createOrGetSession, createOrGetAttempt, supersedeZeroProgressSession, failDiscoveryResourceExhausted, markInvalidDiscoveryCanonicalScope, resetDiscoveryCheckpoint,
    transitionStatus, updateDiscoveryCheckpoint, recordPassStreamSha256, completeDiscovery,
    insertCanonicalBatch, insertChunkBatch, leaseCanonicalBatch, markEmbedded, markEmbeddingBatchFailed,
    queueStatusCounts, ensureRetrievalIndexRow, materializeChunkBatch, finalize, runInTransaction,
  });
}
