#!/usr/bin/env node
// Turn N4.3: builds a fully offline, single-file HTML review UI for the
// 29-row Owner adjudication packet (A/B disagreement, both-NEEDS_MORE_REVIEW,
// or TERMINATES). Reads-only against the packet -- independently re-hashes
// it before AND after generation to prove it was not touched. This is a
// NEW version path/namespace -- it never touches the existing Reviewer A/B
// UI files or their localStorage/export names.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CSS_TEXT } from "./lib/relation-closure-owner-review-ui-css.mjs";
import { LOGIC_SCRIPT } from "./lib/relation-closure-owner-review-ui-logic.mjs";
import { DOM_SCRIPT } from "./lib/relation-closure-owner-review-ui-dom.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER_DIR = path.join(REPO, "work/handoff/anchor-dev-tune-v0.1/owner-adjudication-v0.1");
const OWNER_PACKET_PATH = path.join(OWNER_DIR, "relation-closure-owner-adjudication-packet.v0.1.jsonl");
const GATE_STATUS_PATH = path.join(OWNER_DIR, "relation-closure-gate-status.v0.1.json");
const OUT_DIR = path.join(OWNER_DIR, "ui/v0.1");
const OUT_HTML_PATH = path.join(OUT_DIR, "relation-closure-owner-review.html");
const OUT_REPORT_PATH = path.join(OUT_DIR, "owner-review-ui-build-report.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

// The HTML tokenizer terminates ANY <script> element the instant it sees
// "</script" (case-insensitively), regardless of type.
function escapeForScriptEmbed(jsonText) {
  return jsonText.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
}

async function readAndHash(p) {
  const bytes = await readFile(p);
  return { bytes, sha256: sha256(bytes) };
}

async function main() {
  const before = {
    ownerPacket: await readAndHash(OWNER_PACKET_PATH),
    gateStatus: await readAndHash(GATE_STATUS_PATH),
  };
  const gateStatus = JSON.parse(before.gateStatus.bytes.toString("utf8"));
  if (gateStatus.official_split_eligible !== false || gateStatus.chain_closure_status !== "NOT_FINALIZED") {
    throw new Error("BLOCKER: gate status does not declare official_split_eligible=false / chain_closure_status=NOT_FINALIZED -- refusing to build an Owner review UI over data that no longer claims to be provisional");
  }

  const rows = before.ownerPacket.bytes.toString("utf8").trim().split("\n").filter(Boolean).map((line, i) => {
    try { return JSON.parse(line); } catch (error) { throw new Error(`BLOCKER: owner packet line ${i + 1} is not valid JSON: ${error.message}`); }
  });
  if (rows.length !== 29) throw new Error(`BLOCKER: owner packet row count (${rows.length}) is not 29`);
  const seenIds = new Set();
  for (const row of rows) {
    if (seenIds.has(row.relation_candidate_id)) throw new Error(`BLOCKER: duplicate relation_candidate_id ${row.relation_candidate_id} in owner packet`);
    seenIds.add(row.relation_candidate_id);
    if (row.owner_disposition !== "PENDING") throw new Error(`BLOCKER: owner packet row ${row.relation_candidate_id} does not start PENDING -- refusing to build a UI over pre-judged input`);
  }
  const terminatesCount = rows.filter((r) => r.relation_type === "TERMINATES").length;
  if (terminatesCount !== 16) throw new Error(`BLOCKER: expected 16 TERMINATES rows in the owner packet, found ${terminatesCount}`);

  const embeddedPayload = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    source_owner_packet_path: path.relative(REPO, OWNER_PACKET_PATH).split(path.sep).join("/"),
    source_owner_packet_sha256: before.ownerPacket.sha256,
    rows,
  };

  const html = buildHtml(embeddedPayload);
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_HTML_PATH, html, "utf8");

  const after = {
    ownerPacket: await readAndHash(OWNER_PACKET_PATH),
    gateStatus: await readAndHash(GATE_STATUS_PATH),
  };
  const inputsUnchanged = before.ownerPacket.sha256 === after.ownerPacket.sha256 && before.gateStatus.sha256 === after.gateStatus.sha256;
  if (!inputsUnchanged) throw new Error("BLOCKER: an input file's bytes changed during HTML generation -- refusing to report success");

  const htmlBytes = Buffer.from(html, "utf8");
  const report = {
    schema_version: "0.1.0",
    generated_at: embeddedPayload.generated_at,
    output_html_path: path.relative(REPO, OUT_HTML_PATH).split(path.sep).join("/"),
    output_html_sha256: sha256(htmlBytes),
    output_html_bytes: htmlBytes.length,
    row_count: rows.length,
    terminates_count: terminatesCount,
    inputs: {
      source_owner_packet_path: embeddedPayload.source_owner_packet_path,
      source_owner_packet_sha256_before: before.ownerPacket.sha256, source_owner_packet_sha256_after: after.ownerPacket.sha256,
    },
    inputs_unchanged: inputsUnchanged,
    final_export_filename: "relation-closure-owner-decision.v0.1.jsonl",
    scope_note: "This UI is the Owner's FINAL adjudication of the 29-row union (A/B disagreement, both NEEDS_MORE_REVIEW, or TERMINATES). It is NOT a Gold answer review UI, does not perform chain closure, and its localStorage/export names are a separate namespace from the Reviewer A/B UI -- see STORAGE_KEY in scripts/lib/relation-closure-owner-review-ui-dom.mjs.",
  };
  await writeFile(OUT_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({ output_html_path: report.output_html_path, output_html_sha256: report.output_html_sha256, row_count: report.row_count, terminates_count: terminatesCount }, null, 2));
}

function buildHtml(payload) {
  const dataJson = escapeForScriptEmbed(JSON.stringify(payload));
  const parts = [
    "<!doctype html>",
    '<html lang="ko">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    "<title>Relation Closure Owner 최종 판정 (29건)</title>",
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
