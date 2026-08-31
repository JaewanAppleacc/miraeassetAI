// Turn P8: Resumable Bounded-Memory Dedup Embedding Loader.
//
// Loads the SAME 004 tables (reference_dedup_indexes/canonical_texts/
// occurrences) that reference-dedup-retrieval-loader.mjs (Turn P5.2) loads,
// but via four independently-resumable, bounded-memory phases instead of
// one in-process pass that holds every distinct embedding in a Map:
//
//   DISCOVERY      streams the source JSONL and populates the DB-backed
//                  canonical queue + occurrence staging tables, batch by
//                  batch, checkpointing (byte_offset, line_number) in the
//                  SAME transaction as each batch's rows.
//   EMBEDDING      leases (FOR UPDATE SKIP LOCKED) bounded batches of
//                  PENDING canonical rows, calls embedDocuments on ONLY
//                  that batch, validates the result, writes vectors back.
//   MATERIALIZATION copies EMBEDDED canonical rows and staged occurrences
//                  into 004's own tables in bounded batches.
//   FINALIZATION   re-verifies every count against the real tables before
//                  ever flipping the 004 index (and this session) to READY.
//
// No step here ever holds more than one batch's worth of rows in memory --
// see reference-dedup-load-session-repository.mjs's own header for why
// each DB write is structured as a bounded batch with ON CONFLICT DO
// NOTHING rather than an in-process Set/Map.
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import { RequestAbortedError } from "../runtime/abortable.mjs";
import { BudgetExceededError } from "../runtime/agent-runtime.mjs";
import { createDedupLoadSessionRepository, DedupLoadSessionError, computeDedupLoadSessionId } from "./reference-dedup-load-session-repository.mjs";

export class ResumableDedupLoaderError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ResumableDedupLoaderError";
    this.code = code ?? "RESUMABLE_DEDUP_LOADER_ERROR";
  }
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const VALID_PARSE_STATUSES = new Set(["SUCCESS", "PARTIAL", "FAILED"]);

function parseAndValidateChunk(line, lineNumber) {
  let chunk;
  try {
    chunk = JSON.parse(line);
  } catch (error) {
    throw new ResumableDedupLoaderError(`malformed JSONL at line ${lineNumber}: ${error.message}`, "MALFORMED_ROW");
  }
  for (const field of ["chunk_id", "source_document_id", "node_id", "source_locator", "text_sha256", "text_content"]) {
    if (typeof chunk[field] !== "string" || chunk[field] === "") {
      throw new ResumableDedupLoaderError(`line ${lineNumber}: missing required non-empty string field "${field}"`, "MALFORMED_ROW");
    }
  }
  const blockType = chunk.metadata?.block_type;
  if (typeof blockType !== "string" || blockType === "") {
    throw new ResumableDedupLoaderError(`line ${lineNumber}: metadata.block_type is required`, "MALFORMED_ROW");
  }
  if (!VALID_PARSE_STATUSES.has(chunk.parse_status)) {
    throw new ResumableDedupLoaderError(`line ${lineNumber}: invalid parse_status ${chunk.parse_status}`, "MALFORMED_ROW");
  }
  return chunk;
}

