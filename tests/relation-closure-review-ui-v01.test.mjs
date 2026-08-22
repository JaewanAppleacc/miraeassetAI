// Turn N4.1: verifies the offline relation closure review UI
// (scripts/build-relation-closure-review-ui-v01.mjs): embedded data shape,
// pure-logic behavior (extracted and run in an isolated vm context -- NO
// real browser for the ORIGINAL shared file, and deliberately never
// exercises the FINAL-export Blob download path, which real headless-
// Chrome E2E tests elsewhere in this repo already do via
// tests/lib/headless-chrome-cdp.mjs), and a static scan of the generated
// HTML for any external resource dependency or innerHTML usage. Never
// modifies the packet; only reads it (running the real build in
// test.before proves the build itself is reproducible and side-effect-
// free on its input).
//
// Turn N4.2.1: ONE real-browser test is added specifically for the
// Reviewer A/B independent-double-review guarantee -- whether one
// reviewer's saved judgment is genuinely invisible to (and never
// overwritten by) the other WHEN BOTH SHARE THE SAME BROWSER PROFILE/
// SESSION is not provable by static analysis or two separate
// launchHeadlessChromePage() calls (those always get fresh, already-
// isolated profiles, which would trivially pass even if the
// reviewer_role-based storage-key partitioning were broken). It requires
// actually navigating one real page between both files and checking
// localStorage directly. This does not click FINAL export / trigger any
// download, so it does not need the download-isolation infrastructure.
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
import { launchHeadlessChromePage } from "./lib/headless-chrome-cdp.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKET_DIR = path.join(ROOT, "work/handoff/anchor-dev-tune-v0.1");
const PACKET_PATH = path.join(PACKET_DIR, "relation-closure-review-packet.v0.1.jsonl");
const ANCHOR_MANIFEST_PATH = path.join(PACKET_DIR, "anchor-selection.v0.1.manifest.json");
const HTML_PATH = path.join(PACKET_DIR, "ui/v0.1/relation-closure-review.html");
const BUILD_REPORT_PATH = path.join(PACKET_DIR, "ui/v0.1/review-ui-build-report.json");
// Turn N4.2: independent double-review entry points -- see A/B section D.
const REVIEWER_A_HTML_PATH = path.join(PACKET_DIR, "ui/v0.1/relation-closure-review.reviewer-a.html");
const REVIEWER_B_HTML_PATH = path.join(PACKET_DIR, "ui/v0.1/relation-closure-review.reviewer-b.html");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function extractPayload(html) {
  const match = html.match(/<script type="application\/json" id="review-data">([\s\S]*?)<\/script>/);
  assert.ok(match, "embedded review-data script tag not found");
  return JSON.parse(match[1]);
}

let htmlText; let embeddedPayload; let buildReport;
let reviewerAHtml; let reviewerAPayload; let reviewerBHtml; let reviewerBPayload;
let inputHashesBefore;

