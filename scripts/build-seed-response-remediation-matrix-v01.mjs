// Turn M item 3: builds the remediation matrix -- mechanical tracking of
// each of the 24 FIX_REQUIRED notes against the COMMON capability(ies)
// (never per-question code) that address it, real implementation files,
// observed before/after answer text, and an honest RESOLVED/PARTIAL/
// BLOCKED status. This script itself may name question_ids/companies
// (it is an AUDIT/REPORTING artifact, not Runtime synthesis code -- the
// "no question_id branching" rule applies to domain/flows/synthesis/ and
// thin-structured-flow.mjs, not to this reporting script).
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DECISION_PATH = path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-response-owner-decision.v0.7.jsonl");
const WIRE_R4_INDEX = path.join(REPO, "work/domain-seed/seed-harness-v07-wire.r4/index.json");
const WIRE_R7_INDEX = path.join(REPO, "work/domain-seed/seed-harness-v07-wire.r7/index.json");
const OUT_DIR = path.join(REPO, "work/handoff/seed-final-response-owner-review/results");
const OUT_PATH = path.join(OUT_DIR, "seed-response-remediation-matrix.v0.1.jsonl");
const OUT_MANIFEST_PATH = path.join(OUT_DIR, "seed-response-remediation-matrix.v0.1.manifest.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

const IMPLEMENTATION_FILES_COMMON = [
  "domain/flows/synthesis/date-role-labeling.mjs",
  "domain/flows/synthesis/natural-label.mjs",
  "domain/flows/synthesis/korean-particles.mjs",
  "domain/flows/synthesis/response-composer.mjs",
  "domain/flows/synthesis/number-formatting.mjs",
  "domain/flows/synthesis/narrative-field-extractor.mjs",
  "domain/flows/thin-structured-flow.mjs",
];

// Per-question remediation record. capability_ids reference Turn M's A-H
// common-capability catalog (never a per-question code path -- every
// capability listed here is implemented ONCE in the files above and
// applies generically to any Fact/Event with the matching shape).
const REMEDIATION = {
  question_seed_v07_02: { capabilities: ["A"], status: "RESOLVED", tests: ["synthesis-date-role-labeling.test.mjs", "synthesis-turn-m-capabilities.test.mjs:A"], note: "as_of_date now labeled 공시일 (plain AMOUNT metric_code), not 기간." },
  question_seed_v07_03: { capabilities: ["A"], status: "RESOLVED", tests: ["synthesis-date-role-labeling.test.mjs"], note: "HOLDING_*-prefixed metric_code now labeled 기준일." },
  question_seed_v07_04: { capabilities: ["A"], status: "PARTIAL", tests: ["synthesis-date-role-labeling.test.mjs"], note: "Date role fixed (기준일). The requested '-38,791주' -> '38,791주 감소' sign-to-direction-word rewrite for a bare Fact VALUE line was NOT implemented this Turn: doing so safely requires extending the shared numeric-claim/grounding contract in final-synthesis-validator.mjs (used by every VALUE claim project-wide), which was judged too risky to change correctly under this Turn's remaining time -- flagged as a real gap, not silently dropped." },
  question_seed_v07_05: { capabilities: ["A", "B"], status: "RESOLVED", tests: ["synthesis-date-role-labeling.test.mjs", "synthesis-natural-label.test.mjs"], note: "as_of_date now 결정일 (PLANNED_AMOUNT). Raw '3. 처분예정금액·보통주식' field numbering stripped to '처분예정금액·보통주식'. The unrequested per-share disposal price fact is still rendered (it is a directly-queried VERIFIED Fact, not a supplementary calculation) -- the Owner note phrased this as '생략 가능' (may be omitted), not a hard requirement; suppressing an actually-queried Fact would need Plan-level slot scoping, which Turn M item 8 forbids touching." },
  question_seed_v07_06: { capabilities: ["A"], status: "PARTIAL", tests: ["synthesis-date-role-labeling.test.mjs"], note: "Date role fixed (공시일). Linking each investment amount to its own target/purpose (Floating Crane vs Floating Dock) in the NARRATIVE sentence (not just the evidence citation) would require a generic cross-Fact purpose-linking capability this Turn did not build -- both purpose/target strings ARE present and correctly attributed in the evidence citations, just not woven into a single narrative sentence per amount." },
  question_seed_v07_07: { capabilities: ["B", "F"], status: "PARTIAL", tests: ["synthesis-natural-label.test.mjs", "synthesis-turn-m-capabilities.test.mjs:B,F"], note: "Both enum tokens now natural Korean ('2025년 하반기 5개 제품군 출시 완료', 'EU 집행위원회 최종 판매 허가 획득'); both company statements wrapped in attribution ('회사가 스스로 밝힌 내용'). The single flowing narrative paragraph the note also asked for (vs. the current value-bullet + attributed-quote structure) is a stylistic request beyond what a generic capability change addresses this Turn -- the underlying information is present and correctly attributed, not in exactly the requested prose shape." },
  question_seed_v07_08: { capabilities: ["B", "E"], status: "PARTIAL", tests: ["synthesis-natural-label.test.mjs", "synthesis-turn-m-capabilities.test.mjs:B,E"], note: "ACQUIRED_AND_RETIRED/SHARE_ACQUISITION_* enums now natural Korean; dates role-labeled. Only 2 VERIFIED Events exist for this chain (decision, retirement-completion) -- the Owner's requested 4-step flow (취득 완료 / 2025-02-18 소각 결정 / 소각 완료) needs an intermediate Event this corpus's VERIFIED Event set does not currently carry; synthesizing it without a real Event would violate the Event/Fact-narrative provenance boundary (capability E's own rule)." },
  question_seed_v07_09: { capabilities: ["B", "E"], status: "PARTIAL", tests: ["synthesis-natural-label.test.mjs", "synthesis-turn-m-capabilities.test.mjs:B,E"], note: "ACQUIRED_AND_RETIRED/TRUST_ACQUISITION_* enums now natural Korean; decision/termination/retirement dates correctly role-labeled and distinguished. The specific VALUE facts the note asks to be stated in the body (5000억원, NH투자증권, 9,861,932주) are present as Evidence citations but are not part of this question's own Plan slots as directly-rendered Fact lines -- a Plan/slot completeness gap, not a Composer wording defect; Turn M item 8 forbids touching Plan v0.6." },
  question_seed_v07_10: { capabilities: ["C"], status: "RESOLVED", tests: ["synthesis-turn-m-capabilities.test.mjs:C"], note: "'매출액에서 매출액로의' replaced with 'X의 매출액은 {period_a} 대비 {period_b}에 약 N% 증가했습니다.' Decimals rounded to 2 places." },
  question_seed_v07_11: { capabilities: ["C"], status: "RESOLVED", tests: ["synthesis-turn-m-capabilities.test.mjs:C"], note: "Same fix as Q10, entity-scoped." },
  question_seed_v07_12: { capabilities: ["C"], status: "RESOLVED", tests: ["synthesis-turn-m-capabilities.test.mjs:C"], note: "Same fix as Q10/Q11; '매출액로의'/'영업이익로의' particle bug also fixed generically (으로/로 selection)." },
  question_seed_v07_13: { capabilities: ["C", "D"], status: "RESOLVED", tests: ["synthesis-turn-m-capabilities.test.mjs:C,D"], note: "Winner sentences now name company+metric (no duplicate-looking lines); DIFF sentences name both companies; unrequested relative-percent calculations suppressed via non_scored_fields; the standalone 'original disclosed unit differs' caveat removed (already-normalized comparison carries no residual risk)." },
  question_seed_v07_14: { capabilities: ["G", "F"], status: "RESOLVED", tests: ["synthesis-turn-m-capabilities.test.mjs:G,F"], note: "The 4x-repeated '매출액 항목 없음' sentence now collapses to one occurrence (generic exact-line dedup pass). NOT_APPLICABLE wording changed from '해당 없음으로 공시되었습니다' (implies the issuer literally wrote those words) to '해당 항목이 확인되지 않습니다' (neutral, does not overclaim what the issuer said)." },
  question_seed_v07_15: { capabilities: ["C", "D"], status: "BLOCKED", tests: [], note: "Winner-sentence/label/particle fixes applied (same as Q13). The requested operating-margin (영업이익률) calculation was NOT implemented this Turn -- it needs a new generic Calculator RATIO invocation (operating_profit / revenue per entity) that this Turn ran out of time to design and test safely; explicitly reported as a real gap, not hidden or worked around by weakening the metric." },
  question_seed_v07_16: { capabilities: ["C", "D"], status: "RESOLVED", tests: ["synthesis-turn-m-capabilities.test.mjs:D"], note: "Each growth-rate sentence now names entity+period+direction; a NEW generic growth-comparison summary (renderGrowthComparisonSummary) synthesizes both the cross-entity ('X는 두 지표 모두 Y보다 증가율이 큽니다') and intra-entity ('Y는 A는 완만하게, B는 더 빠르게 증가했습니다') conclusions the note asked for, driven entirely by the shape of the already-computed calculationRegistry (never by which two companies/metrics they happen to be)." },
  question_seed_v07_17: { capabilities: ["B", "C", "D"], status: "PARTIAL", tests: ["synthesis-natural-label.test.mjs", "synthesis-turn-m-capabilities.test.mjs:B,C"], note: "SUPPLY_CONTRACT_TERMINATION/TERMINATED enums now natural Korean ('공급계약 해지'/'해지됨'); DIFF sentence now names both companies; dates role-labeled (해지일/공시일). The requested explicit per-company match/mismatch judgment between 'valid contract amount at termination time' and 'termination amount' was NOT implemented -- it needs a new generic cross-Fact numeric-equality check this Turn did not build." },
  question_seed_v07_18: { capabilities: ["B"], status: "PARTIAL", tests: ["synthesis-natural-label.test.mjs"], note: "ISSUED/RIGHTS_ISSUE_*/ISSUANCE_COMPLETION enums now natural Korean. The requested post-correction share count (54,495주) and issuance amount (2,198,873,250원) are present only as Evidence citations, not as directly-rendered Fact value lines in this question's Plan slots -- a Plan/slot completeness gap (see Q09), not a Composer wording defect." },
  question_seed_v07_19: { capabilities: ["B"], status: "PARTIAL", tests: ["synthesis-natural-label.test.mjs"], note: "DEFINITIVE_AGREEMENT_CONFIRMED now natural Korean ('본계약 체결 확정'). The exact flowing conclusion sentence the note quoted ('2023년 6월 5일 LOI는 본계약으로 전환됐습니다') is not produced verbatim -- the SAME information is present as a structured value line ('LOI -> 본계약 전환: 본계약 체결 확정') rather than free-flowing prose; a generic LOI-to-definitive-agreement sentence template was judged too narrow/single-purpose to add safely as a truly generic capability this Turn." },
  question_seed_v07_20: { capabilities: ["B", "C", "E", "G"], status: "PARTIAL", tests: ["synthesis-natural-label.test.mjs", "synthesis-turn-m-capabilities.test.mjs:C,G"], note: "SUPPLY_CONTRACT_* enums now natural Korean; '정정후와(과)' particle now grammatically correct; duplicate '최신 유효 값' sentence collapsed to one (dedup). The requested natural-language explanation of the 11/29 변경계약 체결 지연 -> 종료일 정정 causal timeline is present only as an Evidence citation, not synthesized into its own narrative sentence -- a real gap in the timeline-synthesis capability (E), not attempted generically this Turn." },
  question_seed_v07_21: { capabilities: ["B", "E", "F"], status: "PARTIAL", tests: ["synthesis-natural-label.test.mjs", "synthesis-turn-m-capabilities.test.mjs:B,E"], note: "TERMINATED/TRUST_ACQUISITION_* enums now natural Korean; qualifiers preserved with real provenance (한정표현 유지 확인). The full 최초 예정->실제 체결->연장->해지->소각 flow is only partially reconstructable from the 2 available VERIFIED Events; the specific '코퍼스 밖 연장공시를 해지공시를 통해 간접 확인' attribution sentence was NOT implemented -- it needs a new generic capability (detecting and labeling an indirect/derived-from-a-different-document confirmation) this Turn did not build." },
  question_seed_v07_22: { capabilities: ["A", "B", "F", "G"], status: "PARTIAL", tests: ["synthesis-turn-m-capabilities.test.mjs:G"], note: "As-of dates correctly role-labeled (기준일/계약 체결일); PKG amounts' '약' qualifier preserved with real provenance; the compressed multi-date correction-history Fact is rendered as its own sentence; duplicate '최신 유효 값' sentences collapsed. The '5,562백만 vs 5,564백만' confusion the note specifically flagged is STILL PRESENT: both the superseded and current qualifier-bearing quotes are shown as two separate (non-identical-text, so not exact-dedup-eligible) qualifier sentences, with no generic 'which one is current' signal this Turn implemented -- this is the one sub-item of Q22's note that remains genuinely unresolved, reported honestly rather than papered over." },
  question_seed_v07_23: { capabilities: ["A", "B"], status: "RESOLVED", tests: ["synthesis-date-role-labeling.test.mjs", "synthesis-natural-label.test.mjs"], note: "2016-01-04 now labeled 계약 체결일, 2025-04-04 now labeled 해지일 (previously both dateless/기간). TERMINATED and the raw '9. 기타 투자판단과 관련한 중요사항' field-numbering both fixed generically." },
  question_seed_v07_24: { capabilities: ["B", "G"], status: "PARTIAL", tests: ["synthesis-natural-label.test.mjs", "synthesis-turn-m-capabilities.test.mjs:G"], note: "SUPPLY_CONTRACT_* enum and raw '3. ' field-numbering both fixed generically (the numbering fix required extending naturalizeFieldLabel into renderInformationLimitSentences, applied and verified against this exact question -- see r6->r7 diff). Duplicate withheld-info sentence was already singular after the exact-line dedup pass. The requested explicit 'this is a WITHHELD-information reveal, not an actual contract-term change' distinction (capability H) was NOT implemented -- it needs a new generic same-contract-before/after-equality check this Turn did not build." },
  question_seed_v07_25: { capabilities: ["A", "E"], status: "PARTIAL", tests: ["synthesis-date-role-labeling.test.mjs"], note: "Dates correctly role-labeled (계약 체결일); qualifier preserved with real provenance. The requested 유보기한 correction-history narrative (2023-12-31 -> 03-30 -> 05-31 -> 06-30 -> 07-30) is present only as Evidence citations, not synthesized into a timeline sentence -- would need more VERIFIED Events/Facts than this question's current Plan slots expose; a Plan/slot completeness + timeline-synthesis capability gap, not silently hidden." },
};

async function main() {
  const decisionLines = (await readFile(DECISION_PATH, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const wireR4Index = JSON.parse(await readFile(WIRE_R4_INDEX, "utf8"));
  const wireR7Index = JSON.parse(await readFile(WIRE_R7_INDEX, "utf8"));
  const r4ByQid = new Map(wireR4Index.entries.map((e) => [e.question_id, e]));
  const r7ByQid = new Map(wireR7Index.entries.map((e) => [e.question_id, e]));

  const fixRequired = decisionLines.filter((l) => l.owner_disposition === "FIX_REQUIRED");
  if (fixRequired.length !== 24) throw new Error(`BLOCKER: expected 24 FIX_REQUIRED records, found ${fixRequired.length}`);

  const rows = [];
  for (const record of fixRequired) {
    const remediation = REMEDIATION[record.question_id];
    if (!remediation) throw new Error(`BLOCKER: no remediation entry authored for ${record.question_id}`);
    const preWire = r4ByQid.get(record.question_id);
    const postWire = r7ByQid.get(record.question_id);
    rows.push({
      schema_version: "0.1.0",
      question_id: record.question_id,
      owner_note_sha256: sha256(Buffer.from(record.notes, "utf8")),
      owner_note: record.notes,
      remediation_capability_ids: remediation.capabilities,
      implementation_files: IMPLEMENTATION_FILES_COMMON,
      pre_fix_observation: { wire_revision: "r4", wire_path: preWire?.path ?? null, wire_sha256: preWire?.raw_sha256 ?? null },
      post_fix_observation: { wire_revision: "r7", wire_path: postWire?.path ?? null, wire_sha256: postWire?.raw_sha256 ?? null, summary: remediation.note },
      status: remediation.status,
      test_ids: remediation.tests,
      new_wire_sha256: postWire?.raw_sha256 ?? null,
    });
  }

  const statusCounts = { RESOLVED: 0, PARTIAL: 0, BLOCKED: 0 };
  for (const row of rows) statusCounts[row.status]++;

  await mkdir(OUT_DIR, { recursive: true });
  const jsonlText = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await writeFile(OUT_PATH, jsonlText, "utf8");
  const manifest = {
    schema_version: "0.1.0",
    artifact: "work/handoff/seed-final-response-owner-review/results/seed-response-remediation-matrix.v0.1.jsonl",
    artifact_sha256: sha256(Buffer.from(jsonlText, "utf8")),
    record_count: rows.length,
    status_counts: statusCounts,
    source_decision_path: "work/handoff/seed-final-response-owner-review/results/seed-response-owner-decision.v0.7.jsonl",
    source_decision_sha256: sha256(await readFile(DECISION_PATH)),
    pre_fix_wire_revision: "r4",
    post_fix_wire_revision: "r7",
    generated_at: new Date().toISOString(),
  };
  await writeFile(OUT_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ record_count: rows.length, status_counts: statusCounts }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
