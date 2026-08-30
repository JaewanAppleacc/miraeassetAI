#!/usr/bin/env node
// Turn N4.5.1, Task 5: builds a fully offline, single-file HTML review UI
// for the 30-row Owner adjudication packet v0.3 (the existing 29-row v0.1
// union plus the 1 audit-conflict row, now re-verified directly against
// real DocumentIR). Independently re-hashes the EXISTING v0.1/v0.2 HTML
// files before AND after generation to prove this build never touches
// them. New version path/namespace.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CSS_TEXT } from "./lib/relation-closure-owner-review-ui-css.mjs";
import { LOGIC_SCRIPT } from "./lib/relation-closure-owner-review-ui-v03-logic.mjs";
import { DOM_SCRIPT } from "./lib/relation-closure-owner-review-ui-v03-dom.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const V01_DIR = path.join(REPO, "work/handoff/anchor-dev-tune-v0.1/owner-adjudication-v0.1");
const V02_DIR = path.join(REPO, "work/handoff/anchor-dev-tune-v0.1/owner-adjudication-v0.2");
const V03_DIR = path.join(REPO, "work/handoff/anchor-dev-tune-v0.1/owner-adjudication-v0.3");
const OWNER_PACKET_V03_PATH = path.join(V03_DIR, "relation-closure-owner-adjudication-packet.v0.3.jsonl");
const V01_HTML_PATH = path.join(V01_DIR, "ui/v0.1/relation-closure-owner-review.html");
const V02_HTML_PATH = path.join(V02_DIR, "ui/v0.2/relation-closure-owner-review.html");
const OUT_DIR = path.join(V03_DIR, "ui/v0.3");
const OUT_HTML_PATH = path.join(OUT_DIR, "relation-closure-owner-review.html");
const OUT_REPORT_PATH = path.join(OUT_DIR, "owner-review-ui-build-report.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function escapeForScriptEmbed(jsonText) { return jsonText.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--"); }
async function readAndHash(p) { const bytes = await readFile(p); return { bytes, sha256: sha256(bytes) }; }

async function main() {
  const before = {
    ownerPacket: await readAndHash(OWNER_PACKET_V03_PATH),
    v01Html: await readAndHash(V01_HTML_PATH),
    v02Html: await readAndHash(V02_HTML_PATH),
  };

  const rows = before.ownerPacket.bytes.toString("utf8").trim().split("\n").filter(Boolean).map((line, i) => {
    try { return JSON.parse(line); } catch (error) { throw new Error(`BLOCKER: owner packet v0.3 line ${i + 1} is not valid JSON: ${error.message}`); }
  });
  if (rows.length !== 30) throw new Error(`BLOCKER: owner packet v0.3 row count (${rows.length}) is not 30`);
  const seenIds = new Set();
  for (const row of rows) {
    if (seenIds.has(row.relation_candidate_id)) throw new Error(`BLOCKER: duplicate relation_candidate_id ${row.relation_candidate_id} in owner packet v0.3`);
    seenIds.add(row.relation_candidate_id);
    if (row.owner_disposition !== "PENDING") throw new Error(`BLOCKER: owner packet v0.3 row ${row.relation_candidate_id} does not start PENDING`);
  }
  const conflictRows = rows.filter((r) => (r.owner_review_reason || []).indexOf("AUDIT_CONFLICT") !== -1);
  if (conflictRows.length !== 1) throw new Error(`BLOCKER: expected exactly 1 AUDIT_CONFLICT row, found ${conflictRows.length}`);
  if (!conflictRows[0].documentir_reverification || !Array.isArray(conflictRows[0].documentir_reverification.continuity_signals) || conflictRows[0].documentir_reverification.continuity_signals.length === 0) {
    throw new Error("BLOCKER: the AUDIT_CONFLICT row does not carry a real documentir_reverification.continuity_signals array -- refusing to build a UI that cannot show real DocumentIR evidence");
  }

  const embeddedPayload = {
    schema_version: "0.3.0",
    generated_at: new Date().toISOString(),
    source_owner_packet_path: path.relative(REPO, OWNER_PACKET_V03_PATH).split(path.sep).join("/"),
    source_owner_packet_sha256: before.ownerPacket.sha256,
    rows,
  };

  const html = buildHtml(embeddedPayload);
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_HTML_PATH, html, "utf8");

  const after = {
    ownerPacket: await readAndHash(OWNER_PACKET_V03_PATH),
    v01Html: await readAndHash(V01_HTML_PATH),
    v02Html: await readAndHash(V02_HTML_PATH),
  };
  const inputsUnchanged = before.ownerPacket.sha256 === after.ownerPacket.sha256;
  const v01Unchanged = before.v01Html.sha256 === after.v01Html.sha256;
  const v02Unchanged = before.v02Html.sha256 === after.v02Html.sha256;
  if (!inputsUnchanged) throw new Error("BLOCKER: owner packet v0.3 changed bytes during HTML generation");
  if (!v01Unchanged) throw new Error("BLOCKER: the existing v0.1 Owner review HTML changed during this v0.3 build");
  if (!v02Unchanged) throw new Error("BLOCKER: the existing v0.2 Owner review HTML changed during this v0.3 build");

  const htmlBytes = Buffer.from(html, "utf8");
  const report = {
    schema_version: "0.1.0",
    generated_at: embeddedPayload.generated_at,
    output_html_path: path.relative(REPO, OUT_HTML_PATH).split(path.sep).join("/"),
    output_html_sha256: sha256(htmlBytes),
    output_html_bytes: htmlBytes.length,
    row_count: rows.length,
    audit_conflict_count: conflictRows.length,
    v01_html_unchanged: v01Unchanged,
    v02_html_unchanged: v02Unchanged,
    final_export_filename: "relation-closure-owner-decision.v0.3.jsonl",
    scope_note: "This UI is the Owner's FINAL adjudication of the 30-row v0.3 union. The audit-conflict row now carries a REAL DocumentIR re-verification (continuity/identity signals with node_id locators), superseding N4.5's auditor-notes-only packet. Not a Gold answer review UI, does not perform chain closure, and its localStorage/export names are a separate namespace from v0.1, v0.2, and the sample-audit UI.",
  };
  await writeFile(OUT_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({ output_html_path: report.output_html_path, output_html_sha256: report.output_html_sha256, row_count: report.row_count, v01_html_unchanged: v01Unchanged, v02_html_unchanged: v02Unchanged }, null, 2));
}

function buildHtml(payload) {
  const dataJson = escapeForScriptEmbed(JSON.stringify(payload));
  return [
    "<!doctype html>",
    '<html lang="ko">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    "<title>Relation Closure Owner 최종 판정 v0.3 (30건 -- DocumentIR 재검증)</title>",
    "<style>", CSS_TEXT, "</style>",
    "</head>",
    "<body>",
    '<div id="app"></div>',
    '<script type="application/json" id="review-data">' + dataJson + "</script>",
    "<script>", LOGIC_SCRIPT, DOM_SCRIPT, "</script>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

main().catch((error) => { console.error(error.message); process.exit(1); });
