#!/usr/bin/env node
// Turn N4.4: builds the offline 30-row sample-audit review UI. Validates
// 7 preconditions before writing ANY UI artifact -- on any failure it
// writes an error report instead and exits non-zero, never a partial or
// misleading UI. Reads-only against every input (sample packet, sample
// manifest, comparison ledger, Owner packet, original relation packet) --
// none of them is ever modified, and this script never touches the
// existing Reviewer A/B UI or Owner UI files.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSampleAuditInputs, computeAuditStratumKey } from "../domain/evaluation/relation-closure-integration.mjs";
import { CSS_TEXT } from "./lib/relation-closure-sample-audit-review-ui-css.mjs";
import { LOGIC_SCRIPT } from "./lib/relation-closure-sample-audit-review-ui-logic.mjs";
import { DOM_SCRIPT } from "./lib/relation-closure-sample-audit-review-ui-dom.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER_DIR = path.join(REPO, "work/handoff/anchor-dev-tune-v0.1/owner-adjudication-v0.1");
const SAMPLE_PACKET_PATH = path.join(OWNER_DIR, "relation-closure-sample-audit-packet.v0.1.jsonl");
const SAMPLE_MANIFEST_PATH = path.join(OWNER_DIR, "relation-closure-sample-audit-packet.v0.1.manifest.json");
const LEDGER_PATH = path.join(OWNER_DIR, "relation-closure-comparison-ledger.v0.1.jsonl");
const OWNER_PACKET_PATH = path.join(OWNER_DIR, "relation-closure-owner-adjudication-packet.v0.1.jsonl");
const ORIGINAL_PACKET_PATH = path.join(REPO, "work/handoff/anchor-dev-tune-v0.1/relation-closure-review-packet.v0.1.jsonl");

