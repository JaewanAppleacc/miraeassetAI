import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { adaptADocumentIR } from "../domain/adapters/a-document-ir.mjs";
import { ids, requiredFactSlotsSha256, stableId, validateEvaluationGoldV02 } from "../domain/contracts.mjs";
import { validateDocumentIrRecord, validateEvidenceRecord, validateFactRecord } from "../domain/adapters/seed-artifact-schema-validators.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED_AT = "2026-08-13T06:00:00.000Z";
const SNAPSHOT = "corpus_04750795e1a2d5c3";
const MANIFEST_SHA = "04750795e1a2d5c35f73e4bb7766ebede02ff3512d33c382bd4c3a51daba3364";
const DEFAULT_RAW_A_EXCHANGE = path.resolve(ROOT, "work/a-document-ir/source/exchange.jsonl");
const Q3 = "question_seed_v07_03";
const Q22 = "question_seed_v07_22";
const CHAIN = "chain_5f066abfdfb1d5a779e98abe";
const DOCS = [
  "exchange_20230626800002", "exchange_20240215801246", "exchange_20240522800200",
  "exchange_20240523800361", "exchange_20240524800345", "exchange_20240614800515",
  "exchange_20241128800562", "exchange_20250331802494", "exchange_20250415800827",
  "exchange_20250418800600", "exchange_20250611800358", "exchange_20250708800221",
  "exchange_20250714800342", "exchange_20250929800639", "exchange_20260120800597",
];
const NEED_ADAPT = new Set(DOCS.filter((id) => !["exchange_20250611800358", "exchange_20260120800597"].includes(id)));
const P = Object.freeze({
  goldIn: "work/domain-seed/seed-gold-promotion-candidates.v0.14.jsonl",
  evidenceIn: "work/domain-seed/seed-evidence-verified.v0.4.jsonl",
  evidenceManifestIn: "work/domain-seed/seed-evidence-verified.v0.4.manifest.json",
  factsIn: "work/domain-seed/seed-facts-verified.v0.2.jsonl",
  eventsIn: "work/domain-seed/seed-events-verified.v0.1.jsonl",
  coverageIn: "work/domain-seed/seed-fact-coverage-verified.v0.2.json",
  relationIn: "work/domain-seed/seed-relation-gold.v0.1.jsonl",
  chainIn: "work/domain-seed/seed-chain-manifest.v0.1.jsonl",
  ownerDecision: "work/domain-seed/seed-structured-owner-decision.v0.1.json",
  canonicalBase: "work/domain-seed/seed-canonical-document-ir.v0.6.jsonl",
  canonicalOldDelta: "work/domain-seed/seed-canonical-document-ir.v0.7.delta.jsonl",
  canonicalDelta: "work/domain-seed/seed-canonical-document-ir.v0.15.delta.jsonl",
  evidence: "work/domain-seed/seed-evidence-verified.v0.5.jsonl",
  evidenceManifest: "work/domain-seed/seed-evidence-verified.v0.5.manifest.json",
  facts: "work/domain-seed/seed-facts-verified.v0.3.jsonl",
  coverage: "work/domain-seed/seed-fact-coverage-verified.v0.3.json",
  relations: "work/domain-seed/seed-relation-gold.v0.2.jsonl",
  chains: "work/domain-seed/seed-chain-manifest.v0.2.jsonl",
  gold: "work/domain-seed/seed-gold-promotion-candidates.v0.15.jsonl",
  mapping: "work/domain-seed/seed-v14-to-v15-q3-q22-mapping.jsonl",
  report: "work/domain-seed/seed-gold-promotion-candidates.v0.15.review.md",
  canonicalRelease: "domain/releases/seed-release.v0.15.draft.manifest.json",
  structuredManifest: "work/domain-seed/seed-structured-artifacts.v0.3.manifest.json",
});
const abs = (value) => path.resolve(ROOT, value);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const jsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
const parseJsonl = (text) => text.split(/\r?\n/).filter(Boolean).map(JSON.parse);

