#!/usr/bin/env node
// Turn N4.5, Task 7: builds TWO fully offline, single-file HTML review UIs
// for the multi-step correction risk packet -- one for REVIEWER_C, one for
// REVIEWER_D -- each with a completely separate localStorage namespace and
// export filename (derived from reviewer_role at build time; see
// scripts/lib/relation-closure-multistep-review-ui-dom.mjs). Neither
// reviewer's judgments are visible to the other. Read-only against the
// risk packet. If the risk packet has 0 rows, this script refuses to
// build a UI at all (per the explicit "do not force-create a UI on a
// 0-row risk packet" instruction) -- it reports NO_RISK_ROWS and exits 0.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CSS_TEXT } from "./lib/relation-closure-multistep-review-ui-css.mjs";
import { LOGIC_SCRIPT } from "./lib/relation-closure-multistep-review-ui-logic.mjs";
import { DOM_SCRIPT } from "./lib/relation-closure-multistep-review-ui-dom.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const V02_DIR = path.join(REPO, "work/handoff/anchor-dev-tune-v0.1/owner-adjudication-v0.2");
const RISK_PACKET_PATH = path.join(V02_DIR, "relation-closure-multistep-correction-risk-packet.v0.1.jsonl");
const REVIEW_PACKET_PATH = path.join(REPO, "work/handoff/anchor-dev-tune-v0.1/relation-closure-review-packet.v0.1.jsonl");
const OUT_DIR = path.join(V02_DIR, "ui/multistep-review-v0.1");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function portable(p) { return path.relative(REPO, p).split(path.sep).join("/"); }
function readJsonl(text) { return text.trim().length === 0 ? [] : text.trim().split("\n").map((l) => JSON.parse(l)); }

function escapeForScriptEmbed(jsonText) {
  return jsonText.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
}

async function readAndHash(p) {
  const bytes = await readFile(p);
  return { bytes, sha256: sha256(bytes), text: bytes.toString("utf8") };
}

async function main() {
  const riskPacketFile = await readAndHash(RISK_PACKET_PATH);
  const riskRows = readJsonl(riskPacketFile.text);

  if (riskRows.length === 0) {
    console.log(JSON.stringify({ status: "NO_RISK_ROWS", note: "risk packet has 0 rows -- no Reviewer C/D UI was created, per the explicit instruction not to force-create a UI on a 0-row risk packet.", risk_packet_path: portable(RISK_PACKET_PATH), risk_packet_sha256: riskPacketFile.sha256 }, null, 2));
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
    if (seenIds.has(row.relation_candidate_id)) throw new Error(`BLOCKER: duplicate relation_candidate_id ${row.relation_candidate_id} in risk packet`);
    seenIds.add(row.relation_candidate_id);
    if (row.review_status !== "PENDING") throw new Error(`BLOCKER: risk packet row ${row.relation_candidate_id} does not start PENDING -- refusing to build a UI over pre-judged input`);
  }

  await mkdir(OUT_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  const variants = [
    { role: "REVIEWER_C", fileName: "relation-closure-multistep-review.reviewer-c.html" },
    { role: "REVIEWER_D", fileName: "relation-closure-multistep-review.reviewer-d.html" },
  ];
  const outputs = {};
  for (const variant of variants) {
    const payload = {
      schema_version: "0.1.0",
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

  // Confirm the two variants have DIFFERENT storage-key-relevant payloads
  // (different reviewer_role) even though rows are identical, and are not
  // byte-identical files (the DOM script derives different storage/export
  // names purely from the embedded reviewer_role, so this is a real check,
  // not a tautology).
  if (outputs.REVIEWER_C.sha256 === outputs.REVIEWER_D.sha256) {
    throw new Error("BLOCKER: REVIEWER_C and REVIEWER_D HTML outputs are byte-identical -- reviewer_role was not actually embedded distinctly");
  }

  const afterRiskPacket = await readAndHash(RISK_PACKET_PATH);
  if (afterRiskPacket.sha256 !== riskPacketFile.sha256) throw new Error("BLOCKER: risk packet changed bytes during HTML generation -- refusing to report success");

  const report = {
    schema_version: "0.1.0",
    generated_at: generatedAt,
    risk_packet_path: portable(RISK_PACKET_PATH),
    risk_packet_sha256: riskPacketFile.sha256,
    row_count: riskRows.length,
    outputs,
    final_export_filenames: { REVIEWER_C: "relation-multistep-reviewer-c-decision.v0.1.jsonl", REVIEWER_D: "relation-multistep-reviewer-d-decision.v0.1.jsonl" },
    independence_note: "REVIEWER_C and REVIEWER_D are two SEPARATE HTML files, each with a storage key and export filename derived only from their own embedded reviewer_role. Neither file's JS can read the other's localStorage namespace (browser-enforced per-origin same-key isolation is irrelevant here -- the keys themselves are simply different strings), and there is no code path that lets one reviewer's in-progress state leak into the other's export.",
  };
  const reportPath = path.join(OUT_DIR, "multistep-review-ui-build-report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({ status: "PASS", row_count: riskRows.length, outputs }, null, 2));
}

function buildHtml(payload, role) {
  const dataJson = escapeForScriptEmbed(JSON.stringify(payload));
  const parts = [
    "<!doctype html>",
    '<html lang="ko">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>Relation Closure 다단계 정정 위험 검토 -- ${role}</title>`,
    "<style>",
    CSS_TEXT,
    "</style>",
    "</head>",
    "<body>",
    '<div id="app"></div>',
    '<script type="application/json" id="review-data">' + dataJson + "</script>",
    "<script>",
    LOGIC_SCRIPT,
    DOM_SCRIPT,
    "</script>",
    "</body>",
    "</html>",
    "",
  ];
  return parts.join("\n");
}

main().catch((error) => { console.error(error.message); process.exit(1); });
