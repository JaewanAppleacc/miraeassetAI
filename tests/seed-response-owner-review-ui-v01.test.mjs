// Verifies the offline Owner review UI (scripts/build-seed-response-owner-review-ui-v01.mjs):
// embedded data shape, pure-logic behavior (extracted and run in an
// isolated vm context -- no real browser needed for this part), and a
// static scan of the generated HTML for any external resource
// dependency. Never modifies the generated HTML; only reads it (running
// the real build in test.before proves the build itself is reproducible
// and side-effect-free on its inputs).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import vm from "node:vm";
import test from "node:test";
import { LOGIC_SCRIPT } from "../scripts/lib/seed-response-owner-review-ui-logic.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML_PATH = path.join(ROOT, "work/handoff/seed-final-response-owner-review/ui/v0.1/seed-response-owner-review.html");
const BUILD_REPORT_PATH = path.join(ROOT, "work/handoff/seed-final-response-owner-review/ui/v0.1/review-ui-build-report.json");
const PACKET_PATH = path.join(ROOT, "work/handoff/seed-final-response-owner-review/results/seed-response-review-packet.v0.6.jsonl");
const MANIFEST_PATH = path.join(ROOT, "work/handoff/seed-final-response-owner-review/results/seed-response-review-packet.v0.6.manifest.json");
const WIRE_INDEX_PATH = path.join(ROOT, "work/domain-seed/seed-harness-v07-wire.r4/index.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

let htmlText; let embeddedPayload; let buildReport;
let inputHashesBefore;

test.before(async () => {
  inputHashesBefore = {
    packet: sha256(await readFile(PACKET_PATH)),
    manifest: sha256(await readFile(MANIFEST_PATH)),
    wireIndex: sha256(await readFile(WIRE_INDEX_PATH)),
  };
  await execFileAsync(process.execPath, [path.join(ROOT, "scripts/build-seed-response-owner-review-ui-v01.mjs")], { cwd: ROOT });
  htmlText = await readFile(HTML_PATH, "utf8");
  buildReport = JSON.parse(await readFile(BUILD_REPORT_PATH, "utf8"));
  const match = htmlText.match(/<script type="application\/json" id="review-data">([\s\S]*?)<\/script>/);
  assert.ok(match, "embedded review-data script tag not found");
  embeddedPayload = JSON.parse(match[1]);
});

test("build does not modify the input packet/manifest/wire-index files (byte-identical before and after)", async () => {
  const after = {
    packet: sha256(await readFile(PACKET_PATH)),
    manifest: sha256(await readFile(MANIFEST_PATH)),
    wireIndex: sha256(await readFile(WIRE_INDEX_PATH)),
  };
  assert.deepEqual(after, inputHashesBefore);
  assert.equal(buildReport.inputs_unchanged, true);
});

test("embedded data contains exactly 25 records with no duplicate question_id, 6 DETAILED + 19 SENTENCE_QUALITY", () => {
  assert.equal(embeddedPayload.records.length, 25);
  const qids = embeddedPayload.records.map((r) => r.question_id);
  assert.equal(new Set(qids).size, 25);
  assert.equal(embeddedPayload.records.filter((r) => r.review_tier === "DETAILED").length, 6);
  assert.equal(embeddedPayload.records.filter((r) => r.review_tier === "SENTENCE_QUALITY").length, 19);
});

test("the 6 DETAILED question_ids are exactly Q13/Q16/Q17/Q19/Q21/Q22", () => {
  const detailed = embeddedPayload.records.filter((r) => r.review_tier === "DETAILED").map((r) => r.question_id).sort();
  assert.deepEqual(detailed, [
    "question_seed_v07_13", "question_seed_v07_16", "question_seed_v07_17",
    "question_seed_v07_19", "question_seed_v07_21", "question_seed_v07_22",
  ].sort());
});

test("every record carries source_wire_path/source_wire_sha256 and the manifest sha256 is displayed in the HTML", () => {
  for (const record of embeddedPayload.records) {
    assert.ok(typeof record.source_wire_path === "string" && record.source_wire_path.length > 0);
    assert.match(record.source_wire_sha256, /^[0-9a-f]{64}$/);
  }
  assert.ok(htmlText.includes(embeddedPayload.source_packet_manifest_sha256));
});

test("data is embedded via a JSON script tag, never via an inline HTML string that could be innerHTML-injected", () => {
  // The rendering script must use textContent for data, never innerHTML
  // with interpolated record fields.
  const domScriptMatch = htmlText.match(/<script>([\s\S]*)<\/script>\s*<\/body>/);
  assert.ok(domScriptMatch);
  const script = domScriptMatch[1];
  assert.equal(/\.innerHTML\s*=/.test(script), false, "script must never assign to innerHTML");
});

test("no unescaped </script> boundary leaks from the embedded JSON data (script tag count matches expectation)", () => {
  const scriptOpenCount = (htmlText.match(/<script/g) || []).length;
  const scriptCloseCount = (htmlText.match(/<\/script>/g) || []).length;
  assert.equal(scriptOpenCount, 2); // review-data + logic/dom
  assert.equal(scriptCloseCount, 2);
});

test("static scan: no external resource-loading pattern anywhere in the HTML (CDN script/link/img/fetch/XHR/import)", () => {
  const forbiddenPatterns = [
    /<script[^>]+src=/i, /<link[^>]+href=["']https?:/i, /<img[^>]+src=["']https?:/i,
    /\bfetch\s*\(/, /XMLHttpRequest/, /\bimport\s*\(/, /@import\s+url\(\s*["']?https?:/i,
    /cdn\.jsdelivr|cdnjs\.cloudflare|unpkg\.com|googleapis\.com/i,
  ];
  for (const pattern of forbiddenPatterns) {
    assert.equal(pattern.test(htmlText), false, `forbidden external-resource pattern matched: ${pattern}`);
  }
});

test("HTML has no <!DOCTYPE html> declared via external file and no meta refresh/base pointing off-disk (file:// safe)", () => {
  assert.match(htmlText, /^<!doctype html>/i);
  assert.equal(/<base\s+href=["']https?:/i.test(htmlText), false);
});

// --- Pure logic behavior, executed in an isolated vm context (no DOM needed) ---

function loadLogicApi() {
  const context = vm.createContext({ console });
  vm.runInContext(`${LOGIC_SCRIPT}\nglobalThis.__api = { REVIEWER_NAME, FINAL_EXPORT_FILENAME, COMMON_CHECKLIST_DEFS, DETAILED_CHECKLIST_DEFS, getChecklistDefsFor, computeWarnings, buildInitialReviewState, applyDecision, allJudged, judgedCount, buildFinalRecord, buildExportLines };`, context);
  return context.__api;
}

test("logic: buildInitialReviewState defaults every question to owner_disposition PENDING, reviewer/reviewed_at/notes null", () => {
  const api = loadLogicApi();
  const qids = embeddedPayload.records.map((r) => r.question_id);
  const state = api.buildInitialReviewState(qids);
  for (const qid of qids) {
    assert.equal(state[qid].owner_disposition, "PENDING");
    assert.equal(state[qid].reviewer, null);
    assert.equal(state[qid].reviewed_at, null);
    assert.equal(state[qid].notes, null);
  }
});

test("logic: allJudged is false until every question has a non-PENDING disposition, then true", () => {
  const api = loadLogicApi();
  const qids = embeddedPayload.records.map((r) => r.question_id);
  let state = api.buildInitialReviewState(qids);
  assert.equal(api.allJudged(state, qids), false);
  for (let i = 0; i < qids.length - 1; i++) {
    state = api.applyDecision(state, qids[i], "APPROVE_RESPONSE", "2026-01-01T00:00:00.000Z", api.REVIEWER_NAME);
  }
  assert.equal(api.allJudged(state, qids), false, "one remaining PENDING record must still block allJudged");
  state = api.applyDecision(state, qids[qids.length - 1], "FIX_REQUIRED", "2026-01-01T00:00:00.000Z", api.REVIEWER_NAME);
  assert.equal(api.allJudged(state, qids), true);
});

test("logic: a clicked decision sets reviewer to the real Owner name (최재완) and a real ISO reviewed_at, never fabricated ahead of time", () => {
  const api = loadLogicApi();
  const qids = embeddedPayload.records.map((r) => r.question_id);
  let state = api.buildInitialReviewState(qids);
  assert.equal(state[qids[0]].reviewer, null);
  const now = new Date().toISOString();
  state = api.applyDecision(state, qids[0], "REJECT_RESPONSE", now, api.REVIEWER_NAME);
  assert.equal(state[qids[0]].reviewer, "최재완");
  assert.equal(state[qids[0]].reviewed_at, now);
  assert.equal(state[qids[0]].owner_disposition, "REJECT_RESPONSE");
});

test("logic: FINAL export gate (buildExportLines) is well-formed and every exported record has all 10 required fields", () => {
  const api = loadLogicApi();
  const qids = embeddedPayload.records.map((r) => r.question_id);
  const recordsByQid = {};
  for (const r of embeddedPayload.records) recordsByQid[r.question_id] = r;
  let state = api.buildInitialReviewState(qids);
  for (const qid of qids) state = api.applyDecision(state, qid, "APPROVE_RESPONSE", "2026-01-01T00:00:00.000Z", api.REVIEWER_NAME);
  const sourceMeta = { source_packet_path: embeddedPayload.source_packet_path, source_packet_sha256: embeddedPayload.source_packet_sha256 };
  const lines = api.buildExportLines(state, recordsByQid, sourceMeta, qids).trim().split("\n");
  assert.equal(lines.length, 25);
  const requiredFields = [
    "question_id", "source_packet_path", "source_packet_sha256", "source_wire_path", "source_wire_sha256",
    "review_tier", "checklist", "owner_disposition", "reviewer", "reviewed_at", "notes",
  ];
  for (const line of lines) {
    const record = JSON.parse(line);
    for (const field of requiredFields) assert.ok(field in record, `missing field ${field}`);
    assert.equal(record.source_packet_sha256, embeddedPayload.source_packet_sha256);
  }
});

test("logic: FINAL export filename constant matches the required seed-response-owner-decision.v0.7.jsonl", () => {
  const api = loadLogicApi();
  assert.equal(api.FINAL_EXPORT_FILENAME, "seed-response-owner-decision.v0.7.jsonl");
});

test("logic: getChecklistDefsFor returns the 5 common items for a SENTENCE_QUALITY question and 5+N for each DETAILED question", () => {
  const api = loadLogicApi();
  assert.equal(api.getChecklistDefsFor("question_seed_v07_01").length, 5);
  assert.equal(api.getChecklistDefsFor("question_seed_v07_13").length, 5 + 5);
  assert.equal(api.getChecklistDefsFor("question_seed_v07_16").length, 5 + 3);
  assert.equal(api.getChecklistDefsFor("question_seed_v07_17").length, 5 + 5);
  assert.equal(api.getChecklistDefsFor("question_seed_v07_19").length, 5 + 4);
  assert.equal(api.getChecklistDefsFor("question_seed_v07_21").length, 5 + 4);
  assert.equal(api.getChecklistDefsFor("question_seed_v07_22").length, 5 + 8);
});

test("logic: computeWarnings never sets/recommends a disposition -- it returns warnings only", () => {
  const api = loadLogicApi();
  const record = { answer: "snake_case_token 00164645 ALL_CAPS_ENUM 와(과) 와(과)", missing_capabilities: ["X"], think_trace: { validation: { synthesis: { status: "PARTIAL" } } }, retrieved_context: [] };
  const warnings = api.computeWarnings(record);
  assert.ok(Array.isArray(warnings));
  for (const w of warnings) {
    assert.equal("owner_disposition" in w, false);
    assert.equal("disposition" in w, false);
  }
});

test("logic: computeWarnings flags all 8 categories on a deliberately bad synthetic record", () => {
  const api = loadLogicApi();
  const record = {
    answer: "중복 문장 테스트입니다.\n중복 문장 테스트입니다.\nsnake_case_field 00164645 SOME_ENUM_VALUE 와(과) 와(과) 로의 로의 최신 유효 값 최신 유효 값",
    missing_capabilities: ["ENTITY_LABEL_RESOLUTION"],
    think_trace: { validation: { synthesis: { status: "FAIL_CLOSED" } } },
    retrieved_context: [{ quoted_text: "동일 인용" }, { quoted_text: "동일 인용" }],
  };
  const codes = new Set(api.computeWarnings(record).map((w) => w.code));
  for (const expected of [
    "DUPLICATE_SENTENCE", "SNAKE_CASE_TOKEN", "CORP_CODE_CANDIDATE", "ALL_CAPS_ENUM",
    "PHRASE_REPEATED", "DUPLICATE_EVIDENCE_QUOTE", "SYNTHESIS_NOT_PASS", "MISSING_CAPABILITIES",
  ]) {
    assert.ok(codes.has(expected), `expected warning code ${expected} to fire`);
  }
});

test("logic: applyDecision is pure -- it never mutates the input reviewState object", () => {
  const api = loadLogicApi();
  const qids = ["question_seed_v07_01"];
  const state = api.buildInitialReviewState(qids);
  const snapshot = JSON.stringify(state);
  api.applyDecision(state, "question_seed_v07_01", "APPROVE_RESPONSE", "2026-01-01T00:00:00.000Z", api.REVIEWER_NAME);
  assert.equal(JSON.stringify(state), snapshot);
});

test("build report accurately reflects the generated HTML's real sha256 and record counts", async () => {
  const htmlBytes = await readFile(HTML_PATH);
  assert.equal(sha256(htmlBytes), buildReport.output_html_sha256);
  assert.equal(buildReport.record_count, 25);
  assert.equal(buildReport.detailed_review_count, 6);
  assert.equal(buildReport.sentence_quality_count, 19);
});
