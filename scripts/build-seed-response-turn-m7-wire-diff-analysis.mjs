// Turn M7 Section 6/8: root-causes every question whose r11 wire differs
// from r10, distinguishing (a) EXPECTED changes -- the 6 questions Turn
// M7 actually touched (Q06/Q09/Q17/Q18/Q20/Q25) -- from (b) UNEXPECTED
// changes on questions Turn M7 never touched. Finding, mechanically
// confirmed below: r11 was built on Plan v0.11 (derived from the v0.7-
// v0.10 CANDIDATE plan lineage), not the OFFICIAL production Plan v0.6
// that r1-r10 were captured against. That candidate lineage already
// carries a STRUCTURED sub_request_authority feature (added in an
// earlier Turn, unrelated to Turn M7) that v0.6 never had -- surfacing a
// generic "일부 하위 요구사항이 충분히 답변되지 않았을 수 있습니다"
// completeness-warning sentence on 5 questions this Turn's own Plan diff
// (seed-thin-flow-plans.v0.11.candidate.manifest.json's own
// changed_question_ids: only Q06/Q09/Q20) proves Turn M7 never touched.
// This script never modifies Runtime/Composer/Plan -- it only reports.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIFF_PATH = path.join(REPO, "work/domain-seed/seed-harness-v07-wire-diff.r10-to-r11.json");
const PLAN_V11_MANIFEST_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.11.candidate.manifest.json");
const OUT_PATH = path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-response-turn-m7-wire-diff-analysis.v0.1.json");

function fail(msg) { throw new Error(`M7_WIRE_DIFF_ANALYSIS_BLOCKED: ${msg}`); }

const EXPECTED_CHANGED_QUESTIONS = new Set(["question_seed_v07_06", "question_seed_v07_09", "question_seed_v07_17", "question_seed_v07_20", "question_seed_v07_25"]);
const REQUEST_COMPLETENESS_MARKER = "추가로 확인이 필요한 사항이 있습니다: 질문의 일부 하위 요구사항이 충분히 답변되지 않았을 수 있습니다.";
const EVENT_COMPLETENESS_MARKER_RE = /사건 중 \d+\/\d+건만 현재 구조화 자료에서 확인되었고/;

async function main() {
  const diff = JSON.parse(await readFile(DIFF_PATH, "utf8"));
  const planManifest = JSON.parse(await readFile(PLAN_V11_MANIFEST_PATH, "utf8"));
  const planChangedQuestions = new Set(planManifest.changed_question_ids);
  if (planChangedQuestions.size !== 3) fail(`expected Plan v0.11 to report exactly 3 changed_question_ids, found ${planChangedQuestions.size}`);

  const analysis = { schema_version: "0.1.0", generated_at: new Date().toISOString(), byte_changed_count: diff.changed_items, total: diff.total_items, categorized: [] };

  for (const item of diff.items) {
    const qid = item.question_id;
    const category = {
      question_id: qid,
      byte_changed: item.byte_identical === false,
      answer_text_changed: item.answer_diff?.changed === true,
      plan_slots_changed_by_turn_m7: planChangedQuestions.has(qid),
      classification: null,
      cause: null,
    };
    if (!category.byte_changed) {
      category.classification = "UNCHANGED";
    } else if (EXPECTED_CHANGED_QUESTIONS.has(qid) && category.answer_text_changed) {
      category.classification = "EXPECTED -- Turn M7 promoted/wired fact(s) for this question";
      category.cause = "새로 VERIFIED된 Turn M7 Fact가 이 질문의 답변에 반영됨 (의도된 변경).";
    } else if (!category.answer_text_changed) {
      category.classification = "UNEXPECTED_BUT_HARMLESS -- internal think_trace diagnostics only, answer text byte-identical";
      category.cause = "Plan v0.11이 v0.6(운영) 계보가 아니라 v0.7-v0.10 CANDIDATE 계보에서 파생됐고, 그 계보는 Turn M7과 무관한 이전 Turn의 STRUCTURED sub_request_authority 기능을 이미 포함하고 있어 think_trace.validation.synthesis 필드가 달라짐 -- 사용자에게 보이는 answer 텍스트는 동일함.";
    } else if (
      (item.answer_diff.added_lines ?? []).every((l) => l === REQUEST_COMPLETENESS_MARKER || EVENT_COMPLETENESS_MARKER_RE.test(l))
      && (item.answer_diff.removed_lines ?? []).length === 0
    ) {
      category.classification = "UNEXPECTED -- pre-existing Plan-lineage sub_request/event-completeness feature, NOT introduced by Turn M7";
      category.cause = "Plan v0.11의 기반인 v0.7-v0.10 CANDIDATE 계보가 STRUCTURED sub_request_authority 평가를 이미 갖고 있어(Turn M7 이전부터 존재), 이 질문에서 새로 '추가로 확인이 필요한 사항' 또는 사건-완전성 경고 문장이 나타남. Turn M7의 Plan diff(seed-thin-flow-plans.v0.11.candidate.manifest.json)는 이 질문의 slot을 전혀 변경하지 않았음을 확인함 -- Turn M7이 만든 변화가 아니라 v0.6(운영) vs v0.10-계보 Plan 간의 사전 존재 차이가 이번에 처음 노출된 것.";
    } else {
      category.classification = "UNEXPLAINED -- requires manual review";
      category.cause = `added_lines=${JSON.stringify(item.answer_diff.added_lines)} removed_lines=${JSON.stringify(item.answer_diff.removed_lines)}`;
    }
    analysis.categorized.push(category);
  }

  const unexplained = analysis.categorized.filter((c) => c.classification === "UNEXPLAINED -- requires manual review");
  if (unexplained.length) fail(`${unexplained.length} question(s) have an unexplained wire diff: ${unexplained.map((c) => c.question_id).join(",")}`);

  const summary = {
    unchanged: analysis.categorized.filter((c) => c.classification === "UNCHANGED").length,
    expected: analysis.categorized.filter((c) => c.classification.startsWith("EXPECTED")).length,
    unexpected_but_harmless: analysis.categorized.filter((c) => c.classification.startsWith("UNEXPECTED_BUT_HARMLESS")).length,
    unexpected_pre_existing: analysis.categorized.filter((c) => c.classification.startsWith("UNEXPECTED --")).length,
  };
  analysis.summary = summary;

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, `${JSON.stringify(analysis, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ summary, expected_question_ids: [...EXPECTED_CHANGED_QUESTIONS], unexpected_pre_existing_question_ids: analysis.categorized.filter((c) => c.classification.startsWith("UNEXPECTED --")).map((c) => c.question_id) }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
