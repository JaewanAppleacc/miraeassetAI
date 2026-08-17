// Builds a fully offline, single-file HTML review UI so the Owner can
// judge the latest synthesized answers (seed-response-review-packet.v0.6)
// without reading JSONL directly. Reads-only against the packet/manifest/
// wire inputs -- never writes to them, and independently re-hashes them
// before AND after generation to prove they were not touched by this
// build. Output is two brand-new files under
// work/handoff/seed-final-response-owner-review/ui/v0.1/ -- nothing
// existing is modified.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CSS_TEXT } from "./lib/seed-response-owner-review-ui-css.mjs";
import { LOGIC_SCRIPT } from "./lib/seed-response-owner-review-ui-logic.mjs";
import { DOM_SCRIPT } from "./lib/seed-response-owner-review-ui-dom.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKET_PATH = path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-response-review-packet.v0.6.jsonl");
const MANIFEST_PATH = path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-response-review-packet.v0.6.manifest.json");
const WIRE_DIR = path.join(REPO, "work/domain-seed/seed-harness-v07-wire.r4");
const WIRE_INDEX_PATH = path.join(WIRE_DIR, "index.json");
const OUT_DIR = path.join(REPO, "work/handoff/seed-final-response-owner-review/ui/v0.1");
const OUT_HTML_PATH = path.join(OUT_DIR, "seed-response-owner-review.html");
const OUT_REPORT_PATH = path.join(OUT_DIR, "review-ui-build-report.json");

const DETAILED_QUESTION_IDS = [
  "question_seed_v07_13", "question_seed_v07_16", "question_seed_v07_17",
  "question_seed_v07_19", "question_seed_v07_21", "question_seed_v07_22",
];

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

// Escapes a JSON string for safe embedding inside a <script type="application/json">
// element: the HTML tokenizer terminates ANY <script> element the instant
// it sees the literal byte sequence "</script" (case-insensitively),
// regardless of the script's type attribute -- so this must be escaped
// even though the browser never executes application/json content. "<!--"
// is escaped too as defense-in-depth against any HTML-comment-based
// parsing quirk in an unusual embedder.
function escapeForScriptEmbed(jsonText) {
  return jsonText.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
}

async function readAndHash(p) {
  const bytes = await readFile(p);
  return { bytes, sha256: sha256(bytes) };
}

