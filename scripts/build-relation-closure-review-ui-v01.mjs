#!/usr/bin/env node
// Turn N4.1: builds a fully offline, single-file HTML review UI for the
// relation closure review packet (AMENDS/TERMINATES candidate relations --
// NOT Gold answers). Reads-only against the packet -- independently
// re-hashes it before AND after generation to prove it was not touched.
// Output is two brand-new files under work/handoff/anchor-dev-tune-v0.1/ui/v0.1/.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CSS_TEXT } from "./lib/relation-closure-review-ui-css.mjs";
import { LOGIC_SCRIPT } from "./lib/relation-closure-review-ui-logic.mjs";
import { DOM_SCRIPT } from "./lib/relation-closure-review-ui-dom.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKET_DIR = path.join(REPO, "work/handoff/anchor-dev-tune-v0.1");
const PACKET_PATH = path.join(PACKET_DIR, "relation-closure-review-packet.v0.1.jsonl");
const ANCHOR_MANIFEST_PATH = path.join(PACKET_DIR, "anchor-selection.v0.1.manifest.json");
const OUT_DIR = path.join(PACKET_DIR, "ui/v0.1");
const OUT_HTML_PATH = path.join(OUT_DIR, "relation-closure-review.html");
const OUT_REPORT_PATH = path.join(OUT_DIR, "review-ui-build-report.json");
// Turn N4.2: two additional, reviewer-scoped entry points -- each is a
// self-contained HTML file with reviewer_role baked into the embedded
// payload at BUILD time (never chosen at runtime), so Reviewer A and
// Reviewer B get physically separate files/localStorage partitions/export
// filenames and can never see or overwrite each other's judgments, even if
// both happen to use the same browser profile. The original shared
// OUT_HTML_PATH above is unchanged and still built, for quick audit/preview
// use without any judging identity attached.
const REVIEWER_VARIANTS = [
  { role: "REVIEWER_A", htmlPath: path.join(OUT_DIR, "relation-closure-review.reviewer-a.html") },
  { role: "REVIEWER_B", htmlPath: path.join(OUT_DIR, "relation-closure-review.reviewer-b.html") },
];

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

