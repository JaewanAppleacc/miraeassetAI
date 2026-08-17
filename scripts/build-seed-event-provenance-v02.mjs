import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ids } from "../domain/contracts.mjs";

const rootDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PATHS = Object.freeze({
  eventsV01: "work/domain-seed/seed-event-candidates.v0.1.jsonl",
  evidenceV03: "work/domain-seed/seed-evidence-verified.v0.3.jsonl",
  canonicalBase: "work/domain-seed/seed-canonical-document-ir.v0.6.jsonl",
  canonicalDelta: "work/domain-seed/seed-canonical-document-ir.v0.7.delta.jsonl",
  eventsV02: "work/domain-seed/seed-event-candidates.v0.2.jsonl",
  evidenceDelta: "work/domain-seed/seed-event-evidence-candidates.v0.2.delta.jsonl",
  mapping: "work/domain-seed/seed-event-v01-to-v02-mapping.jsonl",
  reviewQueue: "work/domain-seed/seed-event-v02-review-queue.v0.1.jsonl",
  summary: "work/domain-seed/seed-event-v02-build-summary.v0.1.json",
  report: "work/domain-seed/seed-event-v02-build-report.v0.1.md",
  claudePrompt: "work/domain-seed/seed-event-v02-claude-review-prompt.v0.1.md",
});

const ALREADY_DIRECT = new Set([
  "event_12ec40538defccc991674c4e", "event_490ad64796ec324a847f7bab",
  "event_394b6ef76fdaea18e23c8763", "event_a2bdc183d5dda2028a464d6c",
  "event_965767155aadd52bf3d2f1d0",
]);
const LOI_EVENT_ID = "event_cffef01467a71df30fdbb9c6";

// TABLE_ROW_COMPOSITE deliberately preserves separate cells. No synthesized
// cross-cell quotation is created because CitationValidator forbids it.
const SPECS = Object.freeze({
  event_5e6374560eef57ddaa7f1a3d: ["DIRECT_LITERAL", [["holding_20250124000900/20250124000900.xml#node=4", "3. 정정사항 \n박학규 이사 사임으로 특별관계자 제외 반영"]]],
  event_d921fbdecd1025407e8d2b52: ["DIRECT_LITERAL", [["major_20260120000144/20260120000144.xml#node=2", "자기주식 처분 결정"]]],
  event_67b064881ffcc93f3f428564: ["DIRECT_LITERAL", [["major_20241115000375/20241115000375.xml#node=2", "자기주식 취득 결정"]]],
  event_7ed4c92f281d906b1ae76074: ["DIRECT_LITERAL", [["major_20241118000171/20241118000171.xml#node=2", "1. 정정대상 공시서류 : 주요사항보고서(자기주식취득결정)"]]],
  event_310ce20c4568cfc58bd091e2: ["DIRECT_LITERAL", [["major_20250206000192/20250206000192.xml#node=2", "자기주식취득 신탁계약 체결 결정"]]],
  event_e178862422907739dad03bc8: ["TABLE_ROW_COMPOSITE", [["exchange_20230602800079/20230602800079.xml#node=0", "- 체결계약명"], ["exchange_20230602800079/20230602800079.xml#node=0", "원유운반선 2척"]]],
  event_76c4f677cf48817ace600857: ["DIRECT_LITERAL", [["exchange_20260203800709/20260203800709.xml#node=1", "수주척수, 계약금액 및 계약기간 종료일 변경"]]],
  event_8140122fef025f989e1bf567: ["DIRECT_LITERAL", [["exchange_20260316801038/20260316801038.xml#node=0", "1. 판매ㆍ공급계약 해지 구분"]]],
  event_abe014b753e06a4af8cf185a: ["TABLE_ROW_COMPOSITE", [["exchange_20241104800041/20241104800041.xml#node=0", "- 체결계약명"], ["exchange_20241104800041/20241104800041.xml#node=0", "Hornsea Four Offshore Wind Farm(HOW04)해상변전소/육상변전소에 변압기/리액터 공급,설치 및 시운전"]]],
  event_6d39152053db758263545641: ["DIRECT_LITERAL", [["exchange_20250508800712/20250508800712.xml#node=0", "1. 판매ㆍ공급계약 해지 구분"]]],
  event_7698bf7a974ead5047a5384a: ["DIRECT_LITERAL", [["major_20240614000410/20240614000410.xml#node=2", "유상증자 결정"]]],
  event_407a5f1c9f81db32e0cbe668: ["DIRECT_LITERAL", [["major_20240710000577/20240710000577.xml#node=2", "1. 정정대상 공시서류 : 주요사항보고서(유상증자 결정)"]]],
  event_5a2bc7f78a68b90985e17321: ["TABLE_ROW_COMPOSITE", [["periodic_20241113000191/20241113000191.xml#node=428", "-증자비율: 0.1%\n- 주금납입은 인수인의 주금납입채무와 인수인의 당회사에대한 채권을 상계하는 방식   ·대상자 : 회사채투자자"]], ["evidence_af0e4041487e1e8bcc8fc2cf"]],
  event_cffef01467a71df30fdbb9c6: ["DIRECT_LITERAL", [["exchange_20230605800001/20230605800001.xml#node=0", "바이오의약품 위탁생산계약 의향서 체결"], ["exchange_20230605800001/20230605800001.xml#node=0", "1) 계약 상대방 : 미국 소재 제약사2) 계약 금액 : 147,284,499,200원3) 의향서 체결일자 : 2023.06.03"]]],
  event_b607417276328ecf7a02ce75: ["TABLE_ROW_COMPOSITE", [["exchange_20240315900173/20240315900173.xml#node=0", "1. 판매ㆍ공급계약 내용"], ["exchange_20240315900173/20240315900173.xml#node=0", "KF-21 공정자동화를 위한 협동로봇 드릴링머신 솔루션 납품"]]],
  event_87373c38b66d8881ee820301: ["DIRECT_LITERAL", [["exchange_20241205900548/20241205900548.xml#node=1", "변경계약으로 인한 계약금액 및 계약기간 정정"]]],
  event_d6074132adcf186d747a9624: ["DIRECT_LITERAL", [["major_20230313000016/20230313000016.xml#node=2", "1. 정정대상 공시서류 : 자기주식취득 신탁계약 체결 결정"]]],
  event_7e4918d924bbf3ac51d9ad1e: ["TABLE_ROW_COMPOSITE", [["exchange_20250728800035/20250728800035.xml#node=0", "- 체결계약명"], ["exchange_20250728800035/20250728800035.xml#node=0", "반도체 위탁생산 공급계약"]]],
  event_15e151409c16647a9a81da31: ["DIRECT_LITERAL", [["exchange_20250731800028/20250731800028.xml#node=1", "계약상대방이 영업비밀 보호 요청 중에서 계약상대 공개를 동의"]]],
});

