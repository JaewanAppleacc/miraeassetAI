import test from "node:test";
import assert from "node:assert/strict";
import { extractExchangeContractBundle } from "../domain/facts/extract-exchange-contract.mjs";

const document = {
  document_id: "exchange_20260130800516",
  corp_code: "00126362",
  doc_subtype: "단일판매공급계약체결",
  receipt_date: "2026-01-30",
  is_correction: false,
};
const source = {
  corpus_snapshot_id: "snap_source",
  nodes: [{
    kind: "table",
    node_id: "table-1",
    source: { rel_path: "20260130800516.xml", order_index: 0 },
    normalized_rows: [
      ["2. 계약내역", "계약금액(원)", "-"],
      ["3. 계약상대", "3. 계약상대", "-"],
      ["5. 계약기간", "시작일", "-"],
      ["5. 계약기간", "종료일", "-"],
      ["8. 공시유보 관련내용", "유보사유", "경영상 비밀유지"],
      ["8. 공시유보 관련내용", "유보기한", "2030.01.01"],
    ],
  }],
};
const ontology = new Map();

test("extracts explicitly withheld contract values as WITHHELD", () => {
  const bundle = extractExchangeContractBundle(source, document, ontology, {
    targetCorpusSnapshotId: "corpus_target",
    createdAt: "2026-08-04T00:00:00.000Z",
  });
  const amount = bundle.facts.find((fact) => fact.metric_code === "CONTRACT_AMOUNT");
  assert.equal(amount.value_status, "WITHHELD");
  assert.equal(amount.normalized_value, null);
  assert.equal(amount.withheld_until, "2030-01-01");
  const reason = bundle.facts.find((fact) => fact.metric_code === "WITHHELD_REASON");
  assert.equal(reason.value_status, "DISCLOSED");
  assert.equal(reason.normalized_value, "경영상 비밀유지");
});

test("preserves planned certainty markers", () => {
  const planned = structuredClone(source);
  planned.nodes[0].normalized_rows[0][2] = "2,655,600,000,000(예정)";
  const bundle = extractExchangeContractBundle(planned, document, ontology, {
    createdAt: "2026-08-04T00:00:00.000Z",
  });
  const amount = bundle.facts.find((fact) => fact.metric_code === "CONTRACT_AMOUNT");
  assert.equal(amount.value_certainty, "PLANNED");
  assert.equal(amount.normalized_value, 2655600000000);
});