// The HTML tokenizer terminates ANY <script> element the instant it sees
// "</script" (case-insensitively), regardless of type -- so this must be
// escaped even though application/json content is never executed.
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
    anchorManifest: await readAndHash(ANCHOR_MANIFEST_PATH),
  };
  const anchorManifest = JSON.parse(before.anchorManifest.bytes.toString("utf8"));
  if (before.packet.sha256 !== anchorManifest.relation_closure_review_packet_sha256) {
    throw new Error(`BLOCKER: packet sha256 (${before.packet.sha256}) does not match anchor manifest's relation_closure_review_packet_sha256 (${anchorManifest.relation_closure_review_packet_sha256})`);
  }
  if (anchorManifest.official_split_eligible !== false || anchorManifest.chain_closure_required !== true) {
    throw new Error("BLOCKER: anchor manifest does not declare official_split_eligible=false / chain_closure_required=true -- refusing to build a review UI over data that no longer claims to be provisional");
  }

  const rows = before.packet.bytes.toString("utf8").trim().split("\n").filter(Boolean).map((line, i) => {
    try { return JSON.parse(line); } catch (error) { throw new Error(`BLOCKER: packet line ${i + 1} is not valid JSON: ${error.message}`); }
  });
  if (rows.length !== anchorManifest.relation_closure_total_count) {
    throw new Error(`BLOCKER: packet row count (${rows.length}) does not match anchor manifest's relation_closure_total_count (${anchorManifest.relation_closure_total_count})`);
  }
  const seenIds = new Set();
  for (const row of rows) {
    if (seenIds.has(row.relation_candidate_id)) throw new Error(`BLOCKER: duplicate relation_candidate_id ${row.relation_candidate_id} in packet`);
    seenIds.add(row.relation_candidate_id);
    if (row.owner_disposition !== "PENDING") throw new Error(`BLOCKER: packet row ${row.relation_candidate_id} does not start PENDING -- refusing to build a UI over pre-judged input`);
  }

  const embeddedPayload = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    source_packet_path: path.relative(REPO, PACKET_PATH).split(path.sep).join("/"),
    source_packet_sha256: before.packet.sha256,
    source_anchor_manifest_path: path.relative(REPO, ANCHOR_MANIFEST_PATH).split(path.sep).join("/"),
    source_anchor_manifest_sha256: before.anchorManifest.sha256,
    rows,
  };

  const html = buildHtml(embeddedPayload);
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_HTML_PATH, html, "utf8");

  const reviewerOutputs = [];
  for (const variant of REVIEWER_VARIANTS) {
    const variantPayload = { ...embeddedPayload, reviewer_role: variant.role };
    const variantHtml = buildHtml(variantPayload);
    await writeFile(variant.htmlPath, variantHtml, "utf8");
    const variantBytes = Buffer.from(variantHtml, "utf8");
    reviewerOutputs.push({
      reviewer_role: variant.role,
      output_html_path: path.relative(REPO, variant.htmlPath).split(path.sep).join("/"),
      output_html_sha256: sha256(variantBytes),
      final_export_filename: variant.role === "REVIEWER_A" ? "relation-closure-reviewer-a-decision.v0.1.jsonl" : "relation-closure-reviewer-b-decision.v0.1.jsonl",
      draft_export_filename: variant.role === "REVIEWER_A" ? "relation-closure-reviewer-a-decision-draft.jsonl" : "relation-closure-reviewer-b-decision-draft.jsonl",
    });
  }

  const after = {
    packet: await readAndHash(PACKET_PATH),
    anchorManifest: await readAndHash(ANCHOR_MANIFEST_PATH),
  };
  const inputsUnchanged = before.packet.sha256 === after.packet.sha256 && before.anchorManifest.sha256 === after.anchorManifest.sha256;
  if (!inputsUnchanged) throw new Error("BLOCKER: an input file's bytes changed during HTML generation -- refusing to report success");

  const htmlBytes = Buffer.from(html, "utf8");
  const report = {
    schema_version: "0.2.0",
    generated_at: embeddedPayload.generated_at,
    output_html_path: path.relative(REPO, OUT_HTML_PATH).split(path.sep).join("/"),
    output_html_sha256: sha256(htmlBytes),
    output_html_bytes: htmlBytes.length,
    row_count: rows.length,
    hop0_count: rows.filter((r) => r.hop === 0).length,
    hop1_count: rows.filter((r) => r.hop === 1).length,
    inputs: {
      source_packet_path: embeddedPayload.source_packet_path,
      source_packet_sha256_before: before.packet.sha256, source_packet_sha256_after: after.packet.sha256,
      source_anchor_manifest_path: embeddedPayload.source_anchor_manifest_path,
      source_anchor_manifest_sha256_before: before.anchorManifest.sha256, source_anchor_manifest_sha256_after: after.anchorManifest.sha256,
    },
    inputs_unchanged: inputsUnchanged,
    final_export_filename: "relation-closure-owner-decision.v0.1.jsonl",
    scope_note: "This UI reviews AMENDS/TERMINATES relation candidates. It is NOT a Gold answer review UI -- it writes no expected_answer, Evidence locator, or Fact/Event/Relation data.",
    // Turn N4.2: independent double-review entry points. Each reviewer
    // variant embeds a DIFFERENT reviewer_role at build time, giving each
    // its own localStorage partition and export filenames -- see
    // scripts/lib/relation-closure-review-ui-dom.mjs's STORAGE_KEY/
    // ROLE_FINAL_EXPORT_FILENAME derivation.
    reviewer_variants: reviewerOutputs,
  };
  await writeFile(OUT_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    output_html_path: report.output_html_path, output_html_sha256: report.output_html_sha256, row_count: report.row_count,
    reviewer_variants: reviewerOutputs,
  }, null, 2));
}

function buildHtml(payload) {
  const dataJson = escapeForScriptEmbed(JSON.stringify(payload));
  const parts = [
    "<!doctype html>",
    '<html lang="ko">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    "<title>Relation Closure 검수 (AMENDS/TERMINATES 후보)" + (payload.reviewer_role ? " -- " + payload.reviewer_role : "") + "</title>",
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
