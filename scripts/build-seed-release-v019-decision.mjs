// Builds the v0.19 APPROVED release bundle: a re-authorization of the
// EXACT SAME underlying data v0.18 already used (structured manifest v0.6
// unchanged: Fact v0.7 / Evidence v0.9 / Coverage v0.6 / Gold v0.17 / Plan
// v0.6 / Chain v0.2, and the same real Owner batch decision
// work/domain-seed/seed-structured-owner-decision.v0.7-batch.decision.jsonl)
// -- v0.18's canonical manifest/decision are never modified; only a new
// canonical release manifest + JSON decision artifact are minted.
//
// What actually changed for v0.19: domain/adapters/seed-runtime-service-
// adapters.mjs now ACTUALLY reads and validates decision.owner_batch_decision
// (assertOwnerBatchDecisionBinding) instead of merely carrying it as a
// decorative field only tests/seed-release-v018.test.mjs happened to check
// separately. v0.18's own owner_batch_decision was already correct -- this
// release exists to record, at the release-authorization layer, that the
// binding is now genuinely load-bearing at the real Runtime construction
// boundary, not just in a standalone test. No Fact/Evidence/Coverage/Gold/
// Plan/Chain data changes; no new Facts or Thin Flow templates were added
// to move Seed scores.
//
// This script does NOT claim the Release Gate is fully open: Q07/Q21/Q24
// metric_fail and the 17 REVIEW_REQUIRED items remain open and are
// explicitly NOT marked resolved anywhere in this manifest/decision -- see
// release_gate_status below and domain/releases/seed-release.v0.18.RELEASE_GATE_STATUS.json
// (unchanged, still accurate for v0.19 since the underlying data is
// identical).
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalManifestBindingHash, createSeedRuntimeServiceAdapters } from "../domain/adapters/seed-runtime-service-adapters.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APPROVED_AT = new Date().toISOString();
const APPROVED_BY = "최재완";
const CORPUS_SNAPSHOT_ID = "corpus_04750795e1a2d5c3";

const CANONICAL_OUT = "domain/releases/seed-release.v0.19.manifest.json";
const DECISION_OUT = "domain/releases/seed-release.v0.19.decision.json";
const STRUCTURED_MANIFEST = "work/domain-seed/seed-structured-artifacts.v0.6.manifest.json";
const PLAN_PATH = "work/domain-seed/seed-thin-flow-plans.v0.6.jsonl";
const PLAN_MANIFEST_PATH = "work/domain-seed/seed-thin-flow-plans.v0.6.manifest.json";
const OWNER_BATCH_DECISION_PATH = "work/domain-seed/seed-structured-owner-decision.v0.7-batch.decision.jsonl";

function sha256(buffer) { return createHash("sha256").update(buffer).digest("hex"); }
async function readAbs(p) { return readFile(path.join(REPO, p)); }
async function sha256OfFile(p) { return sha256(await readAbs(p)); }
async function readJsonAbs(p) { return JSON.parse((await readAbs(p)).toString("utf8")); }
async function readJsonlAbs(p) { return (await readAbs(p)).toString("utf8").trim().split("\n").map(JSON.parse); }
function pinArtifacts(artifacts) { return artifacts.map((a) => ({ role: a.role, path: a.path, sha256: a.sha256, record_count: a.record_count ?? null })); }