function jsonl(text, source) {
  return text.split(/\r?\n/).filter(Boolean).map((line, i) => {
    try { return JSON.parse(line); } catch (error) { throw new Error(`${source}:${i + 1}: ${error.message}`); }
  });
}
const hash = (text) => createHash("sha256").update(text).digest("hex");

function resolveQuote(document, locator, quote) {
  const block = document?.blocks.find((item) => item.source_locator === locator);
  if (!block) throw new Error(`block missing: ${locator}`);
  if (block.text?.includes(quote)) return { block, row: null, column: null };
  const positions = [];
  for (const row of block.table?.raw_rows ?? []) for (const cell of row) if (cell.text?.includes(quote)) positions.push([cell.row, cell.col]);
  const unique = new Map(positions.map((position) => [position.join(":"), position]));
  if (unique.size !== 1) throw new Error(`quote must resolve to exactly one position (${unique.size}): ${locator} :: ${quote}`);
  const [row, column] = [...unique.values()][0];
  return { block, row, column };
}

function report(s) {
  return `# Seed Event provenance v0.2\n\n- Event: ${s.event_count} (CANDIDATE)\n- 기존 직접근거 유지: ${s.already_direct_event_count}\n- 보강 Event: ${s.provenance_fixed_event_count}\n- 신규 Evidence: ${s.new_evidence_count} (CANDIDATE/PENDING_HUMAN_REVIEW)\n- 단일 직접문구: ${s.direct_literal_event_count}\n- 동일행 복합근거: ${s.table_row_composite_event_count}\n- LOI 날짜: ${s.loi_date_change.before} → ${s.loi_date_change.after}\n- 승격 가능: 아니오(독립 재검수 필요)\n\nTABLE_ROW_COMPOSITE는 표의 라벨과 값이 서로 다른 셀에 있어 동일 행의 복수 Evidence로 보존한 경우다. 합성 인용문을 만들지 않았다.\n`;
}

