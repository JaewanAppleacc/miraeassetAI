import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPdfPageNodes,
  mapCTolerantNode,
  recommendReviewAction,
  recoveryNodeId,
  summarizeRecoveryCandidate,
} from "../domain/recovery/parse-recovery.mjs";

test("recovery node IDs are deterministic and namespaced", () => {
  const input = {
    documentId: "periodic_20260619000667",
    method: "PDF_TEXT_LAYER",
    relPath: "20260619000667.pdf",
    orderIndex: 1,
  };
  assert.equal(recoveryNodeId(input), recoveryNodeId(input));
  assert.match(recoveryNodeId(input), /^recovery_node_[0-9a-f]{24}$/);
});

test("maps C nodes without reusing C or A canonical node IDs", () => {
  const mapped = mapCTolerantNode("periodic_20250515001159", {
    kind: "TABLE",
    node_id: "node_upstream",
    raw_text: "매출액 100",
    hierarchy_path: ["사업의 내용"],
    source: { rel_path: "raw/x/20250515001159.xml", order_index: 7 },
    table_rows: [["매출액", "100"]],
  }, { adapter_name: "c-parser", adapter_version: "1.1.1", mode: "TOLERANT_XML" });
  assert.notEqual(mapped.recovery_node_id, "node_upstream");
  assert.equal(mapped.source_locator.rel_path, "20250515001159.xml");
  assert.equal(mapped.provenance.upstream_node_id, "node_upstream");
});

test("builds stable PDF page locators from form-feed page boundaries", () => {
  const nodes = buildPdfPageNodes(
    "periodic_20240514001522",
    "20240514001522.pdf",
    "첫 페이지\f둘째 페이지\f",
    "pdftotext-test",
  );
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].source_locator.page, 1);
  assert.equal(nodes[1].source_locator.page, 2);
  assert.equal(nodes[0].recovery_status, "CANDIDATE");
});

test("recovery candidates remain pending human review even when text improves", () => {
  const metrics = summarizeRecoveryCandidate({
    aNodes: [{ text: "짧은 원문" }],
    recoveryNodes: [{ block_type: "TABLE", raw_text: "더 길고 구조화된 복구 원문", table_rows: [] }],
  });
  assert.ok(metrics.text_gain_ratio > 1);
  assert.equal(recommendReviewAction("C_TOLERANT_XML", metrics), "HUMAN_REVIEW_REQUIRED");
});

test("duplicate-heavy recovery candidates are rejected before promotion", () => {
  const duplicate = { block_type: "PARAGRAPH", raw_text: "동일", table_rows: [] };
  const metrics = summarizeRecoveryCandidate({ recoveryNodes: [duplicate, duplicate, duplicate] });
  assert.ok(metrics.duplicate_node_ratio > 0.5);
  assert.equal(recommendReviewAction("C_TOLERANT_XML", metrics), "REJECT_DUPLICATE_HEAVY");
});