async function main() {
  const structuredManifest = await readJsonAbs(STRUCTURED_MANIFEST);
  if (structuredManifest.status !== "VERIFIED_SEED_SUBSET") throw new Error("structured manifest is not VERIFIED_SEED_SUBSET");
  if (structuredManifest.excluded_question_ids.length !== 0) throw new Error("structured manifest still excludes questions");
  const chainRole = structuredManifest.artifacts.find((a) => a.role === "CHAIN_MANIFEST");
  if (!chainRole) throw new Error("structured manifest is missing CHAIN_MANIFEST");

  const ownerBatchDecision = await readJsonlAbs(OWNER_BATCH_DECISION_PATH);
  if (ownerBatchDecision.length !== 6) throw new Error(`expected 6 items in owner batch decision, found ${ownerBatchDecision.length}`);
  if (ownerBatchDecision.some((d) => d.owner_disposition !== "APPROVE")) throw new Error("owner batch decision contains a non-APPROVE item");
  if (ownerBatchDecision.some((d) => typeof d.reviewer !== "string" || d.reviewer === "")) throw new Error("owner batch decision has an item with no reviewer");
  const ownerDecisionRole = structuredManifest.artifacts.find((a) => a.role === "OWNER_DECISION");
  if (!ownerDecisionRole) throw new Error("structured manifest is missing OWNER_DECISION");
  const mergedDecision = await readJsonlAbs(ownerDecisionRole.path);
  if (mergedDecision.length !== 88) throw new Error(`expected merged OWNER_DECISION to carry 88 items, found ${mergedDecision.length}`);

  const planManifest = await readJsonAbs(PLAN_MANIFEST_PATH);
  if (planManifest.record_count !== 25) throw new Error(`expected 25 plan records, found ${planManifest.record_count}`);
  const planBytes = await readAbs(PLAN_PATH);
  const planRecordCount = planBytes.toString("utf8").trim().split("\n").length;
  if (planRecordCount !== 25) throw new Error(`plan file line count ${planRecordCount} != 25`);

  const canonicalDocIrBase = "work/domain-seed/seed-canonical-document-ir.v0.6.jsonl";
  const canonicalDocIrDelta = "work/domain-seed/seed-canonical-document-ir.v0.15.delta.jsonl";
  const goldPath = "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl";
  const coveragePath = "work/domain-seed/seed-fact-coverage-verified.v0.6.json";

  if (planManifest.source_gold !== goldPath) throw new Error(`plan manifest source_gold (${planManifest.source_gold}) != expected (${goldPath})`);
  if (planManifest.source_coverage !== coveragePath) throw new Error(`plan manifest source_coverage (${planManifest.source_coverage}) != expected (${coveragePath})`);
  if (planManifest.corpus_snapshot_id !== structuredManifest.corpus_snapshot_id) throw new Error("plan manifest corpus_snapshot_id mismatch");
  if (planManifest.fact_coverage_snapshot_id !== structuredManifest.fact_coverage_snapshot_id) throw new Error("plan manifest fact_coverage_snapshot_id mismatch");

  const canonicalArtifactsBase = [
    { role: "CANONICAL_DOCUMENT_IR_BASE", path: canonicalDocIrBase, sha256: await sha256OfFile(canonicalDocIrBase), bytes: (await readAbs(canonicalDocIrBase)).length, record_count: 54 },
    { role: "CANONICAL_DOCUMENT_IR_DELTA", path: canonicalDocIrDelta, sha256: await sha256OfFile(canonicalDocIrDelta), bytes: (await readAbs(canonicalDocIrDelta)).length, record_count: 14 },
    { role: "SEED_GOLD", path: goldPath, sha256: await sha256OfFile(goldPath), bytes: (await readAbs(goldPath)).length, record_count: 25 },
  ];

  const canonicalBase = {
    schema_version: "0.1.0",
    release_id: "seed-release-v0.19",
    release_status: "APPROVED",
    corpus_snapshot_id: CORPUS_SNAPSHOT_ID,
    artifacts: canonicalArtifactsBase,
    approved_revision: structuredManifest.artifact_set_id,
    supersedes: "domain/releases/seed-release.v0.18.manifest.json",
    supersession_note:
      "v0.18의 데이터(Fact v0.7/Evidence v0.9/Coverage v0.6/Gold v0.17/Plan v0.6/Chain v0.2)를 그대로 재사용하는 순수 재승인 revision. "
      + "v0.18 자체는 수정하지 않고 감사 이력으로 보존. 변경된 것은 domain/adapters/seed-runtime-service-adapters.mjs 하나뿐: "
      + "decision.owner_batch_decision을 실제 Runtime release-authorization 경계(assertOwnerBatchDecisionBinding)가 이제 직접 읽고 검증한다 "
      + "(path 안전성/SHA-256/JSONL 파싱/record_count/중복 ID/전원 APPROVE/reviewer=approved_by 일치/reviewed_at 유효성/all_approve 재계산, "
      + "그리고 promoted VERIFIED Fact·Evidence 및 structured manifest의 merged OWNER_DECISION과의 교차검증까지). "
      + "이전에는 tests/seed-release-v018.test.mjs만 별도로 검증했고 실제 Gate는 그 필드를 읽지 않아 load-bearing하지 않았다. "
      + "Fact/Evidence/Coverage/Gold/Plan/Chain 데이터나 Thin Flow 템플릿은 이 revision에서 전혀 추가/변경되지 않았다 -- "
      + "Q07/Q21/Q24 metric_fail(4건)과 REVIEW_REQUIRED(17건)는 여전히 미해결이며, "
      + "전체 Release Gate는 domain/releases/seed-release.v0.18.RELEASE_GATE_STATUS.json 기준으로 BLOCKED로 유지된다.",
  };

  const canonicalContentHash = canonicalManifestBindingHash(canonicalBase);
  const structuredManifestBytes = await readAbs(STRUCTURED_MANIFEST);
  const structuredContentHash = sha256(structuredManifestBytes);
  const planHash = sha256(planBytes);
  const planManifestHash = await sha256OfFile(PLAN_MANIFEST_PATH);
  const goldHash = canonicalArtifactsBase.find((a) => a.role === "SEED_GOLD").sha256;
  const coverageHash = structuredManifest.artifacts.find((a) => a.role === "FACT_COVERAGE_SNAPSHOT").sha256;
  const ownerBatchDecisionHash = await sha256OfFile(OWNER_BATCH_DECISION_PATH);

  const decision = {
    schema_version: "0.3.0",
    decision_id: "seed-release-v0.19-decision",
    status: "APPROVED",
    approved_by: APPROVED_BY,
    approved_at: APPROVED_AT,
    release_id: canonicalBase.release_id,
    approved_revision: structuredManifest.artifact_set_id,
    corpus_snapshot_id: CORPUS_SNAPSHOT_ID,
    fact_coverage_snapshot_id: structuredManifest.fact_coverage_snapshot_id,
    canonical_release_manifest: { path: CANONICAL_OUT, sha256: canonicalContentHash },
    structured_manifest: { path: STRUCTURED_MANIFEST, sha256: structuredContentHash },
    canonical_artifacts: pinArtifacts(canonicalArtifactsBase),
    structured_artifacts: pinArtifacts(structuredManifest.artifacts),
    thin_plan: { path: PLAN_PATH, sha256: planHash, record_count: planRecordCount },
    thin_plan_manifest: { path: PLAN_MANIFEST_PATH, sha256: planManifestHash },
    thin_plan_source_gold: { path: goldPath, sha256: goldHash },
    thin_plan_source_coverage: { path: coveragePath, sha256: coverageHash },
    owner_batch_decision: {
      path: OWNER_BATCH_DECISION_PATH, sha256: ownerBatchDecisionHash, record_count: ownerBatchDecision.length,
      approved_by: APPROVED_BY, all_approve: true,
    },
    release_gate_status: {
      overall: "BLOCKED",
      note: "v0.17 audit finding (self-approved 6-item batch) remains resolved (unchanged from v0.18). Q07/Q21/Q24 metric_fail (4) and 17 REVIEW_REQUIRED items remain open -- see domain/releases/seed-release.v0.18.RELEASE_GATE_STATUS.json. This release is NOT a claim that those are resolved. No new Facts or Thin Flow templates were added in v0.19.",
    },
    basis:
      "동일한 seed-structured-owner-decision-v0.7 (88/88 APPROVE, Owner: 최재완) + 동일한 scripts/promote-seed-fact-batch-v06.mjs 승격 결과. "
      + "v0.18과의 유일한 차이는 domain/adapters/seed-runtime-service-adapters.mjs가 owner_batch_decision을 실제로 읽고 검증하게 된 것뿐이다 "
      + "(assertOwnerBatchDecisionBinding, tests/seed-owner-batch-decision-binding.test.mjs로 fail-closed 시나리오 전부 검증됨). "
      + "signing_limitation: approved_by는 암호학적 서명이 아니라 저장소 내부 절차적 Owner assertion이다 "
      + "(domain/releases/README.md 'Release Gate: 승인 신원의 한계와 최종 신뢰 anchor' 절 참조).",
  };
  const decisionText = `${JSON.stringify(decision, null, 2)}\n`;
  await writeFile(path.join(REPO, DECISION_OUT), decisionText, "utf8");
  const decisionHash = sha256(Buffer.from(decisionText, "utf8"));

  const canonicalFinal = {
    ...canonicalBase,
    release_authorization: {
      status: "APPROVED",
      approved_by: APPROVED_BY,
      approved_at: APPROVED_AT,
      decision_artifact_path: DECISION_OUT,
      decision_artifact_sha256: decisionHash,
      signing_note: "Repository-internal procedural Owner assertion, not a cryptographic signature -- see domain/releases/README.md.",
    },
  };
  await writeFile(path.join(REPO, CANONICAL_OUT), `${JSON.stringify(canonicalFinal, null, 2)}\n`, "utf8");

  // Self-check: prove the just-written bundle actually constructs through
  // the real, now-hardened gate before declaring success.
  const bundle = await createSeedRuntimeServiceAdapters({
    structuredManifestPath: path.join(REPO, STRUCTURED_MANIFEST),
    canonicalReleaseManifestPath: path.join(REPO, CANONICAL_OUT),
    planPath: path.join(REPO, PLAN_PATH),
    planManifestPath: path.join(REPO, PLAN_MANIFEST_PATH),
    root: REPO,
  });

  console.log(JSON.stringify({
    canonical_manifest: { path: CANONICAL_OUT, sha256: await sha256OfFile(CANONICAL_OUT) },
    decision_artifact: { path: DECISION_OUT, sha256: decisionHash },
    thin_plan: decision.thin_plan,
    owner_batch_decision: decision.owner_batch_decision,
    release_id: canonicalBase.release_id,
    fact_coverage_snapshot_id: decision.fact_coverage_snapshot_id,
    self_check_record_counts: bundle.serviceAdapters.structuredStoreAdapter.recordCounts(),
  }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
