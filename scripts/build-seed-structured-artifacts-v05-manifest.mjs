// Builds: (1) the v0.7 Evidence manifest (219 records = v0.6's 213 + the 6
// new metric-gap-closure records), (2) a merged v0.5 Owner decision
// (v0.4's 82 items + the 6-item batch decision = 88, never overwriting
// either source file), and (3) the new seed-structured-artifacts.v0.5
// manifest -- now including a CHAIN_MANIFEST role (Codex-review finding
// #2) alongside the existing 7 roles, pointing at the new Fact v0.5 /
// Coverage v0.5 / Evidence v0.7 / merged decision v0.5. Event (v0.1) and
// Relation (v0.2) stay byte-identical carryovers. v0.4's structured
// manifest is never modified.
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
  // --- 1. Evidence v0.7 manifest --------------------------------------
  const evidenceV07 = await readJsonlAbs("work/domain-seed/seed-evidence-verified.v0.7.jsonl");
  const v06Manifest = JSON.parse((await readAbs("work/domain-seed/seed-evidence-verified.v0.6.manifest.json")).toString("utf8"));
  const evidenceV07Manifest = {
    schema_version: "0.1.0",
    artifact: "seed-evidence-verified.v0.7.jsonl",
    artifact_sha256: await sha256OfFile("work/domain-seed/seed-evidence-verified.v0.7.jsonl"),
    generated_at: GENERATED_AT,
    corpus_snapshot_id: CORPUS_SNAPSHOT_ID,
    authored_against_manifest_sha256: v06Manifest.authored_against_manifest_sha256,
    supersedes: "work/domain-seed/seed-evidence-verified.v0.6.jsonl",
    supersession_note: "6건 신규 grounding evidence 추가(Q02 equity_ratio_percent, Q04 change_vs_previous_shares, Q05 planned_amount_krw/reference_price_krw, Q10 consolidation_entity_count x2). v0.6의 213건은 전부 그대로 유지.",
    record_count: evidenceV07.length,
    evidence_ids: evidenceV07.map((e) => e.evidence_id).sort(),
  };
  await writeFile(path.join(REPO, "work/domain-seed/seed-evidence-verified.v0.7.manifest.json"), JSON.stringify(evidenceV07Manifest, null, 2) + "\n", "utf8");

  // --- 2. Merged Owner decision v0.5 (88 = 82 + 6) --------------------
  const decisionV04 = await readJsonlAbs("work/domain-seed/seed-structured-owner-decision.v0.4.jsonl");
  const decisionBatch = await readJsonlAbs("work/domain-seed/seed-structured-owner-decision.v0.5-batch.jsonl");
  const decisionV05 = [...decisionV04, ...decisionBatch];
  if (decisionV05.some((d) => d.owner_disposition !== "APPROVE")) throw new Error("merged decision contains a non-APPROVE item");
  await writeFile(path.join(REPO, "work/domain-seed/seed-structured-owner-decision.v0.5.jsonl"), jsonl(decisionV05), "utf8");
  const decisionV05Sha256 = await sha256OfFile("work/domain-seed/seed-structured-owner-decision.v0.5.jsonl");
  const decisionV05Manifest = {
    schema_version: "0.1.0",
    decision_id: "seed-structured-owner-decision-v0.5",
    status: "APPROVED",
    approved_by: "최재완",
    approved_at: GENERATED_AT,
    scope: "88건 = v0.4의 82건(review packet) + v0.5 배치의 6건(Q02/Q04/Q05/Q10 metric-fail 원인 조사 중 식별된 신규 Fact). 두 원본 파일 모두 수정하지 않고 병합만 함.",
    sources: [
      { path: "work/domain-seed/seed-structured-owner-decision.v0.4.jsonl", sha256: await sha256OfFile("work/domain-seed/seed-structured-owner-decision.v0.4.jsonl"), record_count: decisionV04.length },
      { path: "work/domain-seed/seed-structured-owner-decision.v0.5-batch.jsonl", sha256: await sha256OfFile("work/domain-seed/seed-structured-owner-decision.v0.5-batch.jsonl"), record_count: decisionBatch.length },
    ],
    merged_output: { path: "work/domain-seed/seed-structured-owner-decision.v0.5.jsonl", sha256: decisionV05Sha256, record_count: decisionV05.length },
  };
  await writeFile(path.join(REPO, "work/domain-seed/seed-structured-owner-decision.v0.5.manifest.json"), JSON.stringify(decisionV05Manifest, null, 2) + "\n", "utf8");

  // --- 3. New structured manifest v0.5 (+ CHAIN_MANIFEST role) --------
  const factsV05 = await readJsonlAbs("work/domain-seed/seed-facts-verified.v0.5.jsonl");
  const coverageV05 = JSON.parse((await readAbs("work/domain-seed/seed-fact-coverage-verified.v0.5.json")).toString("utf8"));
  const eventsV01 = await readJsonlAbs("work/domain-seed/seed-events-verified.v0.1.jsonl");
  const relationV02 = await readJsonlAbs("work/domain-seed/seed-relation-gold.v0.2.jsonl");
  const chainV02 = await readJsonlAbs("work/domain-seed/seed-chain-manifest.v0.2.jsonl");

  const artifacts = [
    { role: "VERIFIED_EVIDENCE", path: "work/domain-seed/seed-evidence-verified.v0.7.jsonl", sha256: evidenceV07Manifest.artifact_sha256, bytes: (await readAbs("work/domain-seed/seed-evidence-verified.v0.7.jsonl")).length, record_count: evidenceV07.length },
    { role: "VERIFIED_EVIDENCE_MANIFEST", path: "work/domain-seed/seed-evidence-verified.v0.7.manifest.json", sha256: await sha256OfFile("work/domain-seed/seed-evidence-verified.v0.7.manifest.json"), bytes: (await readAbs("work/domain-seed/seed-evidence-verified.v0.7.manifest.json")).length, record_count: null },
    { role: "VERIFIED_EVENT", path: "work/domain-seed/seed-events-verified.v0.1.jsonl", sha256: await sha256OfFile("work/domain-seed/seed-events-verified.v0.1.jsonl"), bytes: (await readAbs("work/domain-seed/seed-events-verified.v0.1.jsonl")).length, record_count: eventsV01.length },
    { role: "VERIFIED_RELATION", path: "work/domain-seed/seed-relation-gold.v0.2.jsonl", sha256: await sha256OfFile("work/domain-seed/seed-relation-gold.v0.2.jsonl"), bytes: (await readAbs("work/domain-seed/seed-relation-gold.v0.2.jsonl")).length, record_count: relationV02.length },
    { role: "CHAIN_MANIFEST", path: "work/domain-seed/seed-chain-manifest.v0.2.jsonl", sha256: await sha256OfFile("work/domain-seed/seed-chain-manifest.v0.2.jsonl"), bytes: (await readAbs("work/domain-seed/seed-chain-manifest.v0.2.jsonl")).length, record_count: chainV02.length },
    { role: "VERIFIED_FACT", path: "work/domain-seed/seed-facts-verified.v0.5.jsonl", sha256: await sha256OfFile("work/domain-seed/seed-facts-verified.v0.5.jsonl"), bytes: (await readAbs("work/domain-seed/seed-facts-verified.v0.5.jsonl")).length, record_count: factsV05.length },
    { role: "FACT_COVERAGE_SNAPSHOT", path: "work/domain-seed/seed-fact-coverage-verified.v0.5.json", sha256: await sha256OfFile("work/domain-seed/seed-fact-coverage-verified.v0.5.json"), bytes: (await readAbs("work/domain-seed/seed-fact-coverage-verified.v0.5.json")).length, record_count: coverageV05.slots.length },
    { role: "OWNER_DECISION", path: "work/domain-seed/seed-structured-owner-decision.v0.5.jsonl", sha256: decisionV05Sha256, bytes: (await readAbs("work/domain-seed/seed-structured-owner-decision.v0.5.jsonl")).length, record_count: decisionV05.length },
  ];

  const structuredManifestV05 = {
    schema_version: "0.1.0",
    artifact_set_id: "seed-structured-artifacts-v0.5",
    status: "VERIFIED_SEED_SUBSET",
    generated_at: GENERATED_AT,
    corpus_snapshot_id: CORPUS_SNAPSHOT_ID,
    fact_coverage_snapshot_id: coverageV05.fact_coverage_snapshot_id,
    semantic_bundle_schema_version: coverageV05.semantic_bundle_schema_version,
    artifacts,
    excluded_question_ids: [],
    release_status: "APPROVED_PENDING_RELEASE_AUTHORIZATION",
    supersedes: "work/domain-seed/seed-structured-artifacts.v0.4.manifest.json",
    supersession_note: "Codex 독립 검수 결함 2건 보완: CHAIN_MANIFEST role 추가(16건) + Thin plan release-authorization 결합을 위한 재생성. Fact/Coverage/Evidence는 Q02/Q04/Q05/Q10 metric-fail 원인 조사로 식별된 6건의 신규 grounding 데이터를 포함.",
  };
  await writeFile(path.join(REPO, "work/domain-seed/seed-structured-artifacts.v0.5.manifest.json"), JSON.stringify(structuredManifestV05, null, 2) + "\n", "utf8");

  console.log(JSON.stringify({
    evidence_v07_manifest_sha256: evidenceV07Manifest.artifact_sha256,
    decision_v05_record_count: decisionV05.length,
    structured_manifest_v05_artifacts: artifacts.length,
    fact_coverage_snapshot_id: structuredManifestV05.fact_coverage_snapshot_id,
  }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