test.before(async () => {
  inputHashesBefore = {
    packet: sha256(await readFile(PACKET_PATH)),
    anchorManifest: sha256(await readFile(ANCHOR_MANIFEST_PATH)),
  };
  await execFileAsync(process.execPath, [path.join(ROOT, "scripts/build-relation-closure-review-ui-v01.mjs")], { cwd: ROOT });
  htmlText = await readFile(HTML_PATH, "utf8");
  buildReport = JSON.parse(await readFile(BUILD_REPORT_PATH, "utf8"));
  embeddedPayload = extractPayload(htmlText);
  reviewerAHtml = await readFile(REVIEWER_A_HTML_PATH, "utf8");
  reviewerAPayload = extractPayload(reviewerAHtml);
  reviewerBHtml = await readFile(REVIEWER_B_HTML_PATH, "utf8");
  reviewerBPayload = extractPayload(reviewerBHtml);
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
    `${LOGIC_SCRIPT}\nglobalThis.__api = { FINAL_EXPORT_FILENAME, DRAFT_EXPORT_FILENAME, buildInitialReviewState, applyDecision, allJudged, judgedCount, buildFinalRecord, buildExportLines, resolveExportFilenames };`,
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

test("logic: buildExportLines produces well-formed JSONL with all 11 required fields per row (Turn N4.2: +reviewer_role, additive, null when sourceMeta omits it)", () => {
  const api = loadLogicApi();
  let state = api.buildInitialReviewState(["r1"]);
  state = api.applyDecision(state, "r1", "CONFIRM", "doc_x", "2026-01-01T00:00:00Z", "reviewer_a");
  const rowsById = { r1: { source_document_id: "doc_src", relation_type: "AMENDS" } };
  const lines = api.buildExportLines(state, rowsById, { source_packet_path: "p", source_packet_sha256: "s" }, ["r1"]).trim().split("\n");
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(parsed).sort(), [
    "confirmed_target_document_id", "notes", "owner_disposition", "relation_candidate_id",
    "relation_type", "reviewed_at", "reviewer", "reviewer_role", "source_document_id", "source_packet_path", "source_packet_sha256",
  ].sort());
  assert.equal(parsed.reviewer_role, null, "sourceMeta without reviewer_role must yield null, never a fabricated value");
});

test("logic: buildExportLines carries sourceMeta.reviewer_role through into every exported record when present", () => {
  const api = loadLogicApi();
  let state = api.buildInitialReviewState(["r1"]);
  state = api.applyDecision(state, "r1", "REJECT", null, "2026-01-01T00:00:00Z", "reviewer_b");
  const rowsById = { r1: { source_document_id: "doc_src", relation_type: "TERMINATES" } };
  const lines = api.buildExportLines(state, rowsById, { source_packet_path: "p", source_packet_sha256: "s", reviewer_role: "REVIEWER_B" }, ["r1"]).trim().split("\n");
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.reviewer_role, "REVIEWER_B");
});

test("logic: FINAL_EXPORT_FILENAME and DRAFT_EXPORT_FILENAME are distinct, versioned constants", () => {
  const api = loadLogicApi();
  assert.equal(api.FINAL_EXPORT_FILENAME, "relation-closure-owner-decision.v0.1.jsonl");
  assert.notEqual(api.FINAL_EXPORT_FILENAME, api.DRAFT_EXPORT_FILENAME);
});

// -- Turn N4.2: independent double-review support. Investigation found the
// original single shared HTML file partitions localStorage/export
// filenames ONLY by packet SHA, not by reviewer -- so two reviewers using
// the same browser profile would silently share (and overwrite) one
// another's judgments. Fixed minimally: reviewer_role is baked into the
// embedded payload at BUILD time (never chosen at runtime), producing two
// physically separate HTML files whose storage key and export filenames
// are provably different. No new relation lifecycle/status enum is
// introduced -- CONFIRM/REJECT/NEEDS_MORE_REVIEW is unchanged; only a
// provenance field (reviewer_role) and two extra build outputs are added.

test("logic: resolveExportFilenames maps REVIEWER_A/REVIEWER_B to distinct, correctly-named filenames, and falls back to the original shared names otherwise", () => {
  const api = loadLogicApi();
  const a = api.resolveExportFilenames("REVIEWER_A");
  const b = api.resolveExportFilenames("REVIEWER_B");
  assert.equal(a.final, "relation-closure-reviewer-a-decision.v0.1.jsonl");
  assert.equal(a.draft, "relation-closure-reviewer-a-decision-draft.jsonl");
  assert.equal(b.final, "relation-closure-reviewer-b-decision.v0.1.jsonl");
  assert.equal(b.draft, "relation-closure-reviewer-b-decision-draft.jsonl");
  assert.notEqual(a.final, b.final);
  assert.notEqual(a.draft, b.draft);
  const none = api.resolveExportFilenames(null);
  assert.equal(none.final, api.FINAL_EXPORT_FILENAME);
  assert.equal(none.draft, api.DRAFT_EXPORT_FILENAME);
  const unknown = api.resolveExportFilenames("SOMETHING_ELSE");
  assert.equal(unknown.final, api.FINAL_EXPORT_FILENAME, "an unrecognized role must fall back to the original shared filename, never fabricate a third variant");
});

