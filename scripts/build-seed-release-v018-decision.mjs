// Builds the v0.18 APPROVED release bundle: a new canonical release
// manifest + a new JSON decision artifact binding the v0.6 structured
// manifest (Fact v0.7/Evidence v0.9/Coverage v0.6, promoted via a REAL,
// externally authored Owner decision -- see
// work/domain-seed/seed-structured-owner-decision.v0.7-batch.decision.jsonl,
// SHA-256-pinned explicitly below via `owner_batch_decision`) AND the v0.6
// Thin plan -- preserving both prior hardenings (plan binding, Chain
// binding) closed in v0.17. v0.17's manifest/decision (built from the
// self-approved v0.5-batch decision -- see
// domain/releases/seed-release.v0.17.BLOCKED.audit-report.json) is never
// modified; this is a new, independent revision.
//
// This script does NOT claim the Release Gate is fully open: the six
// items resolved here (v0.17's audit finding) are only part of what the
// overall Gate requires. Q07/Q21/Q24 metric_fail and the 17 REVIEW_REQUIRED
// items remain open and are explicitly NOT marked resolved anywhere in
// this manifest/decision -- see release_gate_status below and
// domain/releases/seed-release.v0.18.RELEASE_GATE_STATUS.json.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalManifestBindingHash } from "../domain/adapters/seed-runtime-service-adapters.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APPROVED_AT = new Date().toISOString();
const APPROVED_BY = "최재완";
const CORPUS_SNAPSHOT_ID = "corpus_04750795e1a2d5c3";

const CANONICAL_OUT = "domain/releases/seed-release.v0.18.manifest.json";
const DECISION_OUT = "domain/releases/seed-release.v0.18.decision.json";
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

  // Verify the batch decision this release binds really is the real,
  // externally authored, 6/6 APPROVE artifact -- never trust a path alone.
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
    release_id: "seed-release-v0.18",
    release_status: "APPROVED",
    corpus_snapshot_id: CORPUS_SNAPSHOT_ID,
    artifacts: canonicalArtifactsBase,
    approved_revision: structuredManifest.artifact_set_id,
    supersedes: "domain/releases/seed-release.v0.17.manifest.json",
    supersession_note:
      "v0.17 감사(domain/releases/seed-release.v0.17.BLOCKED.audit-report.json)에서 지적된 자동 self-approval 결함을 실제 Owner 승인으로 대체: "
      + "6건(Q02/Q04/Q05/Q10) 모두 Owner(최재완)가 work/domain-seed/seed-structured-owner-decision.v0.7-batch.decision.jsonl로 직접 APPROVE하고 "
      + "scripts/promote-seed-fact-batch-v06.mjs가 그 결정 artifact의 path/SHA-256/6개 ID 집합/disposition/reviewer/reviewed_at을 검증한 뒤 승격했다. "
      + "Q10 두 Fact의 기간 의미 결함(CUMULATIVE -> POINT_IN_TIME, as_of_date/known_at 분리)도 함께 수정됨. "
      + "Thin plan release binding과 CHAIN_MANIFEST binding(v0.17에서 도입)은 그대로 유지됨. "
      + "v0.17/v0.5(자동 승인, 폐기)는 이 계보에 포함되지 않고 감사 이력으로 보존됨. "
      + "주의: 이 release는 v0.17 감사 결함만 해소한다 -- Q07/Q21/Q24 metric_fail(4건)과 REVIEW_REQUIRED(17건)는 여전히 미해결이며, "
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
    decision_id: "seed-release-v0.18-decision",
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
    // --- Thin plan binding (carried over from v0.17, unchanged mechanism) --
    thin_plan: { path: PLAN_PATH, sha256: planHash, record_count: planRecordCount },
    thin_plan_manifest: { path: PLAN_MANIFEST_PATH, sha256: planManifestHash },
    thin_plan_source_gold: { path: goldPath, sha256: goldHash },
    thin_plan_source_coverage: { path: coveragePath, sha256: coverageHash },
    // --- Explicit binding to the real, externally authored Owner batch
    // decision that this release's 6 new items trace back to (schema_version
    // 0.3.0's new field over v0.17's 0.2.0 -- v0.17 had no such field
    // because it never had a genuine one to bind). ----------------------
    owner_batch_decision: {
      path: OWNER_BATCH_DECISION_PATH, sha256: ownerBatchDecisionHash, record_count: ownerBatchDecision.length,
      approved_by: APPROVED_BY, all_approve: true,
    },
    release_gate_status: {
      overall: "BLOCKED",
      note: "v0.17 audit finding (self-approved 6-item batch) is resolved by this release. Q07/Q21/Q24 metric_fail (4) and 17 REVIEW_REQUIRED items remain open -- see domain/releases/seed-release.v0.18.RELEASE_GATE_STATUS.json for the full gate breakdown. This release is NOT a claim that those are resolved.",
    },
    basis:
      "seed-structured-owner-decision-v0.7 (88/88 APPROVE, Owner: 최재완; 82건은 v0.4에서 계승, 6건은 owner_batch_decision에 직접 pinned) + "
      + "scripts/promote-seed-structured-artifacts-v04.mjs + scripts/promote-seed-fact-batch-v06.mjs promotions "
      + "(referential closure verified, official schema validation passed, fail-closed decision-artifact validation passed) + "
      + "Thin plan binding과 Chain binding은 v0.17에서 도입된 채로 유지. "
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

  console.log(JSON.stringify({
    canonical_manifest: { path: CANONICAL_OUT, sha256: await sha256OfFile(CANONICAL_OUT) },
    decision_artifact: { path: DECISION_OUT, sha256: decisionHash },
    thin_plan: decision.thin_plan,
    owner_batch_decision: decision.owner_batch_decision,
    release_id: canonicalBase.release_id,
    fact_coverage_snapshot_id: decision.fact_coverage_snapshot_id,
  }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
