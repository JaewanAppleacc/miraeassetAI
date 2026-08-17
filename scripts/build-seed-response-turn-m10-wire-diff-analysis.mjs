// Turn M10 Section 14: r13->r14 diff + QA analysis. Classifies each of
// the 25 Gold questions and independently scans every r14 answer for:
// snake_case tokens, 8-digit corp_code, raw SCREAMING_SNAKE_CASE enum
// tokens, duplicate non-empty lines, and (heuristically) an unresolved
// "계약 체결일" mislabel that should have been fixed by the new
// semantic-role registry. r10 is intentionally NOT used as the baseline
// here (r13 already reflects the promoted-Fact/information_limits work
// from Turns M7-M9) -- Turn M10's own comparison basis is r13 -> r14.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GOLD_PATH = path.join(REPO, "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl");
const OUT_DIR = path.join(REPO, "work/handoff/seed-final-response-owner-review/results");
const OUT_PATH = path.join(OUT_DIR, "seed-response-turn-m10-wire-diff-analysis.v0.1.json");

const TARGET_QUESTION_IDS = new Set([
  "question_seed_v07_06", "question_seed_v07_09", "question_seed_v07_17",
  "question_seed_v07_18", "question_seed_v07_20", "question_seed_v07_25",
]);

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function fail(msg) { throw new Error(`M10_WIRE_DIFF_ANALYSIS_BLOCKED: ${msg}`); }
function wirePath(rev, qid) { return path.join(REPO, `work/domain-seed/seed-harness-v07-wire.r${rev}`, `${qid}.response.json`); }

function scanQuality(answer) {
  const warnings = [];
  const snake = answer.match(/\b[a-z]{2,}(?:_[a-z0-9]{2,})+\b/g);
  if (snake) warnings.push({ code: "SNAKE_CASE", detail: [...new Set(snake)].join(", ") });
  const corpCode = answer.match(/\b\d{8}\b/g);
  if (corpCode) warnings.push({ code: "CORP_CODE_8DIGIT", detail: [...new Set(corpCode)].join(", ") });
  const rawEnum = answer.match(/\b[A-Z]{2,}(?:_[A-Z0-9]{2,})+\b/g);
  if (rawEnum) warnings.push({ code: "RAW_ENUM", detail: [...new Set(rawEnum)].join(", ") });
  const lines = answer.split("\n").filter((l) => l.trim().length > 0);
  const seen = new Set(); const dup = [];
  for (const l of lines) { if (seen.has(l)) dup.push(l); else seen.add(l); }
  if (dup.length) warnings.push({ code: "DUPLICATE_SENTENCE", detail: dup.join(" | ") });
  if (answer.includes("계약 체결일")) warnings.push({ code: "POSSIBLE_UNRESOLVED_CONTRACT_EXECUTION_DATE_LABEL", detail: "answer still contains 계약 체결일" });
  return warnings;
}

async function main() {
  const gold = (await readFile(GOLD_PATH, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  if (gold.length !== 25) fail(`expected 25 Gold questions, found ${gold.length}`);

  const rows = [];
  for (const g of gold) {
    const qid = g.question_id;
    const [r13Bytes, r14Bytes] = await Promise.all([readFile(wirePath(13, qid)), readFile(wirePath(14, qid))]);
    const r13Sha = sha256(r13Bytes); const r14Sha = sha256(r14Bytes);
    const r13 = JSON.parse(r13Bytes.toString("utf8"));
    const r14 = JSON.parse(r14Bytes.toString("utf8"));
    const byteIdentical = r13Sha === r14Sha;
    const answerIdentical = r13.answer === r14.answer;
    const isTarget = TARGET_QUESTION_IDS.has(qid);

    let category;
    if (byteIdentical) category = "UNCHANGED";
    else if (isTarget) category = "EXPECTED_TARGET_CHANGE";
    else category = "EXPECTED_COMMON_RULE_GENERALIZATION";

    const qualityWarnings = scanQuality(r14.answer);
    const tt14 = JSON.parse(r14.think_trace);

    rows.push({
      question_id: qid,
      r13_sha256: r13Sha, r14_sha256: r14Sha,
      byte_identical: byteIdentical, answer_identical: answerIdentical,
      category,
      execution_mode: tt14.execution_mode,
      answerability: tt14.validation?.answerability ?? null,
      synthesis_status: tt14.validation?.synthesis?.status ?? null,
      quality_warnings: qualityWarnings,
    });
  }

  if (rows.length !== 25) fail(`internal: expected 25 rows, built ${rows.length}`);
  const unresolvedEarlyExit = rows.filter((r) => r.execution_mode !== "STRUCTURED");
  if (unresolvedEarlyExit.length > 0) fail(`${unresolvedEarlyExit.length} question(s) did not resolve as STRUCTURED: ${unresolvedEarlyExit.map((r) => r.question_id).join(",")}`);
  const fatalQuality = rows.filter((r) => r.quality_warnings.some((w) => w.code === "CORP_CODE_8DIGIT" || w.code === "RAW_ENUM"));
  if (fatalQuality.length > 0) fail(`${fatalQuality.length} question(s) leaked a raw corp_code/enum: ${fatalQuality.map((r) => r.question_id).join(",")}`);

  const counts = rows.reduce((acc, r) => { acc[r.category] = (acc[r.category] ?? 0) + 1; return acc; }, {});
  const sum = Object.values(counts).reduce((a, b) => a + b, 0);
  if (sum !== 25) fail(`category counts sum to ${sum}, expected 25`);
  const targetChangedCount = rows.filter((r) => r.category === "EXPECTED_TARGET_CHANGE").length;
  if (targetChangedCount !== 6) fail(`expected exactly 6 EXPECTED_TARGET_CHANGE questions, found ${targetChangedCount}`);
  for (const qid of TARGET_QUESTION_IDS) {
    const row = rows.find((r) => r.question_id === qid);
    if (row.byte_identical) fail(`${qid}: target question unexpectedly byte-identical to r13`);
  }

  const analysis = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    baseline: { r13: "Turn M8 clean-Plan Candidate result (pre-Turn-M10)", r14: "Turn M10 common Composer/Validator/date-role/grouping fixes + Plan v0.13 (Q18 correction Event connection)" },
    category_counts: counts,
    category_counts_sum: sum,
    target_question_ids: [...TARGET_QUESTION_IDS].sort(),
    rows,
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_PATH, `${JSON.stringify(analysis, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ category_counts: counts, sum, target_changed_count: targetChangedCount, out_path: path.relative(REPO, OUT_PATH) }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