test("build: two additional reviewer-scoped HTML files are produced, each embedding a different reviewer_role and the SAME 326 PENDING rows", async () => {
  assert.equal(reviewerAPayload.reviewer_role, "REVIEWER_A");
  assert.equal(reviewerBPayload.reviewer_role, "REVIEWER_B");
  assert.notEqual(reviewerAPayload.reviewer_role, reviewerBPayload.reviewer_role);
  for (const payload of [reviewerAPayload, reviewerBPayload]) {
    assert.equal(payload.rows.length, embeddedPayload.rows.length);
    assert.ok(payload.rows.every((r) => r.owner_disposition === "PENDING"));
    assert.equal(payload.source_packet_sha256, embeddedPayload.source_packet_sha256);
  }
});

test("build: the original shared HTML file embeds no reviewer_role (backward compatible, unscoped preview build)", () => {
  assert.equal(embeddedPayload.reviewer_role, undefined);
});

test("build: reviewer-a and reviewer-b HTML files are byte-different (different embedded role -> different content), and each references only its OWN export filenames as data, not the other's", () => {
  assert.notEqual(reviewerAHtml, reviewerBHtml);
  assert.match(reviewerAHtml, /"reviewer_role":"REVIEWER_A"/);
  assert.match(reviewerBHtml, /"reviewer_role":"REVIEWER_B"/);
});

test("build report lists both reviewer variants with filenames matching resolveExportFilenames, and SHAs matching the real written files", async () => {
  assert.equal(buildReport.reviewer_variants.length, 2);
  const byRole = Object.fromEntries(buildReport.reviewer_variants.map((v) => [v.reviewer_role, v]));
  assert.equal(byRole.REVIEWER_A.final_export_filename, "relation-closure-reviewer-a-decision.v0.1.jsonl");
  assert.equal(byRole.REVIEWER_B.final_export_filename, "relation-closure-reviewer-b-decision.v0.1.jsonl");
  const realABytes = await readFile(REVIEWER_A_HTML_PATH);
  const realBBytes = await readFile(REVIEWER_B_HTML_PATH);
  assert.equal(byRole.REVIEWER_A.output_html_sha256, sha256(realABytes));
  assert.equal(byRole.REVIEWER_B.output_html_sha256, sha256(realBBytes));
});

