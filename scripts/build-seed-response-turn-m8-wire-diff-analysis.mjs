// Turn M8 Section 8: corrected, MUTUALLY EXCLUSIVE 4-category diff
// analysis across r10 (pre-Turn-M7 baseline) / r11 (Turn M7's polluted
// Candidate-Plan-lineage result) / r13 (Turn M8's clean v0.6-based Plan
// result, after the naturalizeFieldLabel bullet-prefix fix -- r12 was
// the pre-fix capture, superseded by r13, never reused as final).
// Every one of the 25 questions lands in EXACTLY one category; the four
// category counts must sum to 25 (never 26, as Turn M7's own report
// mis-tallied).
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GOLD_PATH = path.join(REPO, "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl");
const OUT_DIR = path.join(REPO, "work/handoff/seed-final-response-owner-review/results");
const OUT_PATH = path.join(OUT_DIR, "seed-response-turn-m8-wire-diff-analysis.v0.1.json");
const FINAL_REVISION = 13;

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function fail(msg) { throw new Error(`M8_WIRE_DIFF_ANALYSIS_BLOCKED: ${msg}`); }
function wirePath(rev, qid) { return path.join(REPO, `work/domain-seed/seed-harness-v07-wire.r${rev}`, `${qid}.response.json`); }

const EXPECTED_CONTENT_CHANGE_QIDS = new Set(["question_seed_v07_06", "question_seed_v07_09", "question_seed_v07_17", "question_seed_v07_18", "question_seed_v07_20", "question_seed_v07_25"]);

async function main() {
  const gold = (await readFile(GOLD_PATH, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  if (gold.length !== 25) fail(`expected 25 Gold questions, found ${gold.length}`);

  const rows = [];
  for (const g of gold) {
    const qid = g.question_id;
    const [r10Bytes, r11Bytes, r13Bytes] = await Promise.all([
      readFile(wirePath(10, qid)), readFile(wirePath(11, qid)), readFile(wirePath(FINAL_REVISION, qid)),
    ]);
    const r10Sha = sha256(r10Bytes); const r11Sha = sha256(r11Bytes); const r13Sha = sha256(r13Bytes);
    const r10 = JSON.parse(r10Bytes.toString("utf8"));
    const r13 = JSON.parse(r13Bytes.toString("utf8"));
    const byteIdenticalR10R13 = r10Sha === r13Sha;
    const answerIdenticalR10R13 = r10.answer === r13.answer;

    let category; let reason;
    if (byteIdenticalR10R13) {
      category = "UNCHANGED";
      reason = "r13는 r10과 byte-for-byte 동일함 (Plan/Fact 변경이 이 질문에 전혀 영향을 주지 않음).";
    } else if (!answerIdenticalR10R13 && EXPECTED_CONTENT_CHANGE_QIDS.has(qid)) {
      category = "EXPECTED_CONTENT_CHANGE";
      reason = "Turn M7/M8에서 승격/연결된 새 Fact 또는 Q18 information_limit 선언이 실제 answer 텍스트에 반영됨 (의도된 변경).";
    } else if (answerIdenticalR10R13 && !byteIdenticalR10R13) {
      category = "EXPECTED_DIAGNOSTICS_ONLY_CHANGE";
      reason = "answer 텍스트는 r10과 동일하지만 think_trace/retrieved_context 등 내부 진단 필드가 다름 (예: corpus_snapshot_id/fact_coverage_snapshot_id 식별자 차이) -- 사용자에게 보이는 내용은 변경되지 않음.";
    } else {
      category = "UNEXPECTED_CHANGE";
      reason = "이 질문은 승인된 6개 변경 목록에 없는데 answer 텍스트가 변경됨 -- 수동 조사 필요.";
    }

    rows.push({
      question_id: qid,
      r10_sha256: r10Sha, r11_sha256: r11Sha, r13_sha256: r13Sha,
      r10_r13_byte_identical: byteIdenticalR10R13,
      r10_r13_answer_identical: answerIdenticalR10R13,
      category, reason,
    });
  }

  if (rows.length !== 25) fail(`internal: expected 25 rows, built ${rows.length}`);
  const seenIds = new Set(rows.map((r) => r.question_id));
  if (seenIds.size !== 25) fail("duplicate question_id in diff analysis");

  const unexpected = rows.filter((r) => r.category === "UNEXPECTED_CHANGE");
  if (unexpected.length > 0) fail(`${unexpected.length} unexpected change(s): ${unexpected.map((r) => r.question_id).join(",")}`);

  const counts = rows.reduce((acc, r) => { acc[r.category] = (acc[r.category] ?? 0) + 1; return acc; }, {});
  const sum = Object.values(counts).reduce((a, b) => a + b, 0);
  if (sum !== 25) fail(`category counts sum to ${sum}, expected exactly 25`);
  const expectedContentChangeCount = rows.filter((r) => r.category === "EXPECTED_CONTENT_CHANGE").length;
  if (expectedContentChangeCount !== 6) fail(`expected exactly 6 EXPECTED_CONTENT_CHANGE rows, found ${expectedContentChangeCount}`);

  // Explicit Section 8 requirement: confirm Q05/Q07/Q19/Q21/Q24 (the
  // questions Turn M7's polluted Plan lineage falsely changed) are now
  // UNCHANGED under the clean Plan.
  const previouslyPollutedNowClean = {};
  for (const qid of ["question_seed_v07_05", "question_seed_v07_07", "question_seed_v07_19", "question_seed_v07_21", "question_seed_v07_24"]) {
    const row = rows.find((r) => r.question_id === qid);
    previouslyPollutedNowClean[qid] = row.category === "UNCHANGED";
  }
  if (Object.values(previouslyPollutedNowClean).some((v) => v !== true)) {
    fail(`Q05/07/19/21/24 did not all return to UNCHANGED: ${JSON.stringify(previouslyPollutedNowClean)}`);
  }

  const analysis = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    baseline: {
      r10: "Turn M7 이전 기준 (production Plan v0.6)",
      r11: "Turn M7의 오염된 Candidate Plan(v0.11) 결과",
      r13: "Turn M8의 clean v0.6-based Plan(v0.12.clean.candidate) 결과 -- naturalizeFieldLabel 불릿 접두사 수정 반영 후 최종 캡처 (r12는 수정 전 캡처, superseded)",
    },
    final_revision: FINAL_REVISION,
    category_counts: counts,
    category_counts_sum: sum,
    q05_q07_q19_q21_q24_returned_to_unchanged: previouslyPollutedNowClean,
    rows,
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_PATH, `${JSON.stringify(analysis, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ category_counts: counts, sum, q05_q07_q19_q21_q24_returned_to_unchanged: previouslyPollutedNowClean }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