const OUT_DIR = path.join(OWNER_DIR, "ui/sample-audit-v0.1");
const OUT_HTML_PATH = path.join(OUT_DIR, "relation-closure-sample-audit-review.html");
const OUT_REPORT_PATH = path.join(OUT_DIR, "sample-audit-review-ui-build-report.json");
const OUT_ERROR_REPORT_PATH = path.join(OUT_DIR, "sample-audit-review-ui-input-validation-error.v0.1.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function toPosix(p) { return p.split(path.sep).join("/"); }
function portableRelativeTo(root, target) { return toPosix(path.relative(root, target)); }
function readJsonl(text) { return text.trim().length === 0 ? [] : text.trim().split("\n").map((l) => JSON.parse(l)); }

function escapeForScriptEmbed(jsonText) {
  return jsonText.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
}

async function readAndHash(p) {
  const bytes = await readFile(p);
  return { path: p, bytes, sha256: sha256(bytes), text: bytes.toString("utf8") };
}

async function main() {
  const loaded = {
    samplePacket: await readAndHash(SAMPLE_PACKET_PATH),
    sampleManifest: await readAndHash(SAMPLE_MANIFEST_PATH),
    ledger: await readAndHash(LEDGER_PATH),
    ownerPacket: await readAndHash(OWNER_PACKET_PATH),
    originalPacket: await readAndHash(ORIGINAL_PACKET_PATH),
  };

  const sampleManifest = JSON.parse(loaded.sampleManifest.text);
  const samplePacketRows = readJsonl(loaded.samplePacket.text);
  const ledgerRows = readJsonl(loaded.ledger.text);
  const ownerPacketRows = readJsonl(loaded.ownerPacket.text);
  const originalPacketRows = readJsonl(loaded.originalPacket.text);
  const ownerPacketIds = new Set(ownerPacketRows.map((r) => r.relation_candidate_id));

  const errors = [];
  // Check 6: packet vs manifest SHA must match exactly.
  if (loaded.samplePacket.sha256 !== sampleManifest.output_sha256) {
    errors.push(`sample packet sha256 (${loaded.samplePacket.sha256}) does not match manifest's output_sha256 (${sampleManifest.output_sha256})`);
  }
  // Checks 1-5, via the shared pure validator.
  const inputCheck = validateSampleAuditInputs({ samplePacketRows, ledgerRows, ownerPacketIds });
  errors.push(...inputCheck.errors);

  if (errors.length > 0) {
    await mkdir(OUT_DIR, { recursive: true });
    const errorReport = {
      schema_version: "0.1.0",
      generated_at: new Date().toISOString(),
      status: "INPUT_VALIDATION_FAILED",
      errors,
      inputs: Object.fromEntries(Object.entries(loaded).map(([k, v]) => [k, { path: portableRelativeTo(REPO, v.path), sha256: v.sha256 }])),
      note: "No UI artifact was written. Input files were not modified.",
    };
    await writeFile(OUT_ERROR_REPORT_PATH, `${JSON.stringify(errorReport, null, 2)}\n`, "utf8");
    console.error("BLOCKER (fail-closed): sample-audit input validation failed. See", portableRelativeTo(REPO, OUT_ERROR_REPORT_PATH));
    for (const e of errors) console.error(" -", e);
    process.exit(1);
  }

  console.log("All 7 input-validation checks passed. Proceeding to build the UI.");

  // -- enrichment: join sample rows against the ledger (original/augmented
  // candidate id lists) and the ORIGINAL packet's document metadata index,
  // exactly like the N4.3 Owner UI builder does for consistency. ----------
  const ledgerById = new Map(ledgerRows.map((r) => [r.relation_candidate_id, r]));
  const docInfoById = new Map();
  for (const row of originalPacketRows) {
    if (row.source_info) docInfoById.set(row.source_document_id, { ...row.source_info, report_name: row.source_report_name, receipt_date: row.source_receipt_date });
    for (const c of row.candidates) {
      if (c.target_info) docInfoById.set(c.target_document_id, { ...c.target_info, report_name: c.target_report_name, receipt_date: c.target_receipt_date });
    }
  }
  function lookupDoc(id) { return docInfoById.get(id) ?? null; }

  const packetInfoById = new Map(originalPacketRows.map((r) => [r.relation_candidate_id, {
    corp_code: r.source_info?.corp_code ?? null,
    doc_subtype: r.source_info?.doc_subtype ?? null,
  }]));

  const rows = samplePacketRows.map((sampleRow) => {
    const ledgerRow = ledgerById.get(sampleRow.relation_candidate_id);
    const augmented = ledgerRow.correction_reference_augmented_target_document_ids ?? [];
    const candidates = [
      ...ledgerRow.original_candidate_target_document_ids.map((tid) => ({ target_document_id: tid, target_info: lookupDoc(tid), origin: "ORIGINAL" })),
      ...augmented.map((tid) => ({ target_document_id: tid, target_info: lookupDoc(tid), origin: "CORRECTION_REFERENCE_AUGMENTED" })),
    ];
    const stratumKey = computeAuditStratumKey(ledgerRow, packetInfoById);
    return {
      relation_candidate_id: sampleRow.relation_candidate_id,
      audit_item_id: `sample_audit_item_${sha256(sampleRow.relation_candidate_id).slice(0, 24)}`,
      relation_type: sampleRow.relation_type,
      source_document_id: sampleRow.source_document_id,
      source_info: lookupDoc(sampleRow.source_document_id),
      corp_code: sampleRow.corp_code,
      listed_name: sampleRow.listed_name,
      used_correction_reference: sampleRow.used_correction_reference,
      provisional_disposition: sampleRow.provisional_disposition,
      consensus: sampleRow.consensus,
      reviewer_a: sampleRow.reviewer_a,
      reviewer_b: sampleRow.reviewer_b,
      candidates,
      audit_stratum_key: stratumKey,
    };
  });

  const embeddedPayload = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    sample_packet_path: portableRelativeTo(REPO, SAMPLE_PACKET_PATH),
    sample_packet_sha256: loaded.samplePacket.sha256,
    comparison_ledger_path: portableRelativeTo(REPO, LEDGER_PATH),
    comparison_ledger_sha256: loaded.ledger.sha256,
    rows,
  };

  const html = buildHtml(embeddedPayload);
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_HTML_PATH, html, "utf8");

  // -- re-verify no input was mutated -----------------------------------
  const after = {};
  for (const [key, v] of Object.entries(loaded)) after[key] = sha256(await readFile(v.path));
  const inputsUnchanged = Object.entries(loaded).every(([key, v]) => after[key] === v.sha256);
  if (!inputsUnchanged) throw new Error("BLOCKER: an input file's bytes changed during HTML generation -- refusing to report success");

  const htmlBytes = Buffer.from(html, "utf8");
  const report = {
    schema_version: "0.1.0",
    generated_at: embeddedPayload.generated_at,
    output_html_path: portableRelativeTo(REPO, OUT_HTML_PATH),
    output_html_sha256: sha256(htmlBytes),
    output_html_bytes: htmlBytes.length,
    row_count: rows.length,
    inputs_unchanged: inputsUnchanged,
    final_export_filename: "relation-closure-sample-auditor-decision.v0.1.jsonl",
    summary_export_filename: "relation-closure-sample-audit-summary.v0.1.json",
    scope_note: "This UI is a SAMPLE AUDIT of the 30-row deterministic stratified sample drawn from the 297 low-risk PROVISIONAL rows. It is NOT the 29-row Owner adjudication UI, NOT a Gold answer review UI, and its results never auto-approve or auto-reject the remaining 267 rows. localStorage/export names are a separate namespace from both the Reviewer A/B UI and the Owner UI.",
  };
  await writeFile(OUT_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({ output_html_path: report.output_html_path, output_html_sha256: report.output_html_sha256, row_count: report.row_count }, null, 2));
}

function buildHtml(payload) {
  const dataJson = escapeForScriptEmbed(JSON.stringify(payload));
  const parts = [
    "<!doctype html>",
    '<html lang="ko">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    "<title>Relation Closure 표본감사 (30건)</title>",
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