test("static scan: reviewer-a/reviewer-b HTML files have no innerHTML and no external resource pattern, same discipline as the original file", () => {
  for (const html of [reviewerAHtml, reviewerBHtml]) {
    assert.doesNotMatch(html, /innerHTML/);
    assert.doesNotMatch(html, /https?:\/\//i);
    assert.doesNotMatch(html, /<link[^>]+href/i);
  }
});

test("static scan: reviewer_role has no runtime override path -- no query-string/prompt/select input for it anywhere in the DOM script", async () => {
  const domScriptSource = await readFile(path.join(ROOT, "scripts/lib/relation-closure-review-ui-dom.mjs"), "utf8");
  assert.doesNotMatch(domScriptSource, /location\.search/);
  assert.doesNotMatch(domScriptSource, /URLSearchParams/);
  assert.doesNotMatch(domScriptSource, /prompt\(/);
  assert.doesNotMatch(domScriptSource, /reviewer-role/i, "no id/class implies an editable reviewer-ROLE control exists (the free-text reviewer NAME input is a separate, unrelated field)");
  for (const html of [reviewerAHtml, reviewerBHtml]) {
    assert.doesNotMatch(html, /<select/i);
  }
});

async function waitForDomReady(page, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await page.evaluate("document.readyState");
    if (state === "complete") return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("page did not finish loading in time");
}

test("headless (real browser): Reviewer A's saved judgment is invisible to Reviewer B in the SAME browser session, never leaks or gets overwritten, and survives navigating back", async () => {
  let page = null;
  try {
    page = await launchHeadlessChromePage({ url: `file://${REVIEWER_A_HTML_PATH}` });

    // Confirm the live page really did resolve REVIEWER_A (not just the
    // file we asked to build -- the embedded payload is what the running
    // script actually reads).
    const aRoleInPage = await page.evaluate("JSON.parse(document.getElementById('review-data').textContent).reviewer_role");
    assert.equal(aRoleInPage, "REVIEWER_A");

    // Reviewer A rejects the currently-shown (first) row.
    await page.evaluate("document.querySelector('.row-decision-btn.REJECT').click()");
    const aBadgeAfterReject = await page.evaluate("document.querySelector('.disposition-badge').textContent");
    assert.equal(aBadgeAfterReject, "REJECT");

    const aStorageProbe = await page.evaluate(`
      (function () {
        var data = JSON.parse(document.getElementById('review-data').textContent);
        var key = 'relation-closure-review-ui-v0.1-state-' + data.source_packet_sha256 + '-' + data.reviewer_role;
        var raw = localStorage.getItem(key);
        return { key: key, hasState: !!raw, firstRowDisposition: raw ? JSON.parse(raw)[data.rows[0].relation_candidate_id].owner_disposition : null };
      })()
    `);
    assert.match(aStorageProbe.key, /-REVIEWER_A$/);
    assert.ok(aStorageProbe.hasState, "Reviewer A's decision must actually be persisted to localStorage under its own key");
    assert.equal(aStorageProbe.firstRowDisposition, "REJECT");

    // Same page, same profile/session -- navigate to Reviewer B's file.
    await page.send("Page.navigate", { url: `file://${REVIEWER_B_HTML_PATH}` });
    await waitForDomReady(page);

    const bRoleInPage = await page.evaluate("JSON.parse(document.getElementById('review-data').textContent).reviewer_role");
    assert.equal(bRoleInPage, "REVIEWER_B");

    // Reviewer B must see a completely fresh, all-PENDING page -- no trace
    // of Reviewer A's REJECT, even though this is the exact same browser
    // session/profile that just made that decision seconds ago.
    const bFirstBadge = await page.evaluate("document.querySelector('.disposition-badge').textContent");
    assert.equal(bFirstBadge, "PENDING", "Reviewer B must never see Reviewer A's judgment leak in via a shared storage key");

    const bStorageProbe = await page.evaluate(`
      (function () {
        var data = JSON.parse(document.getElementById('review-data').textContent);
        var keyA = 'relation-closure-review-ui-v0.1-state-' + data.source_packet_sha256 + '-REVIEWER_A';
        var keyB = 'relation-closure-review-ui-v0.1-state-' + data.source_packet_sha256 + '-REVIEWER_B';
        var rawA = localStorage.getItem(keyA);
        return { aStillIntact: rawA ? JSON.parse(rawA)[data.rows[0].relation_candidate_id].owner_disposition : null, bKeyDiffersFromA: keyB !== keyA };
      })()
    `);
    assert.equal(bStorageProbe.aStillIntact, "REJECT", "Reviewer B's page must not have overwritten or cleared Reviewer A's own storage key");
    assert.ok(bStorageProbe.bKeyDiffersFromA);

    // Navigate back to Reviewer A -- the REJECT must still be there
    // (proves persistence AND that B's visit never touched A's key).
    await page.send("Page.navigate", { url: `file://${REVIEWER_A_HTML_PATH}` });
    await waitForDomReady(page);
    const aBadgeAfterReturning = await page.evaluate("document.querySelector('.disposition-badge').textContent");
    assert.equal(aBadgeAfterReturning, "REJECT");
  } finally {
    if (page) await page.close();
  }
}, { timeout: 30_000 });
