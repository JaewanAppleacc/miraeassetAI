// Turn P5: pure assembly of one document-record row and its chunk rows from
// (a) domain/adapters/a-document-ir.mjs's own adapted DocumentIR + coverage
// state, and (b) the corpus manifest row that carries corp_code/doc_group/
// doc_subtype/rcept_dt (fields DocumentIR itself never carries -- see this
// module's README). No I/O here; build-snapshot.mjs is the only place that
// touches the filesystem.
import { chunkBlocks } from "./chunking-policy.mjs";
import { coverageStateToParseStatus, computeSnapshotChunkId, sha256Hex, PARSE_STATUS } from "./contracts.mjs";

export class ManifestJoinError extends Error {
  constructor(message) {
    super(message);
    this.name = "ManifestJoinError";
  }
}

function assertManifestRow(manifestRow, documentId) {
  if (!manifestRow) {
    throw new ManifestJoinError(`document_id ${documentId} has no corresponding row in the corpus manifest (fail-closed -- corp_code/doc_group cannot be guessed)`);
  }
  if (manifestRow.doc_id !== documentId) {
    throw new ManifestJoinError(`manifest row doc_id ${manifestRow.doc_id} does not match document_id ${documentId}`);
  }
}

function blockTypeCounts(blocks) {
  const counts = {};
  for (const block of blocks) counts[block.block_type] = (counts[block.block_type] ?? 0) + 1;
  return counts;
}

export function buildDocumentRecord({ schemaVersion, snapshotId, adapted, coverage, manifestRow, chunkCount }) {
  const documentId = adapted.document_id;
  assertManifestRow(manifestRow, documentId);
  const parseStatus = coverageStateToParseStatus(coverage.state);
  const retrievalEligible = parseStatus !== PARSE_STATUS.FAILED;

  return {
    schema_version: schemaVersion,
    snapshot_id: snapshotId,
    source_document_id: documentId,
    corp_code: manifestRow.corp_code,
    source_group: manifestRow.doc_group,
    document_type: manifestRow.doc_subtype ?? null,
    report_name: manifestRow.report_nm ?? null,
    is_correction: Boolean(manifestRow.is_correction),
    receipt_no: manifestRow.rcept_no,
    receipt_date: manifestRow.rcept_dt,
    as_of_period: Number.isInteger(manifestRow.base_year)
      ? { base_year: manifestRow.base_year, base_month: manifestRow.base_month ?? null }
      : null,
    coverage_state: coverage.state,
    coverage_reason_code: coverage.reason_code,
    parse_status: parseStatus,
    retrieval_eligible: retrievalEligible,
    failure_reason: retrievalEligible ? null : coverage.reason_code,
    node_count: adapted.blocks.length,
    block_type_counts: blockTypeCounts(adapted.blocks),
    table_count: adapted.quality_summary.table_count,
    extracted_char_count: adapted.quality_summary.extracted_char_count,
    chunk_count: chunkCount,
    files: adapted.files.map((file) => ({
      file_id: file.file_id,
      relative_path: file.relative_path,
      file_role: file.file_role,
      detected_format: file.detected_format,
      parse_status: file.parse_status,
      content_sha256: file.content_sha256,
    })),
  };
}

// Returns an array of full chunk rows (every field the Turn P5 task
// requires). Empty when the document is PARSE_FAILED (0 blocks, by
// domain/adapters/a-document-ir.mjs's own mapCoverageState contract) or has
// no chunk-worthy node -- this function never invents a chunk to make a
// document non-empty.
export function buildChunkRecords({ schemaVersion, snapshotId, chunkingPolicyId, chunkingPolicySha256, adapted, coverage, manifestRow }) {
  const documentId = adapted.document_id;
  assertManifestRow(manifestRow, documentId);
  const parseStatus = coverageStateToParseStatus(coverage.state);
  if (parseStatus === PARSE_STATUS.FAILED) return [];

  const fileById = new Map(adapted.files.map((file) => [file.file_id, file]));
  const descriptors = chunkBlocks(adapted.blocks);
  const blockById = new Map(adapted.blocks.map((block) => [block.block_id, block]));

  return descriptors.map((descriptor, chunkOrdinal) => {
    const block = blockById.get(descriptor.node_id);
    const textSha256 = sha256Hex(descriptor.text_content);
    const chunkId = computeSnapshotChunkId({
      snapshotId,
      sourceDocumentId: documentId,
      nodeId: descriptor.node_id,
      chunkOrdinal,
      textSha256,
    });
    return {
      schema_version: schemaVersion,
      snapshot_id: snapshotId,
      chunking_policy_id: chunkingPolicyId,
      chunking_policy_sha256: chunkingPolicySha256,
      chunk_id: chunkId,
      source_document_id: documentId,
      corp_code: manifestRow.corp_code,
      source_group: manifestRow.doc_group,
      document_type: manifestRow.doc_subtype ?? null,
      source_locator: block.source_locator,
      node_id: descriptor.node_id,
      chunk_ordinal: chunkOrdinal,
      char_start: descriptor.char_start,
      char_end: descriptor.char_end,
      text_content: descriptor.text_content,
      text_sha256: textSha256,
      parse_status: parseStatus,
      metadata: {
        block_type: descriptor.block_type,
        section_path: descriptor.section_path,
        node_chunk_index: descriptor.node_chunk_index,
        node_chunk_count: descriptor.node_chunk_count,
        table_row_range: descriptor.table_row_range,
        file_id: block.file_id,
        file_relative_path: fileById.get(block.file_id)?.relative_path ?? null,
      },
    };
  });
}
