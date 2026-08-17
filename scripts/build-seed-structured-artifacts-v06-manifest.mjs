// Builds: (1) the v0.9 Evidence manifest (219 records = v0.6's 213 + the 6
// period-fixed metric-gap-closure records promoted via
// scripts/promote-seed-fact-batch-v06.mjs against a real, externally
// authored Owner decision -- see work/domain-seed/seed-structured-owner-
// decision.v0.7-batch.decision.jsonl), (2) a merged v0.7 Owner decision
// (v0.4's 82 items + the v0.7-batch 6-item decision = 88, never
// overwriting either source file), and (3) the new
// seed-structured-artifacts.v0.6 manifest -- pointing at the new
// Fact v0.7 / Coverage v0.6 / Evidence v0.9 / merged decision v0.7. Event
// (v0.1), Relation (v0.2), and Chain (v0.2) stay byte-identical carryovers.
// v0.5's structured manifest (built from the self-approved v0.5-batch
// decision -- see domain/releases/seed-release.v0.17.BLOCKED.audit-report.json)
// is never modified.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED_AT = new Date().toISOString();
const CORPUS_SNAPSHOT_ID = "corpus_04750795e1a2d5c3";

function sha256(buffer) { return createHash("sha256").update(buffer).digest("hex"); }
async function readAbs(p) { return readFile(path.join(REPO, p)); }
async function sha256OfFile(p) { return sha256(await readAbs(p)); }
async function readJsonlAbs(p) { return (await readAbs(p)).toString("utf8").trim().split("\n").map(JSON.parse); }
function jsonl(records) { return records.map((r) => JSON.stringify(r)).join("\n") + "\n"; }