// Resumable JSONL reader: seeks DIRECTLY to `startByteOffset` (a real
// filesystem seek via fs.createReadStream's own `start` option, never a
// "read from the top and skip N lines" scan) and yields one parsed+
// validated chunk per line, along with the byte offset immediately AFTER
// that line and its 1-based line number. `startByteOffset` must always be
// exactly the first byte of a line (i.e. the byte offset recorded after a
// PREVIOUS complete line) -- the loader only ever persists checkpoints at
// that granularity, so this invariant holds by construction.
export async function* readJsonlFromOffset(filePath, { startByteOffset = 0, startLineNumber = 0, signal } = {}) {
  const stream = createReadStream(filePath, { start: startByteOffset, encoding: "utf8", highWaterMark: 1024 * 1024 });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let byteOffset = startByteOffset;
  let lineNumber = startLineNumber;
  try {
    for await (const line of rl) {
      if (signal?.aborted) throw new RequestAbortedError(signal.reason?.reason ?? "ABORTED");
      byteOffset += Buffer.byteLength(line, "utf8") + 1; // +1 for the newline readline stripped
      lineNumber += 1;
      if (line.trim() === "") continue;
      const chunk = parseAndValidateChunk(line, lineNumber);
      yield { chunk, lineNumber, byteOffset };
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

function toLoaderChunk(chunk) {
  return {
    chunkId: chunk.chunk_id,
    textSha256: chunk.text_sha256,
    canonicalText: chunk.text_content,
    charLength: chunk.text_content.length,
    sourceDocumentId: chunk.source_document_id,
    corpCode: chunk.corp_code ?? null,
    sourceGroup: chunk.source_group ?? null,
    documentType: chunk.document_type ?? null,
    nodeId: chunk.node_id,
    sourceLocator: chunk.source_locator,
    blockType: chunk.metadata.block_type,
    parseStatus: chunk.parse_status,
    chunkOrdinal: chunk.chunk_ordinal,
    charStart: chunk.char_start,
    charEnd: chunk.char_end,
    metadata: chunk.metadata ?? {},
  };
}

// -------------------------------------------------------------------------
// Session bootstrap
// -------------------------------------------------------------------------

export async function createOrResumeLoadSession({
  client, releaseId, snapshotId, snapshotManifestSha256, documentChunksSha256,
  embeddingConfig, distanceMetric = "cosine", chunkingPolicyId, chunkingPolicySha256,
  batchSize = 500, discoveryBatchSize = 1000, maxRetryAttempts = 3, leaseDurationMs = 60_000, codeRevision,
}) {
  if (!embeddingConfig || typeof embeddingConfig.provider !== "string" || typeof embeddingConfig.model !== "string"
    || typeof embeddingConfig.revision !== "string" || !Number.isInteger(embeddingConfig.dimension)) {
    throw new TypeError("embeddingConfig must be { provider, model, revision, dimension }");
  }
  const repo = createDedupLoadSessionRepository({ client });
  const { session, created } = await repo.createOrGetSession({
    releaseId, snapshotId, snapshotManifestSha256, documentChunksSha256,
    embeddingProvider: embeddingConfig.provider, embeddingModel: embeddingConfig.model, embeddingRevision: embeddingConfig.revision,
    embeddingDimension: embeddingConfig.dimension, distanceMetric, chunkingPolicyId, chunkingPolicySha256,
    batchSize, discoveryBatchSize, maxRetryAttempts, leaseDurationMs, codeRevision,
  });
  if (session.status === "FAILED") {
    throw new DedupLoadSessionError(`load session "${session.load_session_id}" is permanently FAILED (last_error_code=${session.last_error_code}) -- a FAILED session can never be promoted to READY; start a new session identity to retry`, "SESSION_FAILED");
  }
  return { session, created };
}

// -------------------------------------------------------------------------
// DISCOVERY
// -------------------------------------------------------------------------

// Runs discovery batches until end-of-file, `maxBatches` is reached (test
// hook for bounded/interrupted runs), or the signal aborts. Every batch is
// its own transaction: the checkpoint update and that batch's rows commit
// atomically, so a crash between batches can never duplicate or lose rows
// on resume -- the next call simply re-opens the file at the last
// committed byte_offset.
export async function runDiscoveryPhase({ client, loadSessionId, chunksFilePath, maxBatches = Infinity, signal }) {
  const repo = createDedupLoadSessionRepository({ client });
  let session = await repo.getSession(loadSessionId);
  if (!session) throw new ResumableDedupLoaderError(`unknown load session: ${loadSessionId}`, "UNKNOWN_SESSION");
  if (session.status === "CREATED") {
    session = await repo.transitionStatus(loadSessionId, ["CREATED"], "DISCOVERING");
  } else if (session.status === "PAUSED") {
    session = await repo.transitionStatus(loadSessionId, ["PAUSED"], "DISCOVERING");
  } else if (session.status !== "DISCOVERING") {
    throw new ResumableDedupLoaderError(`session ${loadSessionId} is not in a discoverable state (status=${session.status})`, "WRONG_PHASE");
  }

  let batchCount = 0;
  let batch = [];
  let lastLineNumber = session.source_line_number;
  // bigint columns come back from `pg` as strings (to avoid silent
  // precision loss past 2^53) -- fs.createReadStream's `start` option
  // requires an actual number.
  let lastByteOffset = Number(session.source_byte_offset);
  let reachedEnd = false;

  async function flushBatch() {
    if (batch.length === 0) return;
    const localHashes = new Map();
    for (const row of batch) {
      const prior = localHashes.get(row.textSha256);
      if (prior !== undefined && prior !== row.canonicalText) {
        throw new ResumableDedupLoaderError(`text_sha256 collision with different text_content within one discovery batch: ${row.textSha256}`, "TEXT_SHA256_COLLISION");
      }
      localHashes.set(row.textSha256, row.canonicalText);
    }
    const uniqueRows = [...localHashes.entries()].map(([textSha256, canonicalText]) => ({
      textSha256, canonicalText, charLength: canonicalText.length,
    }));

    await client.query("BEGIN");
    try {
      const { insertedHashes } = await repo.insertCanonicalBatch(loadSessionId, uniqueRows);
      const { insertedCount } = await repo.insertOccurrenceBatch(loadSessionId, batch);
      if (insertedCount !== batch.length) {
        throw new ResumableDedupLoaderError(
          `discovery batch ending at line ${lastLineNumber}: expected to insert ${batch.length} new occurrence rows but only ${insertedCount} were new -- the source contains a duplicate chunk_id that was not already committed by an earlier checkpoint`,
          "DUPLICATE_CHUNK_ID",
        );
      }
      await repo.updateDiscoveryCheckpoint(loadSessionId, {
        byteOffset: lastByteOffset, lineNumber: lastLineNumber,
        newCanonicalCount: insertedHashes.length, occurrenceCount: batch.length,
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
    batch = [];
    batchCount += 1;
  }

  for await (const { chunk, lineNumber, byteOffset } of readJsonlFromOffset(chunksFilePath, {
    startByteOffset: lastByteOffset, startLineNumber: session.source_line_number, signal,
  })) {
    batch.push(toLoaderChunk(chunk));
    lastLineNumber = lineNumber;
    lastByteOffset = byteOffset;
    if (batch.length >= session.discovery_batch_size) {
      // eslint-disable-next-line no-await-in-loop
      await flushBatch();
      if (batchCount >= maxBatches) {
        return { status: "DISCOVERING", reachedEnd: false, batchesRun: batchCount };
      }
    }
  }
  await flushBatch();
  reachedEnd = true;

  const finalSession = await repo.completeDiscovery(loadSessionId);
  return { status: finalSession.status, reachedEnd, batchesRun: batchCount, session: finalSession };
}

// -------------------------------------------------------------------------
// EMBEDDING
// -------------------------------------------------------------------------

function assertFiniteVector(vector, dimension) {
  return Array.isArray(vector) && vector.length === dimension && vector.every((v) => typeof v === "number" && Number.isFinite(v));
}

// Leases and embeds bounded batches until the queue has no PENDING/expired-
// LEASED rows left, `maxBatches` is reached, or a permanent failure stops
// the whole session. Safe to run from MULTIPLE concurrent workers against
// the same loadSessionId (see leaseCanonicalBatch's FOR UPDATE SKIP LOCKED)
// -- each worker should pass its own unique `leaseOwner`.
export async function runEmbeddingPhase({
  client, loadSessionId, embeddingAdapter, embeddingConfig, batchSize, maxRetryAttempts, leaseDurationMs,
  leaseOwner = `worker_${process.pid}_${randomUUID()}`, maxBatches = Infinity, signal,
}) {
  const repo = createDedupLoadSessionRepository({ client });
  const session = await repo.getSession(loadSessionId);
  if (!session) throw new ResumableDedupLoaderError(`unknown load session: ${loadSessionId}`, "UNKNOWN_SESSION");
  if (!["DISCOVERY_COMPLETE", "EMBEDDING", "PAUSED"].includes(session.status)) {
    throw new ResumableDedupLoaderError(`session ${loadSessionId} is not embeddable (status=${session.status})`, "WRONG_PHASE");
  }
  if (session.status !== "EMBEDDING") {
    // A concurrent worker may have already made this same transition
    // between our getSession() above and this call -- that is a benign
    // race (the row is already exactly where we wanted it), not an error.
    try {
      await repo.transitionStatus(loadSessionId, [session.status], "EMBEDDING");
    } catch (error) {
      if (!(error instanceof DedupLoadSessionError && error.code === "ILLEGAL_TRANSITION")) throw error;
      const current = await repo.getSession(loadSessionId);
      if (current.status !== "EMBEDDING") throw error;
    }
  }

  const resolvedBatchSize = batchSize ?? session.batch_size;
  const resolvedMaxRetry = maxRetryAttempts ?? session.max_retry_attempts;
  const resolvedLeaseMs = leaseDurationMs ?? session.lease_duration_ms;

  let batchesRun = 0;
  let permanentFailureCount = 0;
  for (;;) {
    if (signal?.aborted) throw new RequestAbortedError(signal.reason?.reason ?? "ABORTED");
    if (batchesRun >= maxBatches) break;

    // Lease acquisition is its own short transaction -- the embedding API
    // call below must never happen while holding row locks.
    // eslint-disable-next-line no-await-in-loop
    await client.query("BEGIN");
    let leased;
    try {
      leased = await repo.leaseCanonicalBatch(loadSessionId, { limit: resolvedBatchSize, leaseOwner, leaseDurationMs: resolvedLeaseMs });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
    if (leased.length === 0) break;
    batchesRun += 1;

    let vectors;
    try {
      // eslint-disable-next-line no-await-in-loop
      vectors = await embeddingAdapter.embedDocuments(leased.map((r) => r.canonical_text), embeddingConfig);
    } catch (error) {
      if (error instanceof RequestAbortedError || error instanceof BudgetExceededError) throw error; // never swallowed into retry
      // eslint-disable-next-line no-await-in-loop
      const { permanentlyFailed } = await repo.markEmbeddingBatchFailed(loadSessionId, leased.map((r) => r.text_sha256), {
        maxRetryAttempts: resolvedMaxRetry, errorCode: "EMBEDDING_ADAPTER_ERROR",
      });
      permanentFailureCount += permanentlyFailed.length;
      continue;
    }

    const malformed = !Array.isArray(vectors) || vectors.length !== leased.length
      || !vectors.every((v) => assertFiniteVector(v, embeddingConfig.dimension));
    if (malformed) {
      // eslint-disable-next-line no-await-in-loop
      const { permanentlyFailed } = await repo.markEmbeddingBatchFailed(loadSessionId, leased.map((r) => r.text_sha256), {
        maxRetryAttempts: resolvedMaxRetry, errorCode: "MALFORMED_EMBEDDING_BATCH",
      });
      permanentFailureCount += permanentlyFailed.length;
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    await client.query("BEGIN");
    try {
      await repo.markEmbedded(loadSessionId, leased.map((r, i) => ({ textSha256: r.text_sha256, embedding: vectors[i] })));
      await client.query(
        "UPDATE disclosure_reference.reference_dedup_load_sessions SET embedded_canonical_count = embedded_canonical_count + $2 WHERE load_session_id = $1",
        [loadSessionId, leased.length],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  }

  // Guards the terminal EMBEDDING -> {MATERIALIZING|FAILED} transition
  // against the benign race of two concurrent workers BOTH observing
  // "queue fully drained" at nearly the same moment: whichever gets there
  // first wins the transition; the other's own attempt legitimately fails
  // ILLEGAL_TRANSITION (the row is no longer in EMBEDDING) -- that is not a
  // real error, just re-read the session another worker already advanced.
  async function advanceTerminalStatus(toStatus, extraSet) {
    try {
      return await repo.transitionStatus(loadSessionId, ["EMBEDDING"], toStatus, extraSet);
    } catch (error) {
      if (error instanceof DedupLoadSessionError && error.code === "ILLEGAL_TRANSITION") {
        const current = await repo.getSession(loadSessionId);
        if (current.status === toStatus || current.status === "READY") return current;
      }
      throw error;
    }
  }

  const counts = await repo.queueStatusCounts(loadSessionId);
  const outstanding = counts.PENDING + counts.LEASED;
  if (outstanding === 0 && counts.FAILED === 0) {
    const finalSession = await advanceTerminalStatus("MATERIALIZING");
    return { status: finalSession.status, batchesRun, counts, permanentFailureCount, done: true };
  }
  if (outstanding === 0 && counts.FAILED > 0) {
    const finalSession = await advanceTerminalStatus("FAILED", { last_error_code: "EMBEDDING_PERMANENTLY_FAILED" });
    return { status: finalSession.status, batchesRun, counts, permanentFailureCount, done: false };
  }
  return { status: "EMBEDDING", batchesRun, counts, permanentFailureCount, done: false };
}

// -------------------------------------------------------------------------
// MATERIALIZATION
// -------------------------------------------------------------------------

export async function runMaterializationPhase({ client, loadSessionId, materializationBatchSize = 500, maxBatches = Infinity }) {
  const repo = createDedupLoadSessionRepository({ client });
  const session = await repo.getSession(loadSessionId);
  if (!session) throw new ResumableDedupLoaderError(`unknown load session: ${loadSessionId}`, "UNKNOWN_SESSION");
  if (!["MATERIALIZING", "PAUSED"].includes(session.status)) {
    throw new ResumableDedupLoaderError(`session ${loadSessionId} is not materializable (status=${session.status})`, "WRONG_PHASE");
  }
  if (session.status !== "MATERIALIZING") {
    await repo.transitionStatus(loadSessionId, [session.status], "MATERIALIZING");
  }

  const embeddingConfigHash = sha256Hex(JSON.stringify({
    provider: session.embedding_provider, model: session.embedding_model, dimension: session.embedding_dimension,
  }));
  await client.query("BEGIN");
  try {
    await repo.ensureRetrievalIndexRow({
      retrievalIndexId: session.retrieval_index_id, releaseId: session.release_id, sourceSnapshotId: session.snapshot_id,
      embeddingProvider: session.embedding_provider, embeddingModel: session.embedding_model, embeddingRevision: session.embedding_revision,
      embeddingDimension: session.embedding_dimension, distanceMetric: session.distance_metric,
      chunkingPolicyId: session.chunking_policy_id, chunkingPolicySha256: session.chunking_policy_sha256,
      manifestSha256: session.embedding_config_sha256,
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }

  let batchesRun = 0;
  let canonicalDone = false;
  let occurrenceDone = false;
  while (batchesRun < maxBatches && !(canonicalDone && occurrenceDone)) {
    if (!canonicalDone) {
      // eslint-disable-next-line no-await-in-loop
      await client.query("BEGIN");
      let result;
      try {
        // eslint-disable-next-line no-await-in-loop
        result = await repo.materializeCanonicalBatch(loadSessionId, session.retrieval_index_id, embeddingConfigHash, materializationBatchSize);
        // eslint-disable-next-line no-await-in-loop
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
      canonicalDone = result.done;
      if (result.materializedCount > 0) batchesRun += 1;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await client.query("BEGIN");
    let result;
    try {
      // eslint-disable-next-line no-await-in-loop
      result = await repo.materializeOccurrenceBatch(loadSessionId, session.retrieval_index_id, materializationBatchSize);
      // eslint-disable-next-line no-await-in-loop
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
    occurrenceDone = result.done;
    if (result.materializedCount > 0) batchesRun += 1;
  }

  if (canonicalDone && occurrenceDone) {
    return { status: "MATERIALIZING", batchesRun, done: true };
  }
  return { status: "MATERIALIZING", batchesRun, done: false };
}

// -------------------------------------------------------------------------
// FINALIZATION
// -------------------------------------------------------------------------

export async function runFinalizationPhase({ client, loadSessionId }) {
  const repo = createDedupLoadSessionRepository({ client });
  const session = await repo.getSession(loadSessionId);
  if (!session) throw new ResumableDedupLoaderError(`unknown load session: ${loadSessionId}`, "UNKNOWN_SESSION");
  if (session.status !== "MATERIALIZING") {
    throw new ResumableDedupLoaderError(`session ${loadSessionId} is not ready for finalization (status=${session.status})`, "WRONG_PHASE");
  }
  await client.query("BEGIN");
  try {
    const finalSession = await repo.finalize(loadSessionId, session.retrieval_index_id);
    await client.query("COMMIT");
    return { status: finalSession.status, retrievalIndexId: session.retrieval_index_id };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

// -------------------------------------------------------------------------
// Full-load convenience driver (still resumable -- just calls the phases
// above in the order dictated by the session's OWN current status).
// -------------------------------------------------------------------------

export async function runResumableDedupLoad(options) {
  const { client, loadSessionId } = options;
  const repo = createDedupLoadSessionRepository({ client });
  for (;;) {
    const session = await repo.getSession(loadSessionId);
    if (!session) throw new ResumableDedupLoaderError(`unknown load session: ${loadSessionId}`, "UNKNOWN_SESSION");
    if (session.status === "READY") return session;
    if (session.status === "FAILED") throw new DedupLoadSessionError(`load session "${loadSessionId}" is FAILED: ${session.last_error_code}`, "SESSION_FAILED");

    if (session.status === "CREATED" || session.status === "DISCOVERING" || (session.status === "PAUSED" && session.source_line_count === null)) {
      // eslint-disable-next-line no-await-in-loop
      await runDiscoveryPhase(options);
      continue;
    }
    if (session.status === "DISCOVERY_COMPLETE" || session.status === "EMBEDDING"
      || (session.status === "PAUSED" && session.source_line_count !== null && session.embedded_canonical_count < session.discovered_canonical_count)) {
      // eslint-disable-next-line no-await-in-loop
      await runEmbeddingPhase(options);
      continue;
    }
    if (session.status === "MATERIALIZING"
      || (session.status === "PAUSED" && session.embedded_canonical_count >= session.discovered_canonical_count && session.discovered_canonical_count > 0)) {
      // eslint-disable-next-line no-await-in-loop
      const result = await runMaterializationPhase(options);
      if (result.done) {
        // eslint-disable-next-line no-await-in-loop
        await runFinalizationPhase(options);
      }
      continue;
    }
    throw new ResumableDedupLoaderError(`session ${loadSessionId}: unable to determine resume phase from status=${session.status}`, "UNRESOLVABLE_RESUME_STATE");
  }
}

export { computeDedupLoadSessionId };
