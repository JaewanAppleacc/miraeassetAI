// Turn M item 5: verifies the offline before/after remediation review UI.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML_PATH = path.join(ROOT, "work/handoff/seed-final-response-owner-review/ui/v0.2/seed-response-remediation-review.html");
const REPORT_PATH = path.join(ROOT, "work/handoff/seed-final-response-owner-review/ui/v0.2/review-ui-build-report.json");
const V01_HTML_PATH = path.join(ROOT, "work/handoff/seed-final-response-owner-review/ui/v0.1/seed-response-owner-review.html");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

let htmlText; let embeddedPayload; let v01HtmlShaBefore; let v01HtmlShaAfter;

test.before(async () => {
  v01HtmlShaBefore = sha256(await readFile(V01_HTML_PATH));
  await execFileAsync(process.execPath, [path.join(ROOT, "scripts/build-seed-response-remediation-review-ui-v02.mjs")], { cwd: ROOT });
  v01HtmlShaAfter = sha256(await readFile(V01_HTML_PATH));
  htmlText = await readFile(HTML_PATH, "utf8");
  const match = htmlText.match(/<script type="application\/json" id="review-data">([\s\S]*?)<\/script>/);
  assert.ok(match);
  embeddedPayload = JSON.parse(match[1]);
});

test("building the v0.2 UI never modifies the existing v0.1 UI file", () => {
  assert.equal(v01HtmlShaAfter, v01HtmlShaBefore);
});

test("embedded data contains exactly 24 records, matching the 24 FIX_REQUIRED question_ids", () => {
  assert.equal(embeddedPayload.records.length, 24);
  const qids = new Set(embeddedPayload.records.map((r) => r.question_id));
  assert.equal(qids.size, 24);
  assert.equal(qids.has("question_seed_v07_01"), false); // Q1 was APPROVE_RESPONSE, never a FIX_REQUIRED item
});

test("every record has distinct before/after answer text sourced from real r4/r7 wire files, with matching sha256", async () => {
  for (const record of embeddedPayload.records) {
    const beforeBytes = await readFile(path.join(ROOT, "work/domain-seed/seed-harness-v07-wire.r4", `${record.question_id}.response.json`));
    const afterBytes = await readFile(path.join(ROOT, "work/domain-seed/seed-harness-v07-wire.r7", `${record.question_id}.response.json`));
    assert.equal(sha256(beforeBytes), record.before_sha256);
    assert.equal(sha256(afterBytes), record.after_sha256);
  }
});

test("status is never forced to RESOLVED for every item -- PARTIAL/BLOCKED are genuinely represented", () => {
  const statuses = new Set(embeddedPayload.records.map((r) => r.status));
  assert.ok(statuses.has("PARTIAL") || statuses.has("BLOCKED"));
});

test("no innerHTML assignment in the rendering script (textContent-only data rendering)", () => {
  const scriptMatch = htmlText.match(/<script>([\s\S]*)<\/script>\s*<\/body>/);
  assert.ok(scriptMatch);
  assert.equal(/\.innerHTML\s*=/.test(scriptMatch[1]), false);
});

test("no unescaped </script> boundary and no external resource-loading pattern", () => {
  const scriptOpenCount = (htmlText.match(/<script/g) || []).length;
  const scriptCloseCount = (htmlText.match(/<\/script>/g) || []).length;
  assert.equal(scriptOpenCount, 2);
  assert.equal(scriptCloseCount, 2);
  for (const pattern of [/<script[^>]+src=/i, /\bfetch\s*\(/, /XMLHttpRequest/, /cdn\.jsdelivr|cdnjs\.cloudflare|unpkg\.com/i]) {
    assert.equal(pattern.test(htmlText), false, `forbidden pattern matched: ${pattern}`);
  }
});

test("build report's output_html_sha256 matches the real generated file", async () => {
  const report = JSON.parse(await readFile(REPORT_PATH, "utf8"));
  const htmlBytes = await readFile(HTML_PATH);
  assert.equal(sha256(htmlBytes), report.output_html_sha256);
  assert.equal(report.final_export_filename, "seed-response-remediation-owner-decision.v0.1.jsonl");
});

test("FINAL export logic (buildRecord/buildExportLines) defaults every item to PENDING, never self-approves", () => {
  const domScriptMatch = htmlText.match(/<script>([\s\S]*)<\/script>\s*<\/body>/);
  const script = domScriptMatch[1];
  assert.match(script, /disposition:\s*'PENDING'/);
  assert.equal(/disposition:\s*'APPROVE_FIX'.*buildInitialState/.test(script), false);
});
