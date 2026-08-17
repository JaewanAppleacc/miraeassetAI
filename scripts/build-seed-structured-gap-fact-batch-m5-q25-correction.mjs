// Turn M5 Section 3B: a NEW corrected Candidate revision for the Q25
// "최종 유보기한" Candidate (fact_f82c1de6278abecc5d72436f), fixing exactly
// what the Owner's FIX_REQUIRED note asked for -- never touching v0.8/
// v0.9. Owner note: raw_label "최종 유보기한" implies an immutable final
// date, but 2030-12-31 is only the latest disclosed reservation deadline
// in the current corpus (not provably unchangeable); value_certainty
// must be PROVISIONAL (the source text itself says "공개될 예정", a future
// plan, not an already-confirmed fact). normalized_value/as_of_date/
// source/evidence are all UNCHANGED (Owner confirmed these were already
// correct).
//
// fact_id is computed via the SAME real ids.fact(corpCode, metricCode,
// asOfDate, scope, sourceDocumentId) contract as every other Candidate in
// this project -- since none of those 5 inputs changed (only raw_label
// and value_certainty changed, neither of which is an ids.fact input),
// the fact_id is IDENTICAL to fact_f82c1de6278abecc5d72436f. Per the
// Owner's explicit Turn M5 instruction, this identical fact_id does NOT
// mean the Turn M4 FIX_REQUIRED decision carries forward -- this is a
// different CONTENT revision and stays PENDING for fresh Owner review.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ids } from "../domain/contracts.mjs";
import { validateFactRecord } from "../domain/adapters/seed-artifact-schema-validators.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CANDIDATES_V08_PATH = path.join(REPO, "work/domain-seed/seed-facts-candidates.v0.8.delta.jsonl");
const EVIDENCE_VERIFIED_PATH = path.join(REPO, "work/domain-seed/seed-evidence-verified.v0.9.jsonl");
const OUT_PATH = path.join(REPO, "work/domain-seed/seed-facts-candidates.v0.10.delta.jsonl");
const OUT_MANIFEST_PATH = path.join(REPO, "work/domain-seed/seed-facts-candidates.v0.10.delta.manifest.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function sha256hex(s) { return createHash("sha256").update(s, "utf8").digest("hex"); }
function jsonl(text) { return text.trim().split("\n").map((l) => JSON.parse(l)); }
function fail(msg) { throw new Error(`Q25_CORRECTION_BLOCKED: ${msg}`); }

const ORIGINAL_FACT_ID = "fact_f82c1de6278abecc5d72436f";
const EVIDENCE_ID = "evidence_e9d54831df04d80560129340";
// Grounded directly against the canonical DocumentIR block for
// exchange_20240702800163::20240702800163.xml::n4, row=2/col=0: the real
// cell label is "3. 유보기한" (no immutability claim in the source text
// itself). Neither Owner-suggested phrasing repeats the raw cell text
// verbatim (both elaborate it with real temporal-role context, matching
// this project's established convention -- e.g. the pre-existing
// "해지 시점 유효 계약금액" Fact) -- "본계약 공시 기준" is chosen because it
// names the REAL document role (the final/definitive contract-confirmation
// disclosure) as read directly from source_document_id's group + prior
// linkage, without redundantly repeating as_of_date's own value in the label.
const NEW_RAW_LABEL = "본계약 공시 기준 유보기한";
const NEW_VALUE_CERTAINTY = "PROVISIONAL";

async function main() {
  const v08Bytes = await readFile(CANDIDATES_V08_PATH);
  const v08Rows = jsonl(v08Bytes.toString("utf8"));
  const original = v08Rows.find((r) => r.fact_id === ORIGINAL_FACT_ID);
  if (!original) fail(`original Candidate ${ORIGINAL_FACT_ID} not found in v0.8`);
  if (original.raw_label !== "최종 유보기한") fail(`original raw_label unexpectedly changed: ${original.raw_label}`);
  if (original.value_certainty !== "CONFIRMED") fail(`original value_certainty unexpectedly changed: ${original.value_certainty}`);

  const evidenceBytes = await readFile(EVIDENCE_VERIFIED_PATH);
  const evidenceRows = jsonl(evidenceBytes.toString("utf8"));
  const evidence = evidenceRows.find((e) => e.evidence_id === EVIDENCE_ID);
  if (!evidence) fail(`evidence ${EVIDENCE_ID} not found`);
  if (evidence.verification_status !== "VERIFIED") fail(`evidence ${EVIDENCE_ID} is not VERIFIED`);
  if (sha256hex(evidence.quoted_text) !== evidence.quote_sha256) fail(`evidence ${EVIDENCE_ID} quote_sha256 mismatch`);
  if (evidence.quoted_text !== original.raw_value_text) fail(`evidence quoted_text (${evidence.quoted_text}) does not match original raw_value_text (${original.raw_value_text})`);

  // Recompute fact_id from the SAME 5 ids.fact inputs as the original --
  // must land on the identical id since none of those 5 fields changed.
  const recomputedFactId = ids.fact(original.corp_code, original.metric_code, original.as_of_date, original.scope, original.source_document_id);
  if (recomputedFactId !== ORIGINAL_FACT_ID) fail(`recomputed fact_id (${recomputedFactId}) does not match original (${ORIGINAL_FACT_ID}) -- ids.fact inputs must be unchanged for this correction`);

  const corrected = {
    ...original,
    raw_label: NEW_RAW_LABEL,
    value_certainty: NEW_VALUE_CERTAINTY,
    attributes: {
      ...original.attributes,
      review_provenance: {
        ...original.attributes.review_provenance,
        owner_disposition: "PENDING",
        turn_m5_correction: {
          corrects_fact_id: ORIGINAL_FACT_ID,
          corrects_from_revision: "v0.8",
          owner_fix_required_decision_path: "work/handoff/seed-final-response-owner-review/results/seed-structured-gap-candidate-owner-decision.v0.2.jsonl",
          owner_fix_required_decision_sha256: null, // filled in below once decision bytes are read
          changed_fields: ["raw_label", "value_certainty"],
          unchanged_fields: ["normalized_value", "as_of_date", "known_at", "valid_from", "source_document_id", "evidence_ids"],
          note: "fact_id is IDENTICAL to the v0.8 original (none of ids.fact's 5 inputs changed) but this is a DIFFERENT content revision -- the prior FIX_REQUIRED decision does not carry forward; this record is fresh PENDING per Turn M5 instruction.",
        },
      },
    },
  };
  const decisionBytes = await readFile(path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-structured-gap-candidate-owner-decision.v0.2.jsonl"));
  corrected.attributes.review_provenance.turn_m5_correction.owner_fix_required_decision_sha256 = sha256(decisionBytes);

  const errors = validateFactRecord(corrected);
  if (errors.length) fail(`corrected fact schema errors: ${errors.join("; ")}`);

  const jsonlText = `${JSON.stringify(corrected)}\n`;
  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, jsonlText, "utf8");
  const manifest = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    artifact: "work/domain-seed/seed-facts-candidates.v0.10.delta.jsonl",
    artifact_sha256: sha256(Buffer.from(jsonlText, "utf8")),
    record_count: 1,
    corrects_fact_id: ORIGINAL_FACT_ID,
    fact_id_unchanged: true,
    content_revision_is_new: true,
    owner_disposition: "PENDING",
    source_v08_path: "work/domain-seed/seed-facts-candidates.v0.8.delta.jsonl",
    source_v08_sha256: sha256(v08Bytes),
    v08_modified_this_turn: false,
  };
  await writeFile(OUT_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ fact_id: corrected.fact_id, raw_label: corrected.raw_label, value_certainty: corrected.value_certainty, owner_disposition: "PENDING" }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