function prompt() {
  return `# Claude Code 독립 재검수 — Event v0.2\n\nCodex 판정을 신뢰하지 말고 다음을 원문 대조해줘.\n\n입력: seed-event-candidates.v0.1/v0.2, seed-event-evidence-candidates.v0.2.delta.jsonl, seed-event-v01-to-v02-mapping.jsonl, seed-event-v02-review-queue.v0.1.jsonl, canonical DocumentIR v0.6+v0.7.delta.\n\n1. 19개 Event의 신규 Evidence ID/locator/quote/hash/file_id를 재계산한다.\n2. DIRECT_LITERAL은 사건 상태를 직접 말하는지 확인한다.\n3. TABLE_ROW_COMPOSITE는 모든 셀이 동일 행이며 합쳐 읽을 때만 정확히 Event를 증명하는지 확인한다. 합성 quote로 취급하지 않는다.\n4. LOI Event event_date=2023-06-03, known_at=2023-06-05인지 확인한다.\n5. 기존 직접근거 5건은 byte-identical, 나머지는 evidence_ids만, LOI는 event_date도 변경됐는지 확인한다.\n6. Event/Evidence가 CANDIDATE/PENDING 상태인지 확인한다.\n\nEvent별 APPROVE_RECOMMENDED/FIX_REQUIRED/REJECT_RECOMMENDED를 별도 파일에 기록해. 기존 파일 수정·승격·commit·push 금지. verify:contracts/build/git diff --check 결과도 보고해.\n`;
}

