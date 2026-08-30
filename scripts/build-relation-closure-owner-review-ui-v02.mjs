#!/usr/bin/env node
// Turn N4.5, Task 4: builds a fully offline, single-file HTML review UI
// for the 30-row Owner adjudication packet v0.2 (the existing 29-row v0.1
// union plus the 1 audit-conflict row from the dual sample-audit
// reconciliation). Reads-only against the v0.2 packet -- independently
// re-hashes the EXISTING v0.1 HTML file before AND after generation to
// prove this build never touches it. New version path/namespace -- never
// touches the v0.1 Owner UI or the sample-audit UI's files/localStorage.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CSS_TEXT } from "./lib/relation-closure-owner-review-ui-css.mjs";
import { LOGIC_SCRIPT } from "./lib/relation-closure-owner-review-ui-v02-logic.mjs";
import { DOM_SCRIPT } from "./lib/relation-closure-owner-review-ui-v02-dom.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const V01_DIR = path.join(REPO, "work/handoff/anchor-dev-tune-v0.1/owner-adjudication-v0.1");
const V02_DIR = path.join(REPO, "work/handoff/anchor-dev-tune-v0.1/owner-adjudication-v0.2");
const OWNER_PACKET_V02_PATH = path.join(V02_DIR, "relation-closure-owner-adjudication-packet.v0.2.jsonl");
const GATE_STATUS_V02_PATH = path.join(V02_DIR, "relation-closure-gate-status.v0.2.json");
const V01_HTML_PATH = path.join(V01_DIR, "ui/v0.1/relation-closure-owner-review.html");
const OUT_DIR = path.join(V02_DIR, "ui/v0.2");
const OUT_HTML_PATH = path.join(OUT_DIR, "relation-closure-owner-review.html");
const OUT_REPORT_PATH = path.join(OUT_DIR, "owner-review-ui-build-report.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function escapeForScriptEmbed(jsonText) {
  return jsonText.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
}

async function readAndHash(p) {
  const bytes = await readFile(p);
  return { bytes, sha256: sha256(bytes) };
}

async function main() {
  const before = {
    ownerPacket: await readAndHash(OWNER_PACKET_V02_PATH),
    gateStatus: await readAndHash(GATE_STATUS_V02_PATH),
    v01Html: await readAndHash(V01_HTML_PATH),
  };
  const gateStatus = JSON.parse(before.gateStatus.bytes.toString("utf8"));
  if (gateStatus.official_split_eligible !== false || gateStatus.chain_closure_status !== "NOT_FINALIZED") {
    throw new Error("BLOCKER: gate status v0.2 does not declare official_split_eligible=false / chain_closure_status=NOT_FINALIZED -- refusing to build an Owner review UI over data that no longer claims to be provisional");
  }

  const rows = before.ownerPacket.bytes.toString("utf8").trim().split("\n").filter(Boolean).map((line, i) => {
    try { return JSON.parse(line); } catch (error) { throw new Error(`BLOCKER: owner packet v0.2 line ${i + 1} is not valid JSON: ${error.message}`); }
  });
  if (rows.length !== 30) throw new Error(`BLOCKER: owner packet v0.2 row count (${rows.length}) is not 30`);
  const seenIds = new Set();
  for (const row of rows) {
    if (seenIds.has(row.relation_candidate_id)) throw new Error(`BLOCKER: duplicate relation_candidate_id ${row.relation_candidate_id} in owner packet v0.2`);
    seenIds.add(row.relation_candidate_id);
    if (row.owner_disposition !== "PENDING") throw new Error(`BLOCKER: owner packet v0.2 row ${row.relation_candidate_id} does not start PENDING -- refusing to build a UI over pre-judged input`);
  }
  const terminatesCount = rows.filter((r) => r.relation_type === "TERMINATES").length;
  if (terminatesCount !== 16) throw new Error(`BLOCKER: expected 16 TERMINATES rows in the owner packet v0.2, found ${terminatesCount}`);
  const auditConflictCount = rows.filter((r) => (r.owner_review_reason || []).indexOf("AUDIT_CONFLICT") !== -1).length;
  if (auditConflictCount !== 1) throw new Error(`BLOCKER: expected exactly 1 AUDIT_CONFLICT row in the owner packet v0.2, found ${auditConflictCount}`);

  const embeddedPayload = {
    schema_version: "0.2.0",
    generated_at: new Date().toISOString(),
    source_owner_packet_path: path.relative(REPO, OWNER_PACKET_V02_PATH).split(path.sep).join("/"),
    source_owner_packet_sha256: before.ownerPacket.sha256,
    rows,
  };

  const html = buildHtml(embeddedPayload);
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_HTML_PATH, html, "utf8");

  const after = {
    ownerPacket: await readAndHash(OWNER_PACKET_V02_PATH),
    gateStatus: await readAndHash(GATE_STATUS_V02_PATH),
    v01Html: await readAndHash(V01_HTML_PATH),
  };
  const inputsUnchanged = before.ownerPacket.sha256 === after.ownerPacket.sha256 && before.gateStatus.sha256 === after.gateStatus.sha256;
  const v01Unchanged = before.v01Html.sha256 === after.v01Html.sha256;
  if (!inputsUnchanged) throw new Error("BLOCKER: an input file's bytes changed during HTML generation -- refusing to report success");
  if (!v01Unchanged) throw new Error("BLOCKER: the existing v0.1 Owner review HTML file changed bytes during this v0.2 build -- refusing to report success");

  const htmlBytes = Buffer.from(html, "utf8");
  const report = {
    schema_version: "0.1.0",
    generated_at: embeddedPayload.generated_at,
    output_html_path: path.relative(REPO, OUT_HTML_PATH).split(path.sep).join("/"),
    output_html_sha256: sha256(htmlBytes),
    output_html_bytes: htmlBytes.length,
    row_count: rows.length,
    terminates_count: terminatesCount,
    audit_conflict_count: auditConflictCount,
    inputs: {
      source_owner_packet_path: embeddedPayload.source_owner_packet_path,
      source_owner_packet_sha256_before: before.ownerPacket.sha256, source_owner_packet_sha256_after: after.ownerPacket.sha256,
    },
    inputs_unchanged: inputsUnchanged,
    v01_html_unchanged: v01Unchanged,
    v01_html_sha256_before: before.v01Html.sha256, v01_html_sha256_after: after.v01Html.sha256,
    final_export_filename: "relation-closure-owner-decision.v0.2.jsonl",
    scope_note: "This UI is the Owner's FINAL adjudication of the 30-row v0.2 union (the existing 29-row v0.1 union plus the 1 audit-conflict row). It is NOT a Gold answer review UI, does not perform chain closure, and its localStorage/export names are a separate namespace from BOTH the v0.1 Owner UI and the sample-audit UI -- see STORAGE_KEY in scripts/lib/relation-closure-owner-review-ui-v02-dom.mjs.",
  };
  await writeFile(OUT_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({ output_html_path: report.output_html_path, output_html_sha256: report.output_html_sha256, row_count: report.row_count, terminates_count: terminatesCount, audit_conflict_count: auditConflictCount, v01_html_unchanged: v01Unchanged }, null, 2));
}

function buildHtml(payload) {
  const dataJson = escapeForScriptEmbed(JSON.stringify(payload));
  const parts = [
    "<!doctype html>",
    '<html lang="ko">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    "<title>Relation Closure Owner 최종 판정 v0.2 (30건)</title>",
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
