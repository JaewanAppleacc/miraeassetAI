import { createHash } from "node:crypto";
import { basename } from "node:path";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function cNodeText(node) {
  const direct = normalizedText(node.raw_text);
  if (direct) return direct;
  return normalizedText((node.table_rows ?? []).flat().join(" "));
}

export function recoveryNodeId({ documentId, method, relPath, orderIndex }) {
  const digest = sha256(`${documentId}\0${method}\0${relPath}\0${orderIndex}`).slice(0, 24);
  return `recovery_node_${digest}`;
}

export function mapCTolerantNode(documentId, node, parser) {
  const relPath = basename(node?.source?.rel_path ?? "unknown");
  const orderIndex = Number(node?.source?.order_index ?? node?.order_index ?? 0);
  const method = "C_TOLERANT_XML";
  return {
    recovery_node_id: recoveryNodeId({ documentId, method, relPath, orderIndex }),
    document_id: documentId,
    recovery_method: method,
    recovery_status: "CANDIDATE",
    source_locator: {
      source_type: "DOCUMENT_NODE",
      rel_path: relPath,
      order_index: orderIndex,
      page: null,
    },
    block_type: String(node.kind ?? "PARAGRAPH").toUpperCase(),
    section_path: Array.isArray(node.hierarchy_path) ? node.hierarchy_path : [],
    raw_text: cNodeText(node),
    table_rows: Array.isArray(node.table_rows) ? node.table_rows : [],
    provenance: {
      producer: parser?.adapter_name ?? "unknown",
      producer_version: parser?.adapter_version ?? "unknown",
      upstream_node_id: node.node_id ?? null,
      upstream_mode: parser?.mode ?? null,
    },
  };
}

export function buildPdfPageNodes(documentId, relPath, extractedText, producerVersion) {
  const method = "PDF_TEXT_LAYER";
  return String(extractedText)
    .split("\f")
    .map((text, index) => ({ text: text.trim(), page: index + 1 }))
    .filter(({ text }) => text.length > 0)
    .map(({ text, page }) => ({
      recovery_node_id: recoveryNodeId({
        documentId,
        method,
        relPath,
        orderIndex: page,
      }),
      document_id: documentId,
      recovery_method: method,
      recovery_status: "CANDIDATE",
      source_locator: {
        source_type: "PDF_PAGE",
        rel_path: relPath,
        order_index: page - 1,
        page,
      },
      block_type: "PDF_PAGE_TEXT",
      section_path: [],
      raw_text: text,
      table_rows: [],
      provenance: {
        producer: "pdftotext",
        producer_version: producerVersion,
        upstream_node_id: null,
        upstream_mode: "LAYOUT_TEXT_LAYER",
      },
    }));
}

export function summarizeRecoveryCandidate({ aNodes = [], recoveryNodes = [] }) {
  const aChars = aNodes.reduce((sum, node) => sum + normalizedText(node.text).length, 0);
  const candidateChars = recoveryNodes.reduce(
    (sum, node) => sum + normalizedText(node.raw_text).length,
    0,
  );
  const tableCount = recoveryNodes.filter((node) => node.block_type === "TABLE").length;
  const signatures = recoveryNodes.map((node) => sha256([
    node.block_type,
    normalizedText(node.raw_text),
    JSON.stringify(node.table_rows),
  ].join("\0")));
  const unique = new Set(signatures).size;
  const duplicateNodeRatio = signatures.length === 0 ? 0 : (signatures.length - unique) / signatures.length;
  const textGainRatio = aChars === 0
    ? (candidateChars > 0 ? null : 0)
    : candidateChars / aChars;

  return {
    a_text_chars: aChars,
    candidate_text_chars: candidateChars,
    text_gain_ratio: textGainRatio,
    candidate_node_count: recoveryNodes.length,
    candidate_table_count: tableCount,
    duplicate_node_ratio: duplicateNodeRatio,
  };
}

export function recommendReviewAction(method, metrics) {
  if (metrics.candidate_text_chars === 0) return "KEEP_A_NO_RECOVERY";
  if (metrics.duplicate_node_ratio > 0.5) return "REJECT_DUPLICATE_HEAVY";
  if (method === "PDF_TEXT_LAYER") return "HUMAN_REVIEW_REQUIRED";
  if (
    metrics.a_text_chars > 0
    && metrics.candidate_text_chars <= metrics.a_text_chars
    && metrics.candidate_table_count === 0
  ) return "KEEP_A_NO_MEASURABLE_GAIN";
  return "HUMAN_REVIEW_REQUIRED";
}

export function overlaySha256(record) {
  return sha256(JSON.stringify(record));
}
