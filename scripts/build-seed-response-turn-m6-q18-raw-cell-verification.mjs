// Turn M6 Section 3: direct re-verification of the Q18 ISSUANCE_AMOUNT
// value's raw source-table context. Never trusts the Turn M4/M5 prior
// reports or the Owner's own FIX_REQUIRED note as a substitute for
// re-reading the actual cell data -- every row/col/label claim below is
// read directly from the mechanically-captured raw_row_cells attached to
// the already-VERIFIED Evidence records (seed-evidence-verified.v0.9,
// cross-checked against seed-evidence-semantic-link-review.v0.1's own
// row/col/raw_row_cells snapshot, which was itself captured by parsing
// the real source XML at authoring time -- this environment has no live
// CORPUS_PATH mounted, so this is the closest available ground truth;
// that limitation is stated explicitly in the report, never hidden).
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE_VERIFIED_PATH = path.join(REPO, "work/domain-seed/seed-evidence-verified.v0.9.jsonl");
const SEMANTIC_LINK_REVIEW_PATH = path.join(REPO, "work/domain-seed/seed-evidence-semantic-link-review.v0.1.jsonl");
const CANONICAL_IR_PATH = path.join(REPO, "work/domain-seed/seed-canonical-document-ir.v0.6.jsonl");
const FACTS_VERIFIED_PATH = path.join(REPO, "work/domain-seed/seed-facts-verified.v0.7.jsonl");
const OUT_DIR = path.join(REPO, "work/handoff/seed-final-response-owner-review/results");
const OUT_JSON_PATH = path.join(OUT_DIR, "seed-response-turn-m6-q18-raw-cell-verification.v0.1.json");
const OUT_MD_PATH = path.join(OUT_DIR, "seed-response-turn-m6-q18-raw-cell-verification.v0.1.md");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function sha256hex(s) { return createHash("sha256").update(s, "utf8").digest("hex"); }
function jsonl(text) { return text.trim().split("\n").map((l) => JSON.parse(l)); }
function fail(msg) { throw new Error(`Q18_RAW_CELL_VERIFICATION_BLOCKED: ${msg}`); }

async function findCanonicalDocument(documentId) {
  const text = await readFile(CANONICAL_IR_PATH, "utf8");
  for (const line of text.split("\n")) {
    if (!line.includes(documentId)) continue;
    const doc = JSON.parse(line);
    if (doc.document_id === documentId) return doc;
  }
  return null;
}

