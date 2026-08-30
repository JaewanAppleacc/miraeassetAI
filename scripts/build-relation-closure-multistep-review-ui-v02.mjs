#!/usr/bin/env node
// Turn N4.5.1, Task 9: builds TWO fully offline, single-file HTML review
// UIs for the v0.2 (real-DocumentIR-grounded) multi-step correction risk
// packet -- one for REVIEWER_C, one for REVIEWER_D -- each with a
// completely separate localStorage namespace and export filename. Neither
// reviewer's judgments are visible to the other. The existing N4.5 116-row
// v0.1 UI is never modified. If the v0.2 risk packet has 0 rows, this
// script refuses to build a UI at all and reports NO_RISK_ROWS.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CSS_TEXT } from "./lib/relation-closure-multistep-review-ui-css.mjs";
import { LOGIC_SCRIPT } from "./lib/relation-closure-multistep-review-ui-v02-logic.mjs";
import { DOM_SCRIPT } from "./lib/relation-closure-multistep-review-ui-v02-dom.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RISK_V02_DIR = path.join(REPO, "work/handoff/anchor-dev-tune-v0.1/owner-adjudication-v0.3/multistep-risk-v0.2");
const RISK_PACKET_PATH = path.join(RISK_V02_DIR, "relation-closure-multistep-correction-risk-packet.v0.2.jsonl");
const REVIEW_PACKET_PATH = path.join(REPO, "work/handoff/anchor-dev-tune-v0.1/relation-closure-review-packet.v0.1.jsonl");
const OUT_DIR = path.join(RISK_V02_DIR, "ui");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function portable(p) { return path.relative(REPO, p).split(path.sep).join("/"); }
function readJsonl(text) { return text.trim().length === 0 ? [] : text.trim().split("\n").map((l) => JSON.parse(l)); }
function escapeForScriptEmbed(jsonText) { return jsonText.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--"); }
async function readAndHash(p) { const bytes = await readFile(p); return { bytes, sha256: sha256(bytes), text: bytes.toString("utf8") }; }

async function main() {
  const riskPacketFile = await readAndHash(RISK_PACKET_PATH);
  const riskRows = readJsonl(riskPacketFile.text);

  if (riskRows.length === 0) {
    console.log(JSON.stringify({ status: "NO_RISK_ROWS", note: "v0.2 risk packet has 0 rows -- no Reviewer C/D UI was created.", risk_packet_path: portable(RISK_PACKET_PATH), risk_packet_sha256: riskPacketFile.sha256 }, null, 2));
    return;
  }

  const reviewPacketFile = await readAndHash(REVIEW_PACKET_PATH);
  const reviewPacketRows = readJsonl(reviewPacketFile.text);
  const docInfoById = new Map();
  for (const row of reviewPacketRows) {
    if (row.source_info) docInfoById.set(row.source_document_id, { ...row.source_info, report_name: row.source_report_name, receipt_date: row.source_receipt_date });
    for (const c of row.candidates ?? []) {
      if (c.target_info) docInfoById.set(c.target_document_id, { ...c.target_info, report_name: c.target_report_name, receipt_date: c.target_receipt_date });
    }
  }

  const seenIds = new Set();
  for (const row of riskRows) {
    if (seenIds.has(row.relation_candidate_id)) throw new Error(`BLOCKER: duplicate relation_candidate_id ${row.relation_candidate_id} in v0.2 risk packet`);
    seenIds.add(row.relation_candidate_id);
    if (row.review_status !== "PENDING") throw new Error(`BLOCKER: risk packet row ${row.relation_candidate_id} does not start PENDING`);
    if (!Array.isArray(row.candidate_evaluations) || row.candidate_evaluations.length === 0) throw new Error(`BLOCKER: risk row ${row.relation_candidate_id} has no candidate_evaluations -- refusing to build a UI with nothing to confirm against`);
  }

  await mkdir(OUT_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  const variants = [
    { role: "REVIEWER_C", fileName: "relation-closure-multistep-review.reviewer-c.v0.2.html" },
    { role: "REVIEWER_D", fileName: "relation-closure-multistep-review.reviewer-d.v0.2.html" },
  ];
  const outputs = {};
  for (const variant of variants) {
    const payload = {
      schema_version: "0.2.0",
      generated_at: generatedAt,
      source_risk_packet_path: portable(RISK_PACKET_PATH),
      source_risk_packet_sha256: riskPacketFile.sha256,
      reviewer_role: variant.role,
      rows: riskRows,
      doc_info_by_id: Object.fromEntries(docInfoById),
    };
    const html = buildHtml(payload, variant.role);
    const outPath = path.join(OUT_DIR, variant.fileName);
    await writeFile(outPath, html, "utf8");
    outputs[variant.role] = { path: portable(outPath), sha256: sha256(Buffer.from(html, "utf8")), bytes: Buffer.byteLength(html, "utf8") };
  }

  if (outputs.REVIEWER_C.sha256 === outputs.REVIEWER_D.sha256) {
    throw new Error("BLOCKER: REVIEWER_C and REVIEWER_D HTML outputs are byte-identical");
  }
  const afterRiskPacket = await readAndHash(RISK_PACKET_PATH);
  if (afterRiskPacket.sha256 !== riskPacketFile.sha256) throw new Error("BLOCKER: risk packet changed bytes during HTML generation");

  const report = {
    schema_version: "0.1.0",
    generated_at: generatedAt,
    risk_packet_path: portable(RISK_PACKET_PATH),
    risk_packet_sha256: riskPacketFile.sha256,
    row_count: riskRows.length,
    outputs,
    final_export_filenames: { REVIEWER_C: "relation-multistep-reviewer-c-decision.v0.2.jsonl", REVIEWER_D: "relation-multistep-reviewer-d-decision.v0.2.jsonl" },
    independence_note: "REVIEWER_C and REVIEWER_D are two SEPARATE HTML files with storage keys and export filenames derived only from their own embedded reviewer_role. Neither can read the other's localStorage namespace or export the other's judgments. This is a v0.2 namespace, fully separate from N4.5's v0.1 116-row UI (owner-adjudication-v0.2/ui/multistep-review-v0.1/), which is preserved unmodified as audit history.",
  };
  const reportPath = path.join(OUT_DIR, "multistep-review-ui-v02-build-report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({ status: "PASS", row_count: riskRows.length, outputs }, null, 2));
}

function buildHtml(payload, role) {
  const dataJson = escapeForScriptEmbed(JSON.stringify(payload));
  return [
    "<!doctype html>",
    '<html lang="ko">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>Relation Closure 다단계 정정 위험 검토 v0.2 -- ${role}</title>`,
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