export async function buildSeedEventProvenanceV02({ root = rootDefault, paths = PATHS, writeOutputs = true, generatedAt = new Date().toISOString() } = {}) {
  const p = Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, path.resolve(root, value)]));
  const [eventText, evidenceText, baseText, deltaText] = await Promise.all([readFile(p.eventsV01, "utf8"), readFile(p.evidenceV03, "utf8"), readFile(p.canonicalBase, "utf8"), readFile(p.canonicalDelta, "utf8")]);
  const before = jsonl(eventText, paths.eventsV01);
  const existingEvidence = jsonl(evidenceText, paths.evidenceV03);
  const existingEvidenceById = new Map(existingEvidence.map((item) => [item.evidence_id, item]));
  const documents = new Map([...jsonl(baseText, paths.canonicalBase), ...jsonl(deltaText, paths.canonicalDelta)].map((item) => [item.document_id, item]));
  const existingIds = new Set(existingEvidence.map((item) => item.evidence_id));
  if (before.length !== 24) throw new Error("expected 24 Events");
  const blocked = before.filter((item) => !ALREADY_DIRECT.has(item.event_id)).map((item) => item.event_id).sort();
  if (JSON.stringify(blocked) !== JSON.stringify(Object.keys(SPECS).sort())) throw new Error("specs must cover exactly 19 blocked Events");

  const added = [];
  const additions = new Map();
  for (const event of before.filter((item) => !ALREADY_DIRECT.has(item.event_id))) {
    const [strength, quotes, reused = []] = SPECS[event.event_id];
    const records = quotes.map(([locator, quote]) => {
      const document = documents.get(event.anchor_document_id);
      if (!document) throw new Error(`document missing: ${event.anchor_document_id}`);
      const { block, row, column } = resolveQuote(document, locator, quote);
      const evidenceId = ids.evidence(event.anchor_document_id, locator, quote);
      if (existingIds.has(evidenceId)) throw new Error(`new Evidence collides with existing artifact: ${evidenceId}`);
      return {
        evidence_id: evidenceId, document_id: event.anchor_document_id, file_id: block.file_id, chunk_id: null,
        source_locator: locator, quoted_text: quote, quote_sha256: hash(quote), extraction_method: "DETERMINISTIC",
        confidence: 1, verification_status: "CANDIDATE",
        metadata: { review_status: "PENDING_HUMAN_REVIEW", source_node_id: block.metadata?.source_node_id ?? block.block_id,
          row, column, linked_event_ids: [event.event_id], event_provenance_strength: strength,
          corpus_snapshot_id: document.corpus_snapshot_id,
          automated_checks: { canonical_document_exists: true, file_id_exists: true, canonical_block_exists: true, quoted_text_resolves: true, quote_sha256_matches: true, deterministic_evidence_id_matches: true } },
      };
    });
    if (strength === "TABLE_ROW_COMPOSITE") {
      const rows = [...records.map((record) => record.metadata.row), ...reused.map((id) => existingEvidenceById.get(id)?.metadata?.row)];
      if (rows.some((row) => row == null) || new Set(rows).size !== 1) throw new Error(`${event.event_id}: composite evidence must share a row`);
    }
    if (reused.some((id) => !existingIds.has(id))) throw new Error(`${event.event_id}: reused Evidence missing`);
    added.push(...records);
    additions.set(event.event_id, [...reused, ...records.map((record) => record.evidence_id)]);
  }
  if (new Set(added.map((item) => item.evidence_id)).size !== added.length) throw new Error("duplicate new Evidence IDs");

  const after = before.map((event) => {
    if (ALREADY_DIRECT.has(event.event_id)) return structuredClone(event);
    const copy = { ...structuredClone(event), evidence_ids: [...new Set([...event.evidence_ids, ...additions.get(event.event_id)])] };
    if (event.event_id === LOI_EVENT_ID) copy.event_date = "2023-06-03";
    return copy;
  });
  const mapping = before.map((old, i) => {
    const current = after[i];
    const changed_fields = Object.keys(current).filter((key) => JSON.stringify(old[key]) !== JSON.stringify(current[key])).sort();
    const expected = old.event_id === LOI_EVENT_ID ? ["event_date", "evidence_ids"] : (ALREADY_DIRECT.has(old.event_id) ? [] : ["evidence_ids"]);
    if (JSON.stringify(changed_fields) !== JSON.stringify(expected.sort())) throw new Error(`${old.event_id}: unexpected changes ${changed_fields}`);
    return { event_id: old.event_id, changed_fields, evidence_ids_before: old.evidence_ids, evidence_ids_after: current.evidence_ids, event_date_before: old.event_date, event_date_after: current.event_date };
  });
  const queue = after.filter((item) => !ALREADY_DIRECT.has(item.event_id)).map((event) => ({
    event_id: event.event_id, event_type: event.event_type, event_status: event.event_status, anchor_document_id: event.anchor_document_id,
    provenance_strength: SPECS[event.event_id][0], evidence_ids_added: additions.get(event.event_id),
    proposed_decision: "PENDING_INDEPENDENT_REVIEW", review_status: "PENDING_HUMAN_REVIEW",
    special_checks: event.event_id === LOI_EVENT_ID ? ["VERIFY_EVENT_DATE_2023-06-03", "KEEP_KNOWN_AT_2023-06-05"] : [],
  }));
  const loi = after.find((item) => item.event_id === LOI_EVENT_ID);
  if (loi.event_date !== "2023-06-03" || loi.known_at !== "2023-06-05T00:00:00Z") throw new Error("LOI time correction invalid");
  if (after.some((item) => item.verification_status !== "CANDIDATE") || added.some((item) => item.verification_status !== "CANDIDATE")) throw new Error("premature promotion");
  const summary = { schema_version: "0.1.0", generated_at: generatedAt, status: "CANDIDATES_BUILT_PENDING_INDEPENDENT_REVIEW",
    event_count: after.length, already_direct_event_count: ALREADY_DIRECT.size, provenance_fixed_event_count: queue.length,
    new_evidence_count: added.length, direct_literal_event_count: queue.filter((item) => item.provenance_strength === "DIRECT_LITERAL").length,
    table_row_composite_event_count: queue.filter((item) => item.provenance_strength === "TABLE_ROW_COMPOSITE").length,
    loi_date_change: { event_id: LOI_EVENT_ID, before: "2023-06-05", after: "2023-06-03", known_at: loi.known_at }, promotion_allowed: false };

  if (writeOutputs) {
    await mkdir(path.dirname(p.eventsV02), { recursive: true });
    await Promise.all([
      writeFile(p.eventsV02, `${after.map(JSON.stringify).join("\n")}\n`), writeFile(p.evidenceDelta, `${added.map(JSON.stringify).join("\n")}\n`),
      writeFile(p.mapping, `${mapping.map(JSON.stringify).join("\n")}\n`), writeFile(p.reviewQueue, `${queue.map(JSON.stringify).join("\n")}\n`),
      writeFile(p.summary, `${JSON.stringify(summary, null, 2)}\n`), writeFile(p.report, report(summary)), writeFile(p.claudePrompt, prompt()),
    ]);
  }
  return { eventsV02: after, newEvidence: added, mapping, reviewQueue: queue, summary };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { summary } = await buildSeedEventProvenanceV02();
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