async function loadAdaptedDocuments(rawAExchangePath) {
  const found = new Map();
  const lines = readline.createInterface({ input: createReadStream(rawAExchangePath), crlfDelay: Infinity });
  for await (const line of lines) {
    if (![...NEED_ADAPT].some((id) => line.includes(id))) continue;
    const source = JSON.parse(line);
    if (!NEED_ADAPT.has(source.doc_id)) continue;
    const adapted = adaptADocumentIR(source, { completedAt: GENERATED_AT });
    const errors = validateDocumentIrRecord(adapted);
    if (errors.length) throw new Error(`${source.doc_id}: ${errors.join("; ")}`);
    found.set(source.doc_id, adapted);
  }
  for (const id of NEED_ADAPT) if (!found.has(id)) throw new Error(`A DocumentIR source missing: ${id}`);
  return found;
}

function block(doc, node) {
  const locator = `${doc.document_id}/${doc.document_id.slice("exchange_".length)}.xml#node=${node}`;
  const value = doc.blocks.find((candidate) => candidate.source_locator === locator);
  if (!value) throw new Error(`${doc.document_id}: missing ${locator}`);
  return value;
}
function cell(doc, node, row, col) {
  const b = block(doc, node);
  const value = b.table?.raw_rows?.flat().find((candidate) => candidate.row === row && candidate.col === col);
  if (!value || typeof value.text !== "string" || value.text === "") throw new Error(`${doc.document_id}: missing cell ${node}/${row}/${col}`);
  return { block: b, value };
}
function evidenceFromCell(doc, node, row, col, slotNames, questionId) {
  const { block: b, value } = cell(doc, node, row, col);
  const source_locator = `${b.source_locator}&row=${row}&col=${col}`;
  const evidence_id = ids.evidence(doc.document_id, source_locator, value.text);
  return {
    evidence_id, document_id: doc.document_id, file_id: b.file_id, chunk_id: null,
    source_locator, quoted_text: value.text, quote_sha256: sha(value.text), extraction_method: "DETERMINISTIC",
    confidence: 1, verification_status: "VERIFIED",
    metadata: {
      review_status: "OWNER_ACCEPTED", corp_code: "00164478", source_node_id: b.block_id, row, column: col,
      linked_question_ids: [questionId], linked_slot_names: slotNames,
      verification_provenance: {
        review_method: "OWNER_DIRECT_CORPUS_REVIEW_AND_CODEX_RECHECK", owner_disposition: "ACCEPTED",
        source_revision: "seed-v0.15-q3-q22-integration", corpus_snapshot_id: SNAPSHOT, verified_at: GENERATED_AT,
      },
    },
  };
}
function source(e) { return { document_id: e.document_id, source_locator: e.source_locator, evidence_span: e.quoted_text }; }
function fact({ corp = "00164478", metric, value, valueType = "TEXT", unit = null, currency = null, scale = null, sourceDocument, evidenceIds, date, rawLabel, scope = "COMPANY", attributes = {} }) {
  const fact_id = ids.fact(corp, metric, `as_of:${date}`, scope, `seed-v0.15:${sourceDocument}:${rawLabel}`);
  return {
    fact_id, corp_code: corp, event_id: null, source_document_id: sourceDocument, metric_code: metric,
    raw_label: rawLabel, value_type: valueType, value_status: "DISCLOSED", value_certainty: "CONFIRMED",
    raw_value_text: typeof value === "string" ? value : String(value), raw_unit_text: unit === "KRW" ? "원" : unit === "PERCENT" ? "%" : unit === "SHARES" ? "주" : null,
    normalized_value: value, unit, currency, scale, scope, period_type: "POINT_IN_TIME", period_start: null, period_end: null,
    as_of_date: date, known_at: `${date}T00:00:00Z`, valid_from: `${date}T00:00:00Z`, valid_to: null,
    withheld_until: null, extraction_method: "DETERMINISTIC", confidence: 1, verification_status: "VERIFIED",
    evidence_ids: [...new Set(evidenceIds)], attributes: { ...attributes, review_provenance: { review_method: "OWNER_DIRECT_CORPUS_REVIEW_AND_CODEX_RECHECK", owner_disposition: "ACCEPTED", verified_at: GENERATED_AT } },
  };
}
function coverageSlot(questionId, slotName, factRecord, evidenceIds) {
  return {
    slot_key: `${questionId}::${slotName}`, corp_code: factRecord.corp_code, metric_code: factRecord.metric_code,
    period_key: `as_of:${factRecord.as_of_date}`, scope: factRecord.scope,
    coverage_state: "ALL_REQUIRED_FACT_SLOTS_VERIFIED", verification_status: "VERIFIED",
    fact_ids: [factRecord.fact_id], evidence_ids: [...new Set(evidenceIds)], reason_code: null,
  };
}
async function pin(role, file, recordCount = null) {
  const bytes = await readFile(abs(file));
  return { role, path: file, sha256: sha(bytes), bytes: bytes.length, record_count: recordCount };
}

