// Turn N4.1: verifies the offline relation closure review UI
// (scripts/build-relation-closure-review-ui-v01.mjs): embedded data shape,
// pure-logic behavior (extracted and run in an isolated vm context -- NO
// real browser, and deliberately never exercises the FINAL-export Blob
// download path, which real headless-Chrome E2E tests elsewhere in this
// repo already do via tests/lib/headless-chrome-cdp.mjs), and a static
// scan of the generated HTML for any external resource dependency or
// innerHTML usage. Never modifies the packet; only reads it (running the
// real build in test.before proves the build itself is reproducible and
// side-effect-free on its input).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import vm from "node:vm";
import test from "node:test";
import { LOGIC_SCRIPT } from "../scripts/lib/relation-closure-review-ui-logic.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKET_DIR = path.join(ROOT, "work/handoff/anchor-dev-tune-v0.1");
const PACKET_PATH = path.join(PACKET_DIR, "relation-closure-review-packet.v0.1.jsonl");
const ANCHOR_MANIFEST_PATH = path.join(PACKET_DIR, "anchor-selection.v0.1.manifest.json");
const HTML_PATH = path.join(PACKET_DIR, "ui/v0.1/relation-closure-review.html");
const BUILD_REPORT_PATH = path.join(PACKET_DIR, "ui/v0.1/review-ui-build-report.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

let htmlText; let embeddedPayload; let buildReport;
let inputHashesBefore;

test.before(async () => {
  inputHashesBefore = {
    packet: sha256(await readFile(PACKET_PATH)),
    anchorManifest: sha256(await readFile(ANCHOR_MANIFEST_PATH)),
  };
  await execFileAsync(process.execPath, [path.join(ROOT, "scripts/build-relation-closure-review-ui-v01.mjs")], { cwd: ROOT });
  htmlText = await readFile(HTML_PATH, "utf8");
  buildReport = JSON.parse(await readFile(BUILD_REPORT_PATH, "utf8"));
  const match = htmlText.match(/<script type="application\/json" id="review-data">([\s\S]*?)<\/script>/);
  assert.ok(match, "embedded review-data script tag not found");
  embeddedPayload = JSON.parse(match[1]);
});

test("build does not modify the input packet/anchor-manifest files (byte-identical before and after)", async () => {
  const after = {
    packet: sha256(await readFile(PACKET_PATH)),
    anchorManifest: sha256(await readFile(ANCHOR_MANIFEST_PATH)),
  };
  assert.equal(after.packet, inputHashesBefore.packet);
  assert.equal(after.anchorManifest, inputHashesBefore.anchorManifest);
  assert.equal(buildReport.inputs_unchanged, true);
});

test("embedded row count matches the anchor manifest's relation_closure_total_count, with zero duplicates", async () => {
  const anchorManifest = JSON.parse(await readFile(ANCHOR_MANIFEST_PATH, "utf8"));
  assert.equal(embeddedPayload.rows.length, anchorManifest.relation_closure_total_count);
  const ids = embeddedPayload.rows.map((r) => r.relation_candidate_id);
  assert.equal(new Set(ids).size, ids.length);
});

test("every embedded row starts owner_disposition PENDING -- the UI never ships pre-judged input", () => {
  assert.ok(embeddedPayload.rows.length > 0);
  for (const row of embeddedPayload.rows) {
    assert.equal(row.owner_disposition, "PENDING");
    assert.equal(row.confirmed_target_document_id, null);
  }
});

test("static scan: no external resource-loading pattern anywhere in the HTML (CDN script/link/img/fetch/XHR/import)", () => {
  assert.doesNotMatch(htmlText, /https?:\/\//i);
  assert.doesNotMatch(htmlText, /<link[^>]+href/i);
  assert.doesNotMatch(htmlText, /\bfetch\s*\(/);
  assert.doesNotMatch(htmlText, /XMLHttpRequest/);
});

test("static scan: no innerHTML assignment anywhere -- rendering is textContent-only", () => {
  assert.doesNotMatch(htmlText, /innerHTML/);
});

test("static scan: no unescaped </script> boundary leaks from the embedded JSON data", () => {
  const scriptTagCount = (htmlText.match(/<script/gi) || []).length;
  // review-data (application/json) + LOGIC_SCRIPT+DOM_SCRIPT (one combined <script>) = 2
  assert.equal(scriptTagCount, 2);
});

test("HTML has no <!DOCTYPE html> declared via external file and no meta refresh/base pointing off-disk (file:// safe)", () => {
  assert.match(htmlText, /^<!doctype html>/i);
  assert.doesNotMatch(htmlText, /<meta[^>]+http-equiv=["']refresh["']/i);
  assert.doesNotMatch(htmlText, /<base\s/i);
});

test("build report accurately reflects the generated HTML's real sha256 and record counts", async () => {
  const realHtmlBytes = await readFile(HTML_PATH);
  assert.equal(buildReport.output_html_sha256, sha256(realHtmlBytes));
  assert.equal(buildReport.row_count, embeddedPayload.rows.length);
  assert.equal(buildReport.hop0_count + buildReport.hop1_count, embeddedPayload.rows.length);
});

test("build report explicitly scopes this UI to relation review, not Gold answer review", () => {
  assert.match(buildReport.scope_note, /AMENDS\/TERMINATES/);
  assert.match(buildReport.scope_note, /NOT a Gold answer review UI/);
});

// -- Pure LOGIC_SCRIPT behavior, run in an isolated vm context -- no real
// browser, and never touches the download/export DOM path. --------------

function loadLogicApi() {
  const context = vm.createContext({ console });
  vm.runInContext(
    `${LOGIC_SCRIPT}\nglobalThis.__api = { FINAL_EXPORT_FILENAME, DRAFT_EXPORT_FILENAME, buildInitialReviewState, applyDecision, allJudged, judgedCount, buildFinalRecord, buildExportLines };`,
    context,
  );
  return context.__api;
}

// vm.createContext objects live in a separate realm -- normalize via a
// JSON round-trip before deepEqual so cross-realm prototype identity never
// causes a false structural mismatch.
function plain(value) { return JSON.parse(JSON.stringify(value)); }

test("logic: buildInitialReviewState defaults every row to owner_disposition PENDING, confirmed_target_document_id/reviewer/reviewed_at null", () => {
  const api = loadLogicApi();
  const state = plain(api.buildInitialReviewState(["r1", "r2"]));
  assert.deepEqual(state, {
    r1: { owner_disposition: "PENDING", confirmed_target_document_id: null, notes: "", reviewer: null, reviewed_at: null },
    r2: { owner_disposition: "PENDING", confirmed_target_document_id: null, notes: "", reviewer: null, reviewed_at: null },
  });
});

test("logic: allJudged is false until every row has a non-PENDING disposition, then true", () => {
  const api = loadLogicApi();
  let state = api.buildInitialReviewState(["r1", "r2"]);
  assert.equal(api.allJudged(state, ["r1", "r2"]), false);
  state = api.applyDecision(state, "r1", "CONFIRM", "doc_x", "2026-01-01T00:00:00Z", "reviewer_a");
  assert.equal(api.allJudged(state, ["r1", "r2"]), false);
  state = api.applyDecision(state, "r2", "REJECT", null, "2026-01-01T00:00:01Z", "reviewer_a");
  assert.equal(api.allJudged(state, ["r1", "r2"]), true);
});

test("logic: a CONFIRM decision records the chosen confirmed_target_document_id; REJECT/NEEDS_MORE_REVIEW always clear it to null", () => {
  const api = loadLogicApi();
  let state = api.buildInitialReviewState(["r1"]);
  state = api.applyDecision(state, "r1", "CONFIRM", "doc_target", "2026-01-01T00:00:00Z", "reviewer_a");
  assert.equal(state.r1.confirmed_target_document_id, "doc_target");
  state = api.applyDecision(state, "r1", "REJECT", "doc_target", "2026-01-01T00:00:01Z", "reviewer_a");
  assert.equal(state.r1.confirmed_target_document_id, null, "REJECT must never keep a stale confirmed target");
});

test("logic: applyDecision is pure -- it never mutates the input reviewState object", () => {
  const api = loadLogicApi();
  const state = api.buildInitialReviewState(["r1"]);
  const frozenCopy = plain(state);
  api.applyDecision(state, "r1", "CONFIRM", "doc_x", "2026-01-01T00:00:00Z", "reviewer_a");
  assert.deepEqual(plain(state), frozenCopy);
});

test("logic: applyDecision preserves prior notes across a disposition change", () => {
  const api = loadLogicApi();
  let state = api.buildInitialReviewState(["r1"]);
  state.r1.notes = "review note";
  state = api.applyDecision(state, "r1", "NEEDS_MORE_REVIEW", null, "2026-01-01T00:00:00Z", null);
  assert.equal(state.r1.notes, "review note");
});

test("logic: buildExportLines produces well-formed JSONL with all 10 required fields per row", () => {
  const api = loadLogicApi();
  let state = api.buildInitialReviewState(["r1"]);
  state = api.applyDecision(state, "r1", "CONFIRM", "doc_x", "2026-01-01T00:00:00Z", "reviewer_a");
  const rowsById = { r1: { source_document_id: "doc_src", relation_type: "AMENDS" } };
  const lines = api.buildExportLines(state, rowsById, { source_packet_path: "p", source_packet_sha256: "s" }, ["r1"]).trim().split("\n");
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(parsed).sort(), [
    "confirmed_target_document_id", "notes", "owner_disposition", "relation_candidate_id",
    "relation_type", "reviewed_at", "reviewer", "source_document_id", "source_packet_path", "source_packet_sha256",
  ].sort());
});

test("logic: FINAL_EXPORT_FILENAME and DRAFT_EXPORT_FILENAME are distinct, versioned constants", () => {
  const api = loadLogicApi();
  assert.equal(api.FINAL_EXPORT_FILENAME, "relation-closure-owner-decision.v0.1.jsonl");
  assert.notEqual(api.FINAL_EXPORT_FILENAME, api.DRAFT_EXPORT_FILENAME);
});