async function main() {
  // --- 1. Evidence v0.9 manifest --------------------------------------
  const evidenceV09 = await readJsonlAbs("work/domain-seed/seed-evidence-verified.v0.9.jsonl");
  const v06Manifest = JSON.parse((await readAbs("work/domain-seed/seed-evidence-verified.v0.6.manifest.json")).toString("utf8"));
  const evidenceV09Manifest = {
    schema_version: "0.1.0",
    artifact: "seed-evidence-verified.v0.9.jsonl",
    artifact_sha256: await sha256OfFile("work/domain-seed/seed-evidence-verified.v0.9.jsonl"),
    generated_at: GENERATED_AT,
    corpus_snapshot_id: CORPUS_SNAPSHOT_ID,
    authored_against_manifest_sha256: v06Manifest.authored_against_manifest_sha256,
    supersedes: "work/domain-seed/seed-evidence-verified.v0.6.jsonl",
    supersession_note: "6건 신규 grounding evidence 추가(Q02 equity_ratio_percent, Q04 change_vs_previous_shares, Q05 planned_amount_krw/reference_price_krw, Q10 consolidation_entity_count x2, period-semantics 수정판). v0.6의 213건은 전부 그대로 유지. v0.7(자동 승인 결함, 폐기)은 이 계보에 포함되지 않음.",
    record_count: evidenceV09.length,
    evidence_ids: evidenceV09.map((e) => e.evidence_id).sort(),
  };
  await writeFile(path.join(REPO, "work/domain-seed/seed-evidence-verified.v0.9.manifest.json"), JSON.stringify(evidenceV09Manifest, null, 2) + "\n", "utf8");

  // --- 2. Merged Owner decision v0.7 (88 = 82 + 6) --------------------
  const decisionV04 = await readJsonlAbs("work/domain-seed/seed-structured-owner-decision.v0.4.jsonl");
  const decisionBatch = await readJsonlAbs("work/domain-seed/seed-structured-owner-decision.v0.7-batch.decision.jsonl");
  if (decisionBatch.length !== 6) throw new Error(`expected exactly 6 items in the v0.7-batch decision, found ${decisionBatch.length}`);
  const decisionV07 = [...decisionV04, ...decisionBatch];
  if (decisionV07.some((d) => d.owner_disposition !== "APPROVE")) throw new Error("merged decision contains a non-APPROVE item");
  await writeFile(path.join(REPO, "work/domain-seed/seed-structured-owner-decision.v0.7.jsonl"), jsonl(decisionV07), "utf8");
  const decisionV07Sha256 = await sha256OfFile("work/domain-seed/seed-structured-owner-decision.v0.7.jsonl");
  const decisionV07Manifest = {
    schema_version: "0.1.0",
    decision_id: "seed-structured-owner-decision-v0.7",
    status: "APPROVED",
    approved_by: "최재완",
    approved_at: GENERATED_AT,
    scope: "88건 = v0.4의 82건(review packet) + v0.7-batch 6건(Q02/Q04/Q05/Q10, period-semantics 수정판; Owner 최재완이 work/domain-seed/seed-structured-owner-decision.v0.7-batch.decision.jsonl로 직접 승인). 두 원본 파일 모두 수정하지 않고 병합만 함. 자동 승인 결함이 있던 v0.5-batch/v0.5는 이 계보에 포함되지 않음.",
    sources: [
      { path: "work/domain-seed/seed-structured-owner-decision.v0.4.jsonl", sha256: await sha256OfFile("work/domain-seed/seed-structured-owner-decision.v0.4.jsonl"), record_count: decisionV04.length },
      { path: "work/domain-seed/seed-structured-owner-decision.v0.7-batch.decision.jsonl", sha256: await sha256OfFile("work/domain-seed/seed-structured-owner-decision.v0.7-batch.decision.jsonl"), record_count: decisionBatch.length },
    ],
    merged_output: { path: "work/domain-seed/seed-structured-owner-decision.v0.7.jsonl", sha256: decisionV07Sha256, record_count: decisionV07.length },
  };
  await writeFile(path.join(REPO, "work/domain-seed/seed-structured-owner-decision.v0.7.manifest.json"), JSON.stringify(decisionV07Manifest, null, 2) + "\n", "utf8");

  // --- 3. New structured manifest v0.6 --------------------------------
  const factsV07 = await readJsonlAbs("work/domain-seed/seed-facts-verified.v0.7.jsonl");
  const coverageV06 = JSON.parse((await readAbs("work/domain-seed/seed-fact-coverage-verified.v0.6.json")).toString("utf8"));
  const eventsV01 = await readJsonlAbs("work/domain-seed/seed-events-verified.v0.1.jsonl");
  const relationV02 = await readJsonlAbs("work/domain-seed/seed-relation-gold.v0.2.jsonl");
  const chainV02 = await readJsonlAbs("work/domain-seed/seed-chain-manifest.v0.2.jsonl");

  const artifacts = [
    { role: "VERIFIED_EVIDENCE", path: "work/domain-seed/seed-evidence-verified.v0.9.jsonl", sha256: evidenceV09Manifest.artifact_sha256, bytes: (await readAbs("work/domain-seed/seed-evidence-verified.v0.9.jsonl")).length, record_count: evidenceV09.length },
    { role: "VERIFIED_EVIDENCE_MANIFEST", path: "work/domain-seed/seed-evidence-verified.v0.9.manifest.json", sha256: await sha256OfFile("work/domain-seed/seed-evidence-verified.v0.9.manifest.json"), bytes: (await readAbs("work/domain-seed/seed-evidence-verified.v0.9.manifest.json")).length, record_count: null },
    { role: "VERIFIED_EVENT", path: "work/domain-seed/seed-events-verified.v0.1.jsonl", sha256: await sha256OfFile("work/domain-seed/seed-events-verified.v0.1.jsonl"), bytes: (await readAbs("work/domain-seed/seed-events-verified.v0.1.jsonl")).length, record_count: eventsV01.length },
    { role: "VERIFIED_RELATION", path: "work/domain-seed/seed-relation-gold.v0.2.jsonl", sha256: await sha256OfFile("work/domain-seed/seed-relation-gold.v0.2.jsonl"), bytes: (await readAbs("work/domain-seed/seed-relation-gold.v0.2.jsonl")).length, record_count: relationV02.length },
    { role: "CHAIN_MANIFEST", path: "work/domain-seed/seed-chain-manifest.v0.2.jsonl", sha256: await sha256OfFile("work/domain-seed/seed-chain-manifest.v0.2.jsonl"), bytes: (await readAbs("work/domain-seed/seed-chain-manifest.v0.2.jsonl")).length, record_count: chainV02.length },
    { role: "VERIFIED_FACT", path: "work/domain-seed/seed-facts-verified.v0.7.jsonl", sha256: await sha256OfFile("work/domain-seed/seed-facts-verified.v0.7.jsonl"), bytes: (await readAbs("work/domain-seed/seed-facts-verified.v0.7.jsonl")).length, record_count: factsV07.length },
    { role: "FACT_COVERAGE_SNAPSHOT", path: "work/domain-seed/seed-fact-coverage-verified.v0.6.json", sha256: await sha256OfFile("work/domain-seed/seed-fact-coverage-verified.v0.6.json"), bytes: (await readAbs("work/domain-seed/seed-fact-coverage-verified.v0.6.json")).length, record_count: coverageV06.slots.length },
    { role: "OWNER_DECISION", path: "work/domain-seed/seed-structured-owner-decision.v0.7.jsonl", sha256: decisionV07Sha256, bytes: (await readAbs("work/domain-seed/seed-structured-owner-decision.v0.7.jsonl")).length, record_count: decisionV07.length },
  ];

  const structuredManifestV06 = {
    schema_version: "0.1.0",
    artifact_set_id: "seed-structured-artifacts-v0.6",
    status: "VERIFIED_SEED_SUBSET",
    generated_at: GENERATED_AT,
    corpus_snapshot_id: CORPUS_SNAPSHOT_ID,
    fact_coverage_snapshot_id: coverageV06.fact_coverage_snapshot_id,
    semantic_bundle_schema_version: coverageV06.semantic_bundle_schema_version,
    artifacts,
    excluded_question_ids: [],
    release_status: "APPROVED_PENDING_RELEASE_AUTHORIZATION",
    supersedes: "work/domain-seed/seed-structured-artifacts.v0.4.manifest.json",
    supersession_note: "v0.17 감사(domain/releases/seed-release.v0.17.BLOCKED.audit-report.json)에서 지적된 자동 self-approval 결함을 실제 Owner 승인으로 대체. Q10 두 Fact의 기간 의미 결함(CUMULATIVE -> POINT_IN_TIME, as_of_date/known_at 분리)도 함께 수정됨. v0.5(자동 승인, 폐기)는 이 계보에 포함되지 않고 감사 이력으로 그대로 보존됨.",
  };
  await writeFile(path.join(REPO, "work/domain-seed/seed-structured-artifacts.v0.6.manifest.json"), JSON.stringify(structuredManifestV06, null, 2) + "\n", "utf8");

  console.log(JSON.stringify({
    evidence_v09_manifest_sha256: evidenceV09Manifest.artifact_sha256,
    decision_v07_record_count: decisionV07.length,
    structured_manifest_v06_artifacts: artifacts.length,
    fact_coverage_snapshot_id: structuredManifestV06.fact_coverage_snapshot_id,
  }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