export async function buildSeedQ3Q22V015({ rawAExchangePath = process.env.SEED_RAW_A_EXCHANGE_PATH ?? DEFAULT_RAW_A_EXCHANGE } = {}) {
  const [goldText, evidenceText, factsText, eventsText, coverageText, relationText, chainText, oldDeltaText] = await Promise.all([
    readFile(abs(P.goldIn), "utf8"), readFile(abs(P.evidenceIn), "utf8"), readFile(abs(P.factsIn), "utf8"),
    readFile(abs(P.eventsIn), "utf8"), readFile(abs(P.coverageIn), "utf8"), readFile(abs(P.relationIn), "utf8"),
    readFile(abs(P.chainIn), "utf8"), readFile(abs(P.canonicalOldDelta), "utf8"),
  ]);
  const adapted = await loadAdaptedDocuments(rawAExchangePath);
  const oldDelta = parseJsonl(oldDeltaText);
  const canonicalDelta = [...oldDelta, ...[...adapted.values()].sort((a, b) => a.document_id.localeCompare(b.document_id))];
  const canonicalDeltaText = jsonl(canonicalDelta);

  // Q3: four physical occurrences, not two content-only identities.
  const holdingDoc = parseJsonl(await readFile(abs(P.canonicalBase), "utf8")).find((d) => d.document_id === "holding_20250520000335");
  if (!holdingDoc) throw new Error("Q3 canonical document missing");
  const q3Specs = [
    [4, 1, "holding_before_count"], [4, 2, "holding_before_ratio"],
    [5, 1, "holding_after_count"], [5, 2, "holding_after_ratio"],
  ];
  const q3Evidence = q3Specs.map(([row, col, slot]) => {
    const b = holdingDoc.blocks.find((x) => x.source_locator.endsWith("#node=1"));
    const c = b.table.raw_rows.flat().find((x) => x.row === row && x.col === col);
    const source_locator = `${b.source_locator}&row=${row}&col=${col}`;
    return {
      evidence_id: ids.evidence(holdingDoc.document_id, source_locator, c.text), document_id: holdingDoc.document_id,
      file_id: b.file_id, chunk_id: null, source_locator, quoted_text: c.text, quote_sha256: sha(c.text),
      extraction_method: "DETERMINISTIC", confidence: 1, verification_status: "VERIFIED",
      metadata: { review_status: "OWNER_ACCEPTED", corp_code: "00102858", source_node_id: b.block_id, row, column: col,
        linked_question_ids: [Q3], linked_slot_names: [slot], verification_provenance: {
          review_method: "OWNER_DIRECT_CORPUS_REVIEW_AND_CODEX_RECHECK", owner_disposition: "ACCEPTED",
          identity_basis: "CELL_QUALIFIED_SOURCE_LOCATOR", corpus_snapshot_id: SNAPSHOT, verified_at: GENERATED_AT,
        } },
    };
  });

  // Q22: correction date, reason and changed cells from every missing correction document.
  const q22Evidence = [];
  for (const id of DOCS.slice(1, -1)) {
    const doc = adapted.get(id) ?? null;
    if (!doc) continue; // 2025-06-11 already has reviewed block Evidence.
    q22Evidence.push(evidenceFromCell(doc, 0, 0, 1, ["correction_timeline"], Q22));
    q22Evidence.push(evidenceFromCell(doc, 1, 2, 1, ["correction_timeline"], Q22));
    if (id === "exchange_20240522800200") {
      q22Evidence.push(evidenceFromCell(doc, 1, 5, 1, ["correction_timeline"], Q22));
      q22Evidence.push(evidenceFromCell(doc, 1, 5, 2, ["correction_timeline"], Q22));
    } else {
      q22Evidence.push(evidenceFromCell(doc, 1, 6, 1, ["correction_timeline"], Q22));
      q22Evidence.push(evidenceFromCell(doc, 1, 6, 2, ["correction_timeline"], Q22));
    }
  }
  // Latest fields not present in the older block-level Evidence pool.
  const latest = parseJsonl(await readFile(abs(P.canonicalBase), "utf8")).find((d) => d.document_id === "exchange_20260120800597");
  for (const [row, col, slot] of [[6, 1, "latest_counterparty"], [8, 1, "latest_location"]]) {
    q22Evidence.push(evidenceFromCell(latest, 3, row, col, [slot], Q22));
  }
  const latestNarrative = evidenceFromCell(latest, 3, 16, 0, ["latest_package_terms", "latest_equity_shares"], Q22);
  q22Evidence.push(latestNarrative);

  const oldEvidence = parseJsonl(evidenceText).filter((e) => !["evidence_de26667ffeffcf7a5726d929", "evidence_6a6bab6035e60635631be785"].includes(e.evidence_id));
  const evidence = [...oldEvidence, ...q3Evidence, ...q22Evidence];
  const evidenceIds = new Set();
  for (const e of evidence) {
    const errors = validateEvidenceRecord(e); if (errors.length) throw new Error(`${e.evidence_id}: ${errors.join("; ")}`);
    if (evidenceIds.has(e.evidence_id)) throw new Error(`duplicate Evidence: ${e.evidence_id}`); evidenceIds.add(e.evidence_id);
  }
  const evidenceOut = jsonl(evidence);

  const q22ExistingIds = parseJsonl(goldText).find((x) => x.question_id === Q22).extensions.evidence_ids;
  const evidenceById = new Map(evidence.map((e) => [e.evidence_id, e]));
  const q22AllEvidenceIds = [...new Set([...q22ExistingIds, ...q22Evidence.map((e) => e.evidence_id)])];
  for (const id of q22AllEvidenceIds) if (!evidenceById.has(id)) throw new Error(`Q22 Evidence missing: ${id}`);

  const q3Facts = [
    fact({ corp: "00102858", metric: "HOLDING_SHARES_BEFORE", value: 8539148, valueType: "NUMERIC", unit: "SHARES", scale: 1, sourceDocument: holdingDoc.document_id, evidenceIds: [q3Evidence[0].evidence_id], date: "2025-05-20", rawLabel: "직전 보고서 보유주식등의 수" }),
    fact({ corp: "00102858", metric: "HOLDING_RATIO_BEFORE", value: 41.25, valueType: "NUMERIC", unit: "PERCENT", scale: 1, sourceDocument: holdingDoc.document_id, evidenceIds: [q3Evidence[1].evidence_id], date: "2025-05-20", rawLabel: "직전 보고서 보유비율" }),
    fact({ corp: "00102858", metric: "HOLDING_SHARES_AFTER", value: 8539148, valueType: "NUMERIC", unit: "SHARES", scale: 1, sourceDocument: holdingDoc.document_id, evidenceIds: [q3Evidence[2].evidence_id], date: "2025-05-20", rawLabel: "이번 보고서 보유주식등의 수" }),
    fact({ corp: "00102858", metric: "HOLDING_RATIO_AFTER", value: 41.25, valueType: "NUMERIC", unit: "PERCENT", scale: 1, sourceDocument: holdingDoc.document_id, evidenceIds: [q3Evidence[3].evidence_id], date: "2025-05-20", rawLabel: "이번 보고서 보유비율" }),
  ];
  const existingQ22 = q22ExistingIds.map((id) => evidenceById.get(id));
  const findExisting = (quote) => existingQ22.find((e) => e?.quoted_text === quote)?.evidence_id;
  const timelineText = "2024-02-15 지분 조정·계약금액/비율; 2024-05-22 계약상대방 ARAMCO→SATORP; 2024-05-23~2025-09-29 계약금액·비율·기간 연속 정정; 2026-01-20 PKG #4 SAR 5,562백만→5,564백만";
  const q22Facts = [
    fact({ metric: "CORRECTION_TIMELINE_SUMMARY", value: timelineText, sourceDocument: latest.document_id, evidenceIds: q22AllEvidenceIds, date: "2026-01-20", rawLabel: "정정 공시 변경 이력", attributes: { timeline_status: "COMPLETE" } }),
    fact({ metric: "LATEST_CONTRACT_AMOUNT", value: 3090076756644, valueType: "NUMERIC", unit: "KRW", currency: "KRW", scale: 1, sourceDocument: latest.document_id, evidenceIds: [findExisting("3,090,076,756,644")], date: "2026-01-20", rawLabel: "최신 유효 계약금액" }),
    fact({ metric: "LATEST_REVENUE_RATIO", value: 14.55, valueType: "NUMERIC", unit: "PERCENT", scale: 1, sourceDocument: latest.document_id, evidenceIds: [findExisting("14.55")], date: "2026-01-20", rawLabel: "최근 매출액 대비" }),
    fact({ metric: "LATEST_COUNTERPARTY", value: "SATORP", sourceDocument: latest.document_id, evidenceIds: [q22Evidence.find((e) => e.metadata.linked_slot_names.includes("latest_counterparty")).evidence_id], date: "2026-01-20", rawLabel: "계약상대방" }),
    fact({ metric: "LATEST_PERIOD_START", value: "2023-06-24", valueType: "DATE", sourceDocument: latest.document_id, evidenceIds: [findExisting("2023-06-24")], date: "2026-01-20", rawLabel: "계약기간 시작일" }),
    fact({ metric: "LATEST_PERIOD_END", value: "2027-06-23", valueType: "DATE", sourceDocument: latest.document_id, evidenceIds: [findExisting("2027-06-23")], date: "2026-01-20", rawLabel: "계약기간 종료일" }),
    fact({ metric: "LATEST_LOCATION", value: "사우디 동부 쥬베일 산업 II 단지", sourceDocument: latest.document_id, evidenceIds: [q22Evidence.find((e) => e.metadata.linked_slot_names.includes("latest_location")).evidence_id], date: "2026-01-20", rawLabel: "공급지역" }),
    fact({ metric: "LATEST_PACKAGE_TERMS", value: "PKG #1 USD 167백만+SAR 863백만; PKG #4 USD 512백만+SAR 5,564백만", sourceDocument: latest.document_id, evidenceIds: [findExisting("- 상기 2. 계약금액은 원화로 환산한 금액임.PKG#1 : 약 USD 167백만 + 약 SAR 863백만PKG#4 : 약 USD 512백만 + 약 SAR 5,564백만※ 최초 고시환율('23.06.23) :1,291.4원/USD, 344.28원/SAR"), latestNarrative.evidence_id].filter(Boolean), date: "2026-01-20", rawLabel: "PKG별 통화 계약금액" }),
    fact({ metric: "LATEST_EQUITY_SHARES", value: "PKG #1 13.7%; PKG #4 100%", sourceDocument: latest.document_id, evidenceIds: [latestNarrative.evidence_id], date: "2026-01-20", rawLabel: "현대건설 지분율" }),
  ];
  const facts = [...parseJsonl(factsText), ...q3Facts, ...q22Facts];
  for (const f of facts) { const errors = validateFactRecord(f); if (errors.length) throw new Error(`${f.fact_id}: ${errors.join("; ")}`); }
  const factsOut = jsonl(facts);

  const oldCoverage = JSON.parse(coverageText);
  const newSlots = [
    ...q3Facts.map((f, index) => coverageSlot(Q3, q3Specs[index][2], f, f.evidence_ids)),
    ...q22Facts.map((f, index) => coverageSlot(Q22, ["correction_timeline", "latest_amount", "latest_ratio", "latest_counterparty", "latest_period_start", "latest_period_end", "latest_location", "latest_package_terms", "latest_equity_shares"][index], f, f.evidence_ids)),
  ];
  const coverage = structuredClone(oldCoverage);
  coverage.fact_coverage_snapshot_id = ids.factCoverageSnapshot(SNAPSHOT, "0.2.0", GENERATED_AT);
  coverage.producer_version = "seed-structured-verified-v0.3-q3-q22"; coverage.created_at = GENERATED_AT;
  coverage.slots = [...coverage.slots, ...newSlots];
  const coverageOut = `${JSON.stringify(coverage, null, 2)}\n`;

  const relations = parseJsonl(relationText);
  const oldRelation = relations.find((r) => r.source_document_id === "exchange_20250331802494" && r.target_document_id === "exchange_20240614800515");
  if (!oldRelation) throw new Error("Q22 stale relation not found");
  const replacement = structuredClone(oldRelation);
  replacement.target_document_id = "exchange_20241128800562";
  replacement.relation_id = stableId("relation", replacement.relation_type, replacement.source_document_id, replacement.target_document_id);
  replacement.attributes.declared_reference_document_id = "exchange_20240614800515";
  replacement.attributes.effective_predecessor_basis = "정정전 금액 3,077,703,837,261원이 2024-11-28 정정후 금액과 일치";
  replacement.attributes.review_provenance.review_method = "OWNER_DIRECT_CORPUS_REVIEW_AND_CODEX_RECHECK";
  replacement.attributes.review_provenance.note = "공시 기재 제출일은 attributes에 보존하고 유효 버전 edge는 직전 상태로 교정";
  const relationOutRows = relations.map((r) => r.relation_id === oldRelation.relation_id ? replacement : r);
  const relationsOut = jsonl(relationOutRows);
  const chains = parseJsonl(chainText).map((c) => {
    if (c.chain_id !== CHAIN) return c;
    const next = structuredClone(c); next.relation_ids = c.relation_ids.map((id) => id === oldRelation.relation_id ? replacement.relation_id : id); next.generated_at = GENERATED_AT; return next;
  });
  const chainsOut = jsonl(chains);

  const gold = parseJsonl(goldText).map((record) => {
    if (![Q3, Q22].includes(record.question_id)) return record;
    const x = structuredClone(record); x.created_at = GENERATED_AT; x.authored_against.gold_revision = "gold-seed-v0.15-q3-q22-supported";
    x.extensions.artifact_status = "DRAFT"; x.extensions.e2e_usage_status = "E2E_READY"; delete x.extensions.e2e_exclusion_reason;
    x.extensions.route_policy_status = "DRAFT_RUNTIME_ALIGNED_PENDING_FINAL_E2E";
    if (x.question_id === Q3) {
      x.required_evidence_slots = q3Evidence.map((e, i) => ({ slot_name: q3Specs[i][2], description: q3Specs[i][2], acceptable_sources: [source(e)] }));
      x.extensions.evidence_ids = q3Evidence.map((e) => e.evidence_id);
      x.extensions.evidence_verification = q3Evidence.map((e) => ({ slot_name: e.metadata.linked_slot_names[0], document_id: e.document_id, evidence_id: e.evidence_id, source_node_id: e.metadata.source_node_id, row: e.metadata.row, column: e.metadata.column, canonical_file_id: e.file_id, canonical_source_locator: e.source_locator, quote_sha256: e.quote_sha256 }));
      x.expected_execution.required_fact_slots = q3Facts.map((f, i) => ({ slot_name: q3Specs[i][2], metric_code: f.metric_code, period_key: `as_of:${f.as_of_date}`, scope: f.scope }));
    } else {
      x.gold_document_ids = [...DOCS];
      x.required_evidence_slots = [
        { slot_name: "correction_timeline", description: "원공시 이후 전체 정정일·사유·변경값", acceptable_sources: q22Evidence.filter((e) => e.metadata.linked_slot_names.includes("correction_timeline")).map(source) },
        { slot_name: "latest_effective_conditions", description: "2026-01-20 기준 유효 계약조건", acceptable_sources: q22AllEvidenceIds.map((id) => source(evidenceById.get(id))).filter(Boolean) },
      ];
      x.extensions.evidence_ids = q22AllEvidenceIds;
      x.extensions.evidence_verification = q22AllEvidenceIds.map((id) => { const e = evidenceById.get(id); return { slot_name: e.metadata.linked_slot_names?.includes("correction_timeline") ? "correction_timeline" : "latest_effective_conditions", document_id: e.document_id, evidence_id: e.evidence_id, source_node_id: e.metadata.source_node_id ?? null, row: e.metadata.row ?? null, column: e.metadata.column ?? null, canonical_file_id: e.file_id, canonical_source_locator: e.source_locator, quote_sha256: e.quote_sha256 }; });
      x.expected_answer.value.project = "사우디 아미랄 (Amiral) 프로젝트 PKG #1,4";
      x.expected_answer.value.correction_timeline_status = "COMPLETE";
      x.expected_answer.value.known_changes = [
        ["2024-02-15", "지분 조정 확정·계약금액/비율"], ["2024-05-22", "계약상대방 ARAMCO→SATORP"],
        ["2024-05-23", "계약금액/비율"], ["2024-05-24", "계약금액"], ["2024-06-14", "계약금액/비율"],
        ["2024-11-28", "역무 조정·계약금액/비율"], ["2025-03-31", "계약금액/비율"], ["2025-04-15", "계약금액/비율"],
        ["2025-04-18", "계약금액/비율"], ["2025-06-11", "계약금액"], ["2025-07-08", "계약금액"],
        ["2025-07-14", "계약금액"], ["2025-09-29", "계약금액/비율/계약기간"], ["2026-01-20", "PKG #4 SAR 금액"],
      ].map(([date, field]) => ({ date, field, status: "SUPPORTED", document_id: `exchange_${date.replaceAll("-", "")}${DOCS.find((d) => d.includes(date.replaceAll("-", "")))?.slice(-6) ?? ""}` }));
      x.expected_answer.value.latest_effective_counterparty = "SATORP";
      x.expected_answer.value.latest_effective_location = "사우디 동부 쥬베일 산업 II 단지";
      x.expected_answer.value.latest_effective_pkg1 = "약 USD 167백만 + SAR 863백만";
      x.expected_answer.value.latest_effective_pkg4 = "약 USD 512백만 + SAR 5,564백만";
      x.expected_answer.value.latest_effective_equity_share = { pkg1_percent: 13.7, pkg4_percent: 100 };
      x.expected_execution.required_fact_slots = q22Facts.map((f, i) => ({ slot_name: ["correction_timeline", "latest_amount", "latest_ratio", "latest_counterparty", "latest_period_start", "latest_period_end", "latest_location", "latest_package_terms", "latest_equity_shares"][i], metric_code: f.metric_code, period_key: `as_of:${f.as_of_date}`, scope: f.scope }));
      x.extensions.chain_lock = { ...x.extensions.chain_lock, effective_predecessor_corrected: true, declared_reference_preserved: true };
    }
    x.expected_execution.required_fact_slots_sha256 = requiredFactSlotsSha256(x.expected_execution.required_fact_slots);
    const states = ["ALL_REQUIRED_FACT_SLOTS_VERIFIED"];
    x.expected_execution.applicable_fact_coverage_states = states;
    x.expected_execution.route_policy = [{ when: states[0], preferred_route: "STRUCTURED", allowed_routes: ["STRUCTURED"], required_operations: ["query_verified_facts", "query_verified_evidence", "validate_provenance"], forbidden_operations: ["recommend_investment", "predict_future_value", "infer_missing_value"], expected_answerability: "SUPPORTED" }];
    return x;
  });
  for (const g of gold) { const errors = validateEvaluationGoldV02(g); if (errors.length) throw new Error(`${g.question_id}: ${errors.join("; ")}`); }
  const goldOut = jsonl(gold);

  await mkdir(abs("work/domain-seed"), { recursive: true });
  await Promise.all([
    writeFile(abs(P.canonicalDelta), canonicalDeltaText), writeFile(abs(P.evidence), evidenceOut), writeFile(abs(P.facts), factsOut),
    writeFile(abs(P.coverage), coverageOut), writeFile(abs(P.relations), relationsOut), writeFile(abs(P.chains), chainsOut), writeFile(abs(P.gold), goldOut),
  ]);
  const evidenceManifest = { schema_version: "0.1.0", artifact: path.basename(P.evidence), artifact_sha256: sha(evidenceOut), generated_at: GENERATED_AT, corpus_snapshot_id: SNAPSHOT, authored_against_manifest_sha256: MANIFEST_SHA, supersedes: P.evidenceIn, record_count: evidence.length, evidence_ids: [...evidenceIds].sort() };
  await writeFile(abs(P.evidenceManifest), `${JSON.stringify(evidenceManifest, null, 2)}\n`);
  const canonicalRelease = {
    schema_version: "0.1.0", release_id: "seed-release-v0.15-draft", release_status: "DRAFT", corpus_snapshot_id: SNAPSHOT,
    artifacts: [await pin("CANONICAL_DOCUMENT_IR_BASE", P.canonicalBase, 54), await pin("CANONICAL_DOCUMENT_IR_DELTA", P.canonicalDelta, canonicalDelta.length), await pin("SEED_GOLD", P.gold, 25)],
  };
  await writeFile(abs(P.canonicalRelease), `${JSON.stringify(canonicalRelease, null, 2)}\n`);
  const structuredManifest = {
    schema_version: "0.1.0", artifact_set_id: "seed-structured-artifacts-v0.3", status: "VERIFIED_SEED_SUBSET", generated_at: GENERATED_AT,
    corpus_snapshot_id: SNAPSHOT, fact_coverage_snapshot_id: coverage.fact_coverage_snapshot_id, semantic_bundle_schema_version: "0.2.0",
    artifacts: [await pin("VERIFIED_EVIDENCE", P.evidence, evidence.length), await pin("VERIFIED_EVIDENCE_MANIFEST", P.evidenceManifest), await pin("VERIFIED_EVENT", P.eventsIn, parseJsonl(eventsText).length), await pin("VERIFIED_RELATION", P.relations, relationOutRows.length), await pin("VERIFIED_FACT", P.facts, facts.length), await pin("FACT_COVERAGE_SNAPSHOT", P.coverage, coverage.slots.length), await pin("OWNER_DECISION", P.ownerDecision)],
    excluded_question_ids: [], release_status: "DRAFT_UNTIL_25_QUESTION_E2E",
  };
  await writeFile(abs(P.structuredManifest), `${JSON.stringify(structuredManifest, null, 2)}\n`);
  const mapping = [{ question_id: Q3, action: "CELL_EVIDENCE_IDENTITY_RESOLVED", evidence_count: 4 }, { question_id: Q22, action: "FULL_CHAIN_CANONICALIZED_AND_EFFECTIVE_PREDECESSOR_FIXED", document_count: 15, newly_canonicalized: 13 }];
  await writeFile(abs(P.mapping), jsonl(mapping));
  const report = `# Seed v0.15 Q3/Q22 integration\n\n- Q3: cell-qualified Evidence 4건, SUPPORTED/E2E_READY\n- Q22: 15-document complete history, missing canonical 13건 added, SUPPORTED/E2E_READY\n- Relation: 2025-03-31 effective predecessor changed to 2024-11-28; declared 2024-06-14 reference preserved in attributes\n- Gold: 25/25 E2E_READY\n- Evidence: ${evidence.length}\n- Facts: ${facts.length}\n- Coverage slots: ${coverage.slots.length}\n- Status: DRAFT_UNTIL_25_QUESTION_E2E\n`;
  await writeFile(abs(P.report), report);
  return { evidence: evidence.length, facts: facts.length, slots: coverage.slots.length, canonicalDelta: canonicalDelta.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(await buildSeedQ3Q22V015());