async function main() {
  const before = {
    packet: await readAndHash(PACKET_PATH),
    manifest: await readAndHash(MANIFEST_PATH),
    wireIndex: await readAndHash(WIRE_INDEX_PATH),
  };

  const manifest = JSON.parse(before.manifest.bytes.toString("utf8"));
  if (before.packet.sha256 !== manifest.artifact_sha256) {
    throw new Error(`BLOCKER: packet sha256 (${before.packet.sha256}) does not match manifest.artifact_sha256 (${manifest.artifact_sha256})`);
  }
  const wireIndex = JSON.parse(before.wireIndex.bytes.toString("utf8"));
  if (before.wireIndex.sha256 !== manifest.source_wire_revision.wire_index_sha256) {
    throw new Error("BLOCKER: wire index sha256 does not match manifest.source_wire_revision.wire_index_sha256");
  }
  if (manifest.total_questions !== 25 || manifest.detailed_review_count !== 6 || manifest.sentence_quality_count !== 19) {
    throw new Error(`BLOCKER: manifest question-count assertions failed (total=${manifest.total_questions}, detailed=${manifest.detailed_review_count}, sentence_quality=${manifest.sentence_quality_count})`);
  }

  const packetLines = before.packet.bytes.toString("utf8").trim().split("\n").map((line, i) => {
    try { return JSON.parse(line); } catch (error) { throw new Error(`BLOCKER: packet line ${i + 1} is not valid JSON: ${error.message}`); }
  });
  if (packetLines.length !== 25) throw new Error(`BLOCKER: expected 25 packet records, found ${packetLines.length}`);
  const seenQids = new Set();
  for (const record of packetLines) {
    if (seenQids.has(record.question_id)) throw new Error(`BLOCKER: duplicate question_id ${record.question_id} in packet`);
    seenQids.add(record.question_id);
  }
  const detailedInPacket = packetLines.filter((r) => r.review_tier === "DETAILED").map((r) => r.question_id).sort();
  const expectedDetailed = [...DETAILED_QUESTION_IDS].sort();
  if (JSON.stringify(detailedInPacket) !== JSON.stringify(expectedDetailed)) {
    throw new Error(`BLOCKER: DETAILED question_id set mismatch. Packet: ${JSON.stringify(detailedInPacket)}, expected: ${JSON.stringify(expectedDetailed)}`);
  }

  const wireByQid = new Map(wireIndex.entries.map((e) => [e.question_id, e]));

  const records = [];
  for (const packetRecord of packetLines) {
    const wireEntry = wireByQid.get(packetRecord.question_id);
    if (!wireEntry) throw new Error(`BLOCKER: no wire entry for ${packetRecord.question_id}`);
    const wireAbsPath = path.join(REPO, wireEntry.path);
    const wireBytes = await readFile(wireAbsPath);
    const actualWireSha = sha256(wireBytes);
    if (actualWireSha !== wireEntry.raw_sha256) {
      throw new Error(`BLOCKER: wire file ${wireEntry.path} sha256 mismatch (actual ${actualWireSha}, index-declared ${wireEntry.raw_sha256})`);
    }
    const wire = JSON.parse(wireBytes.toString("utf8"));
    const retrievedContext = typeof wire.retrieved_context === "string" ? JSON.parse(wire.retrieved_context) : wire.retrieved_context;
    const thinkTrace = typeof wire.think_trace === "string" ? JSON.parse(wire.think_trace) : wire.think_trace;

    records.push({
      question_id: packetRecord.question_id,
      review_tier: packetRecord.review_tier,
      question: packetRecord.question,
      answer: packetRecord.answer,
      applied_capabilities: packetRecord.applied_capabilities ?? [],
      missing_capabilities: packetRecord.missing_capabilities ?? [],
      qualifier_scope: packetRecord.qualifier_scope ?? null,
      synthesis_status: packetRecord.synthesis_status ?? null,
      review_required_metric_names: packetRecord.review_required_metric_names ?? [],
      packet_note: packetRecord.note ?? null,
      retrieved_context: retrievedContext,
      think_trace: thinkTrace,
      source_wire_path: wireEntry.path,
      source_wire_sha256: wireEntry.raw_sha256,
    });
  }

  const embeddedPayload = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    source_packet_path: path.relative(REPO, PACKET_PATH),
    source_packet_sha256: before.packet.sha256,
    source_packet_manifest_path: path.relative(REPO, MANIFEST_PATH),
    source_packet_manifest_sha256: before.manifest.sha256,
    source_wire_index_path: path.relative(REPO, WIRE_INDEX_PATH),
    source_wire_index_sha256: before.wireIndex.sha256,
    detailed_question_ids: DETAILED_QUESTION_IDS,
    records,
  };

  const html = buildHtml(embeddedPayload);
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_HTML_PATH, html, "utf8");

  const after = {
    packet: await readAndHash(PACKET_PATH),
    manifest: await readAndHash(MANIFEST_PATH),
    wireIndex: await readAndHash(WIRE_INDEX_PATH),
  };
  const inputsUnchanged =
    before.packet.sha256 === after.packet.sha256 &&
    before.manifest.sha256 === after.manifest.sha256 &&
    before.wireIndex.sha256 === after.wireIndex.sha256;
  if (!inputsUnchanged) {
    throw new Error("BLOCKER: an input file's bytes changed during HTML generation -- refusing to report success");
  }

  const htmlBytes = Buffer.from(html, "utf8");
  const report = {
    schema_version: "0.1.0",
    generated_at: embeddedPayload.generated_at,
    output_html_path: path.relative(REPO, OUT_HTML_PATH),
    output_html_sha256: sha256(htmlBytes),
    output_html_bytes: htmlBytes.length,
    record_count: records.length,
    detailed_review_count: records.filter((r) => r.review_tier === "DETAILED").length,
    sentence_quality_count: records.filter((r) => r.review_tier === "SENTENCE_QUALITY").length,
    inputs: {
      source_packet_path: embeddedPayload.source_packet_path,
      source_packet_sha256_before: before.packet.sha256,
      source_packet_sha256_after: after.packet.sha256,
      source_packet_manifest_path: embeddedPayload.source_packet_manifest_path,
      source_packet_manifest_sha256_before: before.manifest.sha256,
      source_packet_manifest_sha256_after: after.manifest.sha256,
      source_wire_index_path: embeddedPayload.source_wire_index_path,
      source_wire_index_sha256_before: before.wireIndex.sha256,
      source_wire_index_sha256_after: after.wireIndex.sha256,
    },
    inputs_unchanged: inputsUnchanged,
    final_export_filename: "seed-response-owner-decision.v0.7.jsonl",
  };
  await writeFile(OUT_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({ output_html_path: report.output_html_path, output_html_sha256: report.output_html_sha256, record_count: report.record_count }, null, 2));
}

function buildHtml(payload) {
  const dataJson = escapeForScriptEmbed(JSON.stringify(payload));
  const parts = [
    "<!doctype html>",
    '<html lang="ko">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    "<title>Seed 최신 합성 답변 Owner 검수</title>",
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
