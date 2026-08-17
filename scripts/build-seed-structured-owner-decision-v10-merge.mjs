// Turn M7 Section 3: a merged, CUMULATIVE structured Owner decision
// revision -- the 88 existing records from seed-structured-owner-
// decision.v0.7.jsonl (READ-ONLY, carried forward byte-identical) plus
// the 14 new Turn M7 promotion records (from seed-structured-owner-
// decision.v0.9-batch.jsonl, produced by promote-seed-fact-batch-v07-
// turn-m7.mjs), for a total of 102 records matching the new 102-slot
// coverage snapshot (seed-fact-coverage-verified.v0.7.json).
//
// Known simplification (documented, not hidden): v0.7.jsonl's 88 rows
// each carry a rich per-row audit trail (claude_recommended_verdict,
// machine_check, prior_approval) authored across earlier Turns. This
// script does NOT fabricate that same audit narrative for the 14 new
// rows -- inventing a "machine_check" trail after the fact would be
// worse than omitting it. The 14 new rows instead carry the fields that
// are ACTUALLY true and independently verifiable: review_item_id,
// slot_key, category, fact_ids, evidence_ids, coverage_slot,
// owner_disposition, reviewer, reviewed_at, notes, and a
// promoted_by_turn/promoted_from_receipt pointer to the real Turn M7
// promotion receipt for anyone who needs the full derivation chain.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const V07_PATH = path.join(REPO, "work/domain-seed/seed-structured-owner-decision.v0.7.jsonl");
const M7_BATCH_PATH = path.join(REPO, "work/domain-seed/seed-structured-owner-decision.v0.9-batch.jsonl");
const PROMOTION_RECEIPT_PATH = path.join(REPO, "work/domain-seed/seed-fact-batch-v07-turn-m7-promotion-receipt.json");
const OUTPUT_FACTS_PATH = path.join(REPO, "work/domain-seed/seed-facts-verified.v0.8.jsonl");
const OUT_PATH = path.join(REPO, "work/domain-seed/seed-structured-owner-decision.v0.10.jsonl");
const OUT_MANIFEST_PATH = path.join(REPO, "work/domain-seed/seed-structured-owner-decision.v0.10.manifest.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function jsonl(text) { return text.trim().split("\n").map((l) => JSON.parse(l)); }
function fail(msg) { throw new Error(`OWNER_DECISION_MERGE_BLOCKED: ${msg}`); }

async function main() {
  const v07Bytes = await readFile(V07_PATH);
  const v07Rows = jsonl(v07Bytes.toString("utf8"));
  if (v07Rows.length !== 88) fail(`expected 88 rows in v0.7, found ${v07Rows.length}`);

  const m7BatchBytes = await readFile(M7_BATCH_PATH);
  const m7BatchRows = jsonl(m7BatchBytes.toString("utf8"));
  if (m7BatchRows.length !== 14) fail(`expected 14 rows in Turn M7 batch, found ${m7BatchRows.length}`);

  const outputFactsRows = jsonl((await readFile(OUTPUT_FACTS_PATH)).toString("utf8"));
  const outputFactsById = new Map(outputFactsRows.map((f) => [f.fact_id, f]));
  const receipt = JSON.parse((await readFile(PROMOTION_RECEIPT_PATH)).toString("utf8"));

  const existingReviewItemIds = new Set(v07Rows.map((r) => r.review_item_id));
  const newRows = m7BatchRows.map((batchItem) => {
    if (existingReviewItemIds.has(batchItem.review_item_id)) fail(`review_item_id collision with existing v0.7 row: ${batchItem.review_item_id}`);
    const fact = outputFactsById.get(batchItem.fact_id);
    if (!fact) fail(`promoted fact ${batchItem.fact_id} not found in output VERIFIED facts`);
    return {
      review_item_id: batchItem.review_item_id,
      slot_key: `${batchItem.metric_code}::${fact.corp_code}::${fact.as_of_date}`,
      category: "TURN_M7_OWNER_APPROVED_PROMOTION",
      artifact_path: batchItem.source_artifact,
      fact_ids: [batchItem.fact_id],
      evidence_ids: [batchItem.evidence_id],
      coverage_slot: {
        metric_code: fact.metric_code,
        corp_code: fact.corp_code,
        period_key: `as_of:${fact.as_of_date}`,
        scope: fact.scope,
        candidate_status: "FACT_VERIFIED_AND_PROMOTED",
        verification_status: "VERIFIED",
        reason_code: null,
      },
      owner_disposition: batchItem.owner_disposition,
      reviewer: batchItem.reviewer,
      reviewed_at: batchItem.reviewed_at,
      notes: `Turn M7 promotion. 근거: work/domain-seed/seed-fact-batch-v07-turn-m7-promotion-receipt.json (promoted_at=${receipt.promoted_at}). 이 행은 v0.7 기존 행들의 claude_recommended_verdict/machine_check/prior_approval 감사 서술을 재현하지 않음 -- 그런 서술을 사후 조작하는 것이 생략하는 것보다 나쁘기 때문. 실제 검증 근거는 Turn M5/M6/M7의 Owner decision 원본과 이 promotion receipt를 직접 참조할 것.`,
      promoted_by_turn: "M7",
      promoted_from_receipt: "work/domain-seed/seed-fact-batch-v07-turn-m7-promotion-receipt.json",
    };
  });

  const mergedRows = [...v07Rows, ...newRows];
  if (mergedRows.length !== 102) fail(`expected 102 merged rows, computed ${mergedRows.length}`);
  const allReviewItemIds = new Set(mergedRows.map((r) => r.review_item_id));
  if (allReviewItemIds.size !== 102) fail(`duplicate review_item_id detected after merge`);

  const jsonlText = mergedRows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await writeFile(OUT_PATH, jsonlText, "utf8");
  const manifest = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    artifact: "work/domain-seed/seed-structured-owner-decision.v0.10.jsonl",
    artifact_sha256: sha256(Buffer.from(jsonlText, "utf8")),
    record_count: mergedRows.length,
    carried_forward_from: { path: "work/domain-seed/seed-structured-owner-decision.v0.7.jsonl", sha256: sha256(v07Bytes), record_count: v07Rows.length, modified: false },
    new_records_this_turn: { count: newRows.length, source: "work/domain-seed/seed-structured-owner-decision.v0.9-batch.jsonl", source_sha256: sha256(m7BatchBytes) },
    schema_simplification_note: "새 14개 행은 v0.7 기존 행의 claude_recommended_verdict/machine_check/prior_approval 서브 오브젝트를 포함하지 않음 (사후 감사 서술 조작 방지) -- coverage_slot/owner_disposition/reviewer/reviewed_at/fact_ids/evidence_ids 등 실제로 검증 가능한 필드만 포함.",
  };
  await writeFile(OUT_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ merged_record_count: mergedRows.length, new_record_count: newRows.length, artifact_sha256: manifest.artifact_sha256 }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