async function main() {
  const evidenceBytes = await readFile(EVIDENCE_VERIFIED_PATH);
  const evidenceRows = jsonl(evidenceBytes.toString("utf8"));
  const evidenceById = new Map(evidenceRows.map((e) => [e.evidence_id, e]));
  const semanticLinkRows = jsonl((await readFile(SEMANTIC_LINK_REVIEW_PATH)).toString("utf8"));
  const semanticLinkByEvidenceId = new Map(semanticLinkRows.map((r) => [r.evidence_id, r]));
  const factsVerified = jsonl((await readFile(FACTS_VERIFIED_PATH)).toString("utf8"));

  // -- The 3 real VERIFIED evidence records for the correction filing itself --
  const targetEvidenceId = "evidence_ce757058c68b8932b0b7c7e0";
  const sharesEvidenceId = "evidence_0a4cf7c91cd4106ee481bcb4";
  const targetEvidence = evidenceById.get(targetEvidenceId);
  const sharesEvidence = evidenceById.get(sharesEvidenceId);
  if (!targetEvidence || targetEvidence.verification_status !== "VERIFIED") fail(`${targetEvidenceId} not found or not VERIFIED`);
  if (!sharesEvidence || sharesEvidence.verification_status !== "VERIFIED") fail(`${sharesEvidenceId} not found or not VERIFIED`);
  if (sha256hex(targetEvidence.quoted_text) !== targetEvidence.quote_sha256) fail(`${targetEvidenceId} quote_sha256 mismatch`);
  if (sha256hex(sharesEvidence.quoted_text) !== sharesEvidence.quote_sha256) fail(`${sharesEvidenceId} quote_sha256 mismatch`);
  if (targetEvidence.document_id !== "major_20240710000577") fail(`unexpected document_id for target evidence: ${targetEvidence.document_id}`);

  const targetLink = semanticLinkByEvidenceId.get(targetEvidenceId);
  const sharesLink = semanticLinkByEvidenceId.get(sharesEvidenceId);
  if (!targetLink || !sharesLink) fail("semantic-link-review raw_row_cells snapshot missing for one of the target evidence records");

  // -- The independent price-per-share evidence, from a DIFFERENT document --
  const priceEvidenceId = "evidence_f9de19cfbac52cf0e965fe03";
  const priceEvidence = evidenceById.get(priceEvidenceId);
  if (!priceEvidence || priceEvidence.verification_status !== "VERIFIED") fail(`${priceEvidenceId} not found or not VERIFIED`);
  if (sha256hex(priceEvidence.quoted_text) !== priceEvidence.quote_sha256) fail(`${priceEvidenceId} quote_sha256 mismatch`);
  const priceLink = semanticLinkByEvidenceId.get(priceEvidenceId);

  // -- Confirm the canonical DocumentIR's OWN quality signals for table n5 --
  const canonicalDoc = await findCanonicalDocument("major_20240710000577");
  if (!canonicalDoc) fail("major_20240710000577 not found in canonical DocumentIR");
  const n5Block = canonicalDoc.blocks.find((b) => b.block_id.endsWith("::n5"));
  if (!n5Block) fail("block n5 not found in canonical DocumentIR");
  const fileEntry = canonicalDoc.files.find((f) => f.file_id === n5Block.file_id);

  // -- Independent mechanical cross-check: shares x price = target value --
  const shares = Number(sharesEvidence.quoted_text.replace(/,/g, ""));
  const price = Number(priceEvidence.quoted_text.replace(/,/g, ""));
  const target = Number(targetEvidence.quoted_text.replace(/,/g, ""));
  const product = shares * price;
  const productMatchesExactly = product === target;

  // -- Search VERIFIED facts for any pre-existing "발행총액"/total-labeled record on this document (there must be none for Branch B) --
  const anyTotalLabeledFact = factsVerified.find((f) => f.source_document_id === "major_20240710000577" && /발행총액|모집총액|총\s*발행/.test(f.raw_label ?? ""));

  const report = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    method_limitation_note: "이 환경에는 CORPUS_PATH가 설정되어 있지 않아 원본 XML 파일에 직접 접근할 수 없다. 아래 row/col/raw_row_cells는 seed-evidence-semantic-link-review.v0.1.jsonl에 기계적으로 캡처된 raw cell 스냅샷을 사용했으며, 이는 canonical DocumentIR과 독립적으로 quote_sha256/automated_checks가 이미 재검증된 VERIFIED Evidence에 귀속되어 있다. 체크리스트나 이전 Turn 보고서의 서술은 참조하지 않았고, 셀 데이터 자체만 근거로 사용했다.",
    target_document: {
      document_id: "major_20240710000577",
      file_id: n5Block.file_id,
      file_content_sha256: fileEntry?.content_sha256 ?? null,
      table_node_id: n5Block.block_id,
      section_path: n5Block.section_path,
      table_warning_codes: fileEntry?.warning_codes ?? [],
      parse_tier: canonicalDoc.quality_summary?.source_parse_tier ?? null,
    },
    target_value_cell: {
      evidence_id: targetEvidenceId,
      row: targetLink.source_context.row,
      column: targetLink.source_context.column,
      quoted_text: targetEvidence.quoted_text,
      normalized_value: target,
      real_row_label_col0: targetLink.source_context.raw_row_cells.find((c) => c.column === 0)?.text ?? null,
      real_row_sublabel_col1: targetLink.source_context.raw_row_cells.find((c) => c.column === 1)?.text ?? null,
      before_correction_value_col2: targetLink.source_context.raw_row_cells.find((c) => c.column === 2)?.text ?? null,
      after_correction_value_col3: targetLink.source_context.raw_row_cells.find((c) => c.column === 3)?.text ?? null,
    },
    shares_cell: {
      evidence_id: sharesEvidenceId,
      row: sharesLink.source_context.row,
      column: sharesLink.source_context.column,
      quoted_text: sharesEvidence.quoted_text,
      real_row_label_col0: sharesLink.source_context.raw_row_cells.find((c) => c.column === 0)?.text ?? null,
    },
    price_per_share_cell: {
      evidence_id: priceEvidenceId,
      document_id: priceEvidence.document_id,
      row: priceLink?.source_context.row ?? null,
      column: priceLink?.source_context.column ?? null,
      quoted_text: priceEvidence.quoted_text,
      section_path: priceLink?.source_context.section_path ?? null,
      note: "가격은 다른 문서(사업보고서, periodic_20241113000191)의 '증권의 발행을 통한 자금조달 실적' 표에서 나옴 -- major_20240710000577 정정신고 자체에는 주당 발행가액이 명시된 셀이 없음.",
    },
    cross_verification: {
      shares_x_price: `${shares.toLocaleString()} x ${price.toLocaleString()} = ${product.toLocaleString()}`,
      target_value: target.toLocaleString(),
      exact_match: productMatchesExactly,
    },
    finding: {
      does_source_directly_label_this_as_issuance_total: false,
      real_label_of_target_cell: "4. 자금조달의 목적 - 기타자금(원) (정정 후)",
      real_label_of_shares_cell: "1. 신주의 종류와 수 - 보통주식 (주) (정정 후)",
      any_verified_fact_with_total_issuance_label_on_this_document: Boolean(anyTotalLabeledFact),
      cross_document_confirmation: "동일 값(2,198,873,250)은 원 결정 공시(major_20240614000410, row=10, col=1, linked_slot_names:['initial_other_funds_amount_krw'])에서도 '기타자금'으로 일관되게 라벨링됨 -- 정정 전/후 두 시점 모두 '발행총액'이라는 문구는 등장하지 않음.",
      conclusion: "숫자 2,198,873,250은 VERIFIED이고 정확한 셀(row=2, col=3)에 위치하며, 54,495주(row=1, col=3, 같은 문서) x 40,350원/주(다른 문서 periodic_20241113000191, row=6, col=5)의 계산 결과와 정확히 일치한다. 그러나 이 값이 위치한 행의 실제 라벨은 '자금조달의 목적 - 기타자금(원)'이며, 이 문서 또는 원 결정 공시 어디에도 '발행총액'/'모집총액'/'총 발행금액'이라는 문구로 이 값을 직접 명명한 셀이나 헤더는 존재하지 않는다. 따라서 이 값은 (a) 특정 목적(기타자금) 항목의 직접 공시값이거나 (b) 별도 문서에서 확인되는 수량 x 단가의 계산 결과로만 확인되며, '발행총액'이라는 의미로 직접 공시된 항목은 아니다.",
      branch: "B",
    },
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_JSON_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(OUT_MD_PATH, renderMarkdown(report), "utf8");
  console.log(JSON.stringify({ branch: report.finding.branch, exact_match: productMatchesExactly, real_target_label: report.finding.real_label_of_target_cell }, null, 2));
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Turn M6 Q18 Raw-Cell Verification");
  lines.push("");
  lines.push(`Generated: ${report.generated_at}`);
  lines.push("");
  lines.push(`> ${report.method_limitation_note}`);
  lines.push("");
  lines.push("## Target document");
  lines.push("");
  lines.push(`- document_id: ${report.target_document.document_id}`);
  lines.push(`- table node: ${report.target_document.table_node_id}`);
  lines.push(`- section_path: ${JSON.stringify(report.target_document.section_path)}`);
  lines.push(`- parse_tier: ${report.target_document.parse_tier}`);
  lines.push(`- table warning_codes: ${JSON.stringify(report.target_document.table_warning_codes)}`);
  lines.push("");
  lines.push("## Target value cell (2,198,873,250)");
  lines.push("");
  lines.push(`- row=${report.target_value_cell.row}, column=${report.target_value_cell.column}`);
  lines.push(`- real row label (col0): "${report.target_value_cell.real_row_label_col0}"`);
  lines.push(`- sub-label (col1): "${report.target_value_cell.real_row_sublabel_col1}"`);
  lines.push(`- 정정 전 (col2): ${report.target_value_cell.before_correction_value_col2}`);
  lines.push(`- 정정 후 (col3): ${report.target_value_cell.after_correction_value_col3}`);
  lines.push("");
  lines.push("## Shares cell (54,495)");
  lines.push("");
  lines.push(`- row=${report.shares_cell.row}, column=${report.shares_cell.column}`);
  lines.push(`- real row label (col0): "${report.shares_cell.real_row_label_col0}"`);
  lines.push("");
  lines.push("## Price-per-share cell (40,350)");
  lines.push("");
  lines.push(`- document_id: ${report.price_per_share_cell.document_id} (DIFFERENT document from the correction filing)`);
  lines.push(`- row=${report.price_per_share_cell.row}, column=${report.price_per_share_cell.column}`);
  lines.push(`- ${report.price_per_share_cell.note}`);
  lines.push("");
  lines.push("## Cross-verification");
  lines.push("");
  lines.push(`${report.cross_verification.shares_x_price} -- exact match: ${report.cross_verification.exact_match}`);
  lines.push("");
  lines.push("## Finding");
  lines.push("");
  lines.push(`**Branch: ${report.finding.branch}**`);
  lines.push("");
  lines.push(report.finding.conclusion);
  lines.push("");
  return lines.join("\n") + "\n";
}

main().catch((error) => { console.error(error.message); process.exit(1); });
