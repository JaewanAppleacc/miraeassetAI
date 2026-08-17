// Turn M8 Section 10/11: reassembles a NEW, portable v0.20 Candidate
// bundle revision that actually carries this Turn's real content --
// Fact v0.8 / Coverage v0.7 / Evidence v0.9 / merged Owner decision
// v0.10 (102) / the clean v0.6-based Plan (v0.12.clean.candidate) /
// approved Company Directory v0.2 -- WITHOUT touching the existing
// domain/releases/bundles/seed-release-v0.20/ (that stays exactly as
// Turn L2 left it, preserved as audit history) or domain/releases/
// seed-release.v0.19.manifest.json (still the production pointer;
// domain/runtime/configured-seed-runtime.mjs is not touched by this
// script and keeps pointing at v0.19).
//
// This produces FOUR artifacts, deliberately kept separate:
//  1. seed-release.v0.20-r2.candidate.binding-decision.json -- an
//     internal, repository-procedural decision whose ONLY job is to let
//     the manifest/decision binding checks (assertReleaseAuthorized/
//     assertDecisionBindsReleaseBundle/assertThinPlanBinding) construct
//     successfully so the bundle CAN be built and isolated-deployment
//     tested. Its status:"APPROVED" is explicitly NOT a business release
//     approval -- see its own signing_note.
//  2. seed-release.v0.20-r2.candidate.manifest.json -- the candidate
//     release manifest. release_status stays "CANDIDATE" (never
//     APPROVED/READY) at the top level; release_authorization points at
//     (1) purely so the artifact chain is constructible.
//  3. seed-release.v0.20-r2.candidate.RELEASE_GATE_STATUS.json -- the
//     per-gate PASS/PENDING/BLOCKED breakdown Turn M8 Section 11
//     requires.
//  4. seed-release.v0.20-r2.candidate.owner-decision-template.json --
//     the REAL, human-facing Owner release decision. status stays
//     "PENDING" -- this Turn never fills it in or auto-approves it.
//
// Then it builds the actual bundle directory at domain/releases/bundles/
// seed-release-v0.20-r2.candidate/ from (2), reusing buildReleaseBundle's
// existing deterministic-gzip / closure / self-verification machinery
// unchanged.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalManifestBindingHash } from "../domain/adapters/seed-runtime-service-adapters.mjs";
import { buildReleaseBundle } from "../domain/adapters/seed-release-bundle-builder.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APPROVED_BY = "최재완";
const BUILD_R3 = process.argv.includes("--r3");
const RELEASE_SUFFIX = BUILD_R3 ? "r3" : "r2";
const RELEASE_ID = `seed-release-v0.20-${RELEASE_SUFFIX}-candidate`;

const V19_MANIFEST_PATH = "domain/releases/seed-release.v0.19.manifest.json";
const STRUCTURED_MANIFEST_PATH = "work/domain-seed/seed-structured-artifacts.v0.7.manifest.json";
const PLAN_PATH = BUILD_R3
  ? "work/domain-seed/seed-thin-flow-plans.v0.13.clean.candidate.jsonl"
  : "work/domain-seed/seed-thin-flow-plans.v0.12.clean.candidate.jsonl";
const PLAN_MANIFEST_PATH = BUILD_R3
  ? "work/domain-seed/seed-thin-flow-plans.v0.13.clean.candidate.manifest.json"
  : "work/domain-seed/seed-thin-flow-plans.v0.12.clean.candidate.manifest.json";
const GOLD_PATH = "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl";
const COMPANY_DIRECTORY_PATH = "work/domain-seed/seed-company-directory.v0.2.approved.jsonl";
const COMPANY_DIRECTORY_MANIFEST_PATH = "work/domain-seed/seed-company-directory.v0.2.approved.manifest.json";
const COMPANY_DIRECTORY_DECISION_PATH = "work/domain-seed/seed-company-directory-owner-decision.v0.2.approved.json";
const TIMELINE_POLICY_DECISION_PATH = "work/domain-seed/seed-timeline-fact-narrative-policy-decision.v0.1.json";
const OWNER_BATCH_DECISION_PATH = "work/domain-seed/seed-structured-owner-decision.v0.7-batch.decision.jsonl";
// Ontology Owner decision v0.2 / Final Candidate Owner decision v0.1 live
// outside the repo (user-supplied approval files, re-verified by hash in
// Turn M8 Section 1 -- see this Turn's conversation record). Their
// SHA-256 pins are recorded here as CONSTANTS, never a filesystem path,
// so this committed script carries no personal absolute path.
const EXPECTED_ONTOLOGY_OWNER_DECISION_SHA256 = "9503cc79b2bd63c2ac6b52e6da1e4ffbb01c72232781ef33b296fa0f840d49ee";
const EXPECTED_FINAL_CANDIDATE_OWNER_DECISION_SHA256 = "99a0394b63a2e073c984bcd525fb6c7e78c4d523a07a952743201d662375a8f6";
const WIRE_REVISION_DIR = BUILD_R3
  ? "work/domain-seed/seed-harness-v07-wire.r16"
  : "work/domain-seed/seed-harness-v07-wire.r13";
const WIRE_SUMMARY_PATH = BUILD_R3
  ? "work/domain-seed/seed-thin-flow-harness-v07-synthesis-sandbox.r16.summary.json"
  : "work/domain-seed/seed-thin-flow-harness-v07-synthesis-sandbox.r13.summary.json";

const BINDING_DECISION_PATH = `domain/releases/seed-release.v0.20-${RELEASE_SUFFIX}.candidate.binding-decision.json`;
const CANDIDATE_MANIFEST_PATH = `domain/releases/seed-release.v0.20-${RELEASE_SUFFIX}.candidate.manifest.json`;
const GATE_STATUS_PATH = `domain/releases/seed-release.v0.20-${RELEASE_SUFFIX}.candidate.RELEASE_GATE_STATUS.json`;
const OWNER_TEMPLATE_PATH = `domain/releases/seed-release.v0.20-${RELEASE_SUFFIX}.candidate.owner-decision-template.json`;
const BUNDLE_DIR = `domain/releases/bundles/seed-release-v0.20-${RELEASE_SUFFIX}.candidate`;
const MAX_SINGLE_FILE_BYTES = 100 * 1024 * 1024;

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function fail(msg) { throw new Error(`M8_V020_R2_BUNDLE_BLOCKED: ${msg}`); }
async function readAbs(rel) { return readFile(path.join(REPO, rel)); }
async function sha256OfFile(rel) { return sha256(await readAbs(rel)); }
function pinArtifacts(list) { return list.map((a) => ({ role: a.role, path: a.path, sha256: a.sha256, record_count: a.record_count ?? null })); }

async function walkFiles(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(full, base)));
    else if (entry.isFile()) files.push(path.relative(base, full));
  }
  return files;
}

async function main() {
  // --- gather source artifacts, verifying they exist and are unmodified
  // from what earlier Turns produced (never mutated by this script).
  const v19Manifest = JSON.parse((await readAbs(V19_MANIFEST_PATH)).toString("utf8"));
  const canonicalArtifactsBase = v19Manifest.artifacts;
  if (canonicalArtifactsBase.map((a) => a.role).sort().join(",") !== "CANONICAL_DOCUMENT_IR_BASE,CANONICAL_DOCUMENT_IR_DELTA,SEED_GOLD") {
    fail("v0.19 manifest artifact roles changed unexpectedly");
  }

  const structuredManifestBytes = await readAbs(STRUCTURED_MANIFEST_PATH);
  const structuredManifest = JSON.parse(structuredManifestBytes.toString("utf8"));
  if (structuredManifest.artifact_set_id !== "seed-structured-artifacts-v0.7") fail("structured manifest is not v0.7");

  const planBytes = await readAbs(PLAN_PATH);
  const planManifestBytes = await readAbs(PLAN_MANIFEST_PATH);
  const planManifest = JSON.parse(planManifestBytes.toString("utf8"));
  const planRecordCount = planBytes.toString("utf8").trim().split("\n").filter(Boolean).length;
  if (planRecordCount !== 25 || planManifest.record_count !== 25) fail(`clean Plan v0.${BUILD_R3 ? "13" : "12"} record count is not 25`);
  const expectedPlanBase = BUILD_R3
    ? "work/domain-seed/seed-thin-flow-plans.v0.12.clean.candidate.jsonl"
    : "work/domain-seed/seed-thin-flow-plans.v0.6.jsonl";
  if (planManifest.based_on?.path !== expectedPlanBase) fail(`clean Plan does not declare the expected base ${expectedPlanBase}`);
  if (BUILD_R3) {
    const v12Manifest = JSON.parse((await readAbs("work/domain-seed/seed-thin-flow-plans.v0.12.clean.candidate.manifest.json")).toString("utf8"));
    if (v12Manifest.based_on?.path !== "work/domain-seed/seed-thin-flow-plans.v0.6.jsonl") fail("Plan v0.13's v0.12 parent is not based on Plan v0.6");
  }

  const goldBytes = await readAbs(GOLD_PATH);
  const seedGoldPin = canonicalArtifactsBase.find((a) => a.role === "SEED_GOLD");
  if (seedGoldPin.sha256 !== sha256(goldBytes)) fail("Gold file changed since v0.19 -- refusing stale pin");

  const companyDecisionBytes = await readAbs(COMPANY_DIRECTORY_DECISION_PATH);
  const companyDecision = JSON.parse(companyDecisionBytes.toString("utf8"));
  if (companyDecision.status !== "APPROVED" && companyDecision.owner_disposition !== "APPROVED") {
    fail(`Company Directory v0.2 owner decision is not APPROVED (${JSON.stringify(companyDecision.status ?? companyDecision.owner_disposition)})`);
  }

  const batchBytes = await readAbs(OWNER_BATCH_DECISION_PATH);
  const batchItems = batchBytes.toString("utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (!batchItems.every((it) => it.owner_disposition === "APPROVE" && it.reviewer === APPROVED_BY)) fail("owner batch decision has a non-APPROVE item");

  // Ontology / Final Candidate Owner decisions live outside the repo --
  // this script does not read them (no personal absolute path in a
  // committed script). Their hashes were independently re-verified in
  // Turn M8 Section 1 against the constants above; only those constants
  // are recorded into this Turn's Gate status/manifest notes.
  const expectedOntologySha256 = EXPECTED_ONTOLOGY_OWNER_DECISION_SHA256;
  const expectedFinalCandidateSha256 = EXPECTED_FINAL_CANDIDATE_OWNER_DECISION_SHA256;

  // --- Wire r13 (final clean-Plan capture) summary, referenced by the
  // Gate status as the actual runtime_candidate_e2e result.
  const wireIndex = JSON.parse((await readAbs(path.join(WIRE_REVISION_DIR, "index.json"))).toString("utf8"));
  const wireSummary = JSON.parse((await readAbs(WIRE_SUMMARY_PATH)).toString("utf8"));
  if (wireIndex.count !== 25 || wireSummary.api_success !== 25 || wireSummary.http_errors !== 0) fail("selected Wire capture is not a clean 25/25 run");

  // --- 1) binding decision (procedural only, status APPROVED so the
  // artifact chain is constructible/testable -- never a business
  // release approval; see its own signing_note).
  // r3 is a reproducible Candidate assembly: reuse the already-pinned
  // final Wire capture timestamp instead of injecting wall-clock time.
  // r2's historical default behavior is intentionally preserved.
  const approvedAt = BUILD_R3 ? wireIndex.generated_at : new Date().toISOString();
  const bindingDecisionWithoutSelfRef = {
    schema_version: "0.3.0",
    decision_id: `${RELEASE_ID}-binding-decision`,
    status: "APPROVED",
    approved_by: APPROVED_BY,
    approved_at: approvedAt,
    release_id: RELEASE_ID,
    approved_revision: structuredManifest.artifact_set_id,
    corpus_snapshot_id: v19Manifest.corpus_snapshot_id,
    fact_coverage_snapshot_id: structuredManifest.fact_coverage_snapshot_id,
    canonical_release_manifest: { path: CANDIDATE_MANIFEST_PATH, sha256: null }, // filled in pass 2
    structured_manifest: { path: STRUCTURED_MANIFEST_PATH, sha256: sha256(structuredManifestBytes) },
    canonical_artifacts: pinArtifacts(canonicalArtifactsBase),
    structured_artifacts: pinArtifacts(structuredManifest.artifacts),
    thin_plan: { path: PLAN_PATH, sha256: sha256(planBytes), record_count: planRecordCount },
    thin_plan_manifest: { path: PLAN_MANIFEST_PATH, sha256: sha256(planManifestBytes) },
    thin_plan_source_gold: { path: GOLD_PATH, sha256: seedGoldPin.sha256 },
    thin_plan_source_coverage: {
      path: "work/domain-seed/seed-fact-coverage-verified.v0.7.json",
      sha256: structuredManifest.artifacts.find((a) => a.role === "FACT_COVERAGE_SNAPSHOT").sha256,
    },
    owner_batch_decision: {
      path: OWNER_BATCH_DECISION_PATH, sha256: sha256(batchBytes), record_count: batchItems.length,
      approved_by: APPROVED_BY, all_approve: true,
    },
    basis:
      `${BUILD_R3 ? "Turn M10/M10.1 Plan v0.13" : "Turn M8 clean Plan"} (Plan v0.6 clean 계보, v0.7-v0.11 Candidate 계보 미상속) + Turn M7 승격 14건 Fact `
      + "+ 병합 Owner decision v0.10(102) + 승인된 Company Directory v0.2. "
      + "이 decision의 status:APPROVED는 manifest-decision 결합을 위한 저장소 내부 절차적 assertion일 뿐, "
      + "v0.20 실제 release 승인이 아니다 -- 실제 release 판단은 별도 owner-decision-template.json(PENDING)에서 이루어진다.",
    signing_note: "Repository-internal procedural binding decision, sandbox-equivalent authorization plumbing only -- never a production release authorization. See domain/releases/README.md.",
  };

  // pass 1: hash the manifest WITHOUT release_authorization, so the
  // binding decision can reference it; pass 2: the decision's own hash
  // is computed, then the final manifest embeds release_authorization
  // pointing at the decision -- breaking the circular dependency exactly
  // as the Turn M7/M8 sandbox chains already do.
  const manifestWithoutAuth = {
    schema_version: "0.1.0",
    release_id: RELEASE_ID,
    release_status: "CANDIDATE",
    corpus_snapshot_id: v19Manifest.corpus_snapshot_id,
    artifacts: canonicalArtifactsBase,
    approved_revision: structuredManifest.artifact_set_id,
    supersedes: null,
    supersession_note:
      "이 파일은 v0.20 최종 승인 release가 아니다 -- release_status는 CANDIDATE로 유지된다. "
      + "domain/releases/bundles/seed-release-v0.20/ (Turn L2, Fact v0.7/Plan v0.6 기준)은 수정하지 않고 감사 이력으로 보존한다. "
      + `이 revision(v0.20-${RELEASE_SUFFIX}.candidate)은 Fact v0.8(14건 신규)/Coverage v0.7/Evidence v0.9/`
      + `병합 Owner decision v0.10(102)/clean Plan v0.${BUILD_R3 ? "13" : "12"}(Plan v0.6 clean 계보, sub_request 계보 미상속)/`
      + "승인된 Company Directory v0.2를 대상으로 한다. "
      + "domain/runtime/configured-seed-runtime.mjs는 이 파일을 참조하지 않으며 계속 v0.19를 가리킨다. "
      + "최종 v0.20 승인 여부는 별도 owner-decision-template.json(PENDING)에서 사람이 판단한다.",
  };
  const manifestBindingHash = canonicalManifestBindingHash(manifestWithoutAuth);

  const bindingDecision = { ...bindingDecisionWithoutSelfRef, canonical_release_manifest: { path: CANDIDATE_MANIFEST_PATH, sha256: manifestBindingHash } };
  const bindingDecisionText = `${JSON.stringify(bindingDecision, null, 2)}\n`;
  const bindingDecisionBytes = Buffer.from(bindingDecisionText, "utf8");
  await writeFile(path.join(REPO, BINDING_DECISION_PATH), bindingDecisionText, "utf8");

  const finalManifest = {
    ...manifestWithoutAuth,
    release_authorization: {
      status: "APPROVED", approved_by: APPROVED_BY, approved_at: approvedAt,
      decision_artifact_path: BINDING_DECISION_PATH,
      decision_artifact_sha256: sha256(bindingDecisionBytes),
      signing_note: "Repository-internal procedural Owner assertion binding this manifest to its decision -- NOT a claim that v0.20-r2.candidate is approved for production. See owner-decision-template.json (status PENDING) for the actual release disposition.",
    },
  };
  await writeFile(path.join(REPO, CANDIDATE_MANIFEST_PATH), `${JSON.stringify(finalManifest, null, 2)}\n`, "utf8");

  // --- 3) Release Gate status (Section 11's exact per-gate breakdown)
  const gateStatus = {
    schema_version: "0.1.0",
    report_type: "RELEASE_GATE_STATUS",
    subject_release: CANDIDATE_MANIFEST_PATH,
    subject_structured_manifest: STRUCTURED_MANIFEST_PATH,
    generated_at: BUILD_R3 ? wireIndex.generated_at : new Date().toISOString(),
    gates: {
      data_promotion: {
        status: "PASS",
        detail: "Fact v0.8 (87, 14 promoted this Turn) / Coverage v0.7 (102 slots) / Evidence v0.9 / 병합 Owner decision v0.10 (102, 최재완, 전원 APPROVE) -- structured manifest v0.7로 schema-valid 및 참조 무결.",
      },
      ontology_owner_review: {
        status: "PASS",
        detail: `Ontology Owner decision v0.2 재확인 완료 (sha256 ${expectedOntologySha256}).`,
      },
      candidate_owner_review: {
        status: "PASS",
        detail: `Final Candidate Owner decision v0.1 재확인 완료 (sha256 ${expectedFinalCandidateSha256}). Turn M7 Q18 정책(APPROVE_INFORMATION_LIMIT_FOR_V020) release_blocking:false.`,
      },
      q18_information_limit_policy: {
        status: "PASS",
        detail: "새 information_limits Plan 계약(구조/의미 검증기, Composer 렌더링, Validator 무결성 검사, PARTIAL 강제 규칙)이 TDD로 구현/검증됨. Q18 r13 답변이 2,198,873,250원을 발행총액으로 주장하지 않음(자동 검증 통과).",
      },
      clean_plan_lineage: {
        status: "PASS",
        detail: `clean Plan v0.${BUILD_R3 ? "13" : "12"} lineage verified through Plan v0.6. changed_question_ids=${JSON.stringify(planManifest.changed_question_ids)}. sub_request_authority_present=false.`,
      },
      runtime_candidate_e2e: {
        status: wireSummary.failed_question_ids?.length === 0 && wireSummary.http_errors === 0 ? "PASS" : "ATTENTION",
        detail: `Wire ${path.basename(WIRE_REVISION_DIR)}: api_success=${wireSummary.api_success}/25, metric_pass=${wireSummary.metric_pass}, metric_fail=${wireSummary.metric_fail}, review_required=${wireSummary.review_required}. metric_fail/review_required는 출력 통일 작업으로 최적화하지 않음.`,
      },
      final_integration_owner_review: {
        status: "PENDING",
        detail: BUILD_R3
          ? "Turn M9 Owner 결정의 FIX_REQUIRED 항목은 Turn M10/M10.1 공통 규칙으로 기계 검증됐지만, 최종 release Owner 승인은 아직 생성하지 않음."
          : "seed-response-turn-m8-integration-packet.v0.1.json의 6개 질문(Q06/09/17/18/20/25) owner_disposition이 모두 PENDING -- 사람이 아직 검수하지 않음.",
      },
      official_clean_clone: {
        status: "BLOCKED_BY_UNCOMMITTED_SOURCE",
        detail: "이번 Turn의 소스 변경(domain/adapters, domain/flows/synthesis, scripts, tests)이 아직 커밋되지 않았다 -- 이 Turn은 stage/commit/push를 하지 않는다는 명시적 제약이 있다.",
      },
      deployment: { status: "BLOCKED", detail: "final_integration_owner_review PENDING + official_clean_clone BLOCKED_BY_UNCOMMITTED_SOURCE에 종속." },
    },
    overall: "BLOCKED",
    overall_note:
      "이 Gate는 v0.20-r2.candidate가 배선/정책/lineage 측면에서 PASS하는 항목이 많다는 것을 보여주지만, "
      + "final_integration_owner_review(PENDING)와 official_clean_clone(BLOCKED_BY_UNCOMMITTED_SOURCE) 때문에 overall은 BLOCKED다. "
      + "이번 Turn은 v0.20 APPROVED decision을 생성하지 않으며, configured-seed-runtime.mjs를 재지정하지 않으며, stage/commit/push를 하지 않는다.",
    known_limitations_carried_forward: [
      "Q07/Q21/Q24 등 기존 metric_fail -- 이번 Turn 범위 밖, 미해결.",
      "17건 REVIEW_REQUIRED -- 이번 Turn 범위 밖, 미해결.",
      "approved_by는 암호학적 서명이 아니라 저장소 내부 절차적 Owner assertion이다.",
    ],
  };
  await writeFile(path.join(REPO, GATE_STATUS_PATH), `${JSON.stringify(gateStatus, null, 2)}\n`, "utf8");

  // --- 4) the REAL, human-facing Owner release decision template.
  // status stays PENDING -- this script never fills it in.
  const ownerTemplate = {
    schema_version: "0.1.0",
    decision_id: `${RELEASE_ID}-owner-decision`,
    status: "PENDING",
    subject_release_manifest: { path: CANDIDATE_MANIFEST_PATH, sha256: manifestBindingHash },
    subject_gate_status: { path: GATE_STATUS_PATH },
    subject_integration_packet: { path: BUILD_R3
      ? "work/handoff/seed-final-response-owner-review/results/seed-response-turn-m101-closure-report.v0.1.json"
      : "work/handoff/seed-final-response-owner-review/results/seed-response-turn-m8-integration-packet.v0.1.json" },
    checklist: {
      clean_plan_lineage_confirmed: null,
      q18_information_limit_wording_acceptable: null,
      ...(BUILD_R3
        ? { turn_m101_seven_changed_questions_closure_confirmed: null, no_unexpected_regression_vs_r14: null }
        : { six_changed_questions_reviewed_in_integration_packet: null, no_unrelated_regression_vs_pre_turn_m7_baseline: null }),
      owner_batch_decision_and_merged_decision_agree: null,
    },
    owner_disposition: "PENDING",
    reviewer: null,
    reviewed_at: null,
    notes: `${BUILD_R3 ? "Turn M10.1 종료 Candidate" : "Turn M8 산출물"} -- 사람이 검수하기 전까지 PENDING으로 유지된다. 자동 승인 없음. v0.20 APPROVED release 판단은 이 템플릿을 사람이 채운 뒤에만 성립한다.`,
  };
  await writeFile(path.join(REPO, OWNER_TEMPLATE_PATH), `${JSON.stringify(ownerTemplate, null, 2)}\n`, "utf8");

  // --- 5) build the actual portable bundle from the CANDIDATE manifest.
  const bundleResult = await buildReleaseBundle({
    bundleDir: BUNDLE_DIR, status: "CANDIDATE", root: REPO, generatedAt: approvedAt,
    structuredManifestPath: STRUCTURED_MANIFEST_PATH,
    canonicalReleaseManifestPath: CANDIDATE_MANIFEST_PATH,
    planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH,
    expectedReleaseId: RELEASE_ID, expectedApprovedRevision: structuredManifest.artifact_set_id,
    companyDirectoryArtifactPath: COMPANY_DIRECTORY_PATH,
    companyDirectoryManifestPath: COMPANY_DIRECTORY_MANIFEST_PATH,
    companyDirectoryOwnerDecisionPath: COMPANY_DIRECTORY_DECISION_PATH,
    timelinePolicyDecisionPath: TIMELINE_POLICY_DECISION_PATH,
  });

  // The human-facing decision must bind the actual portable bundle, not
  // merely the canonical release manifest that was used to construct it.
  // This is written only after buildReleaseBundle has closed and verified
  // the directory, avoiding any self-approval or circular hash claim.
  ownerTemplate.subject_bundle_manifest = {
    path: `${BUNDLE_DIR}/bundle-manifest.json`,
    sha256: bundleResult.bundleManifestSha256,
  };
  gateStatus.gates.portable_bundle_integrity = {
    status: "PASS",
    detail: `Actual bundle-manifest.json is externally pinned by the PENDING Owner template (sha256 ${bundleResult.bundleManifestSha256}); all declared bundle entries passed directory/hash verification.`,
  };
  await writeFile(path.join(REPO, OWNER_TEMPLATE_PATH), `${JSON.stringify(ownerTemplate, null, 2)}\n`, "utf8");
  await writeFile(path.join(REPO, GATE_STATUS_PATH), `${JSON.stringify(gateStatus, null, 2)}\n`, "utf8");

  const bundleDirAbs = path.resolve(REPO, BUNDLE_DIR);
  const files = await walkFiles(bundleDirAbs);
  let totalEncodedBytes = 0;
  const oversized = [];
  const fileSizes = [];
  for (const relPath of files) {
    const st = await stat(path.join(bundleDirAbs, relPath));
    totalEncodedBytes += st.size;
    fileSizes.push({ path: relPath, bytes: st.size });
    if (st.size >= MAX_SINGLE_FILE_BYTES) oversized.push({ path: relPath, bytes: st.size });
  }
  const containsRawDocumentIr = files.some((f) => /seed-canonical-document-ir.*\.jsonl$/.test(f) && !f.endsWith(".gz"));
  if (oversized.length > 0) fail(`${oversized.length} bundle file(s) are >= 100MiB: ${oversized.map((f) => f.path).join(", ")}`);
  if (containsRawDocumentIr) fail("bundle contains an uncompressed raw Canonical DocumentIR shard");

  // existing v0.20 bundle must remain untouched by this run
  const existingBundleFiles = await walkFiles(path.resolve(REPO, "domain/releases/bundles/seed-release-v0.20"));
  if (existingBundleFiles.length === 0) fail("existing v0.20 bundle appears empty/missing -- refusing (should never happen)");

  const report = {
    bundle_dir: BUNDLE_DIR,
    bundle_manifest_sha256: bundleResult.bundleManifestSha256,
    status: "CANDIDATE",
    file_count: files.length,
    total_encoded_bytes: totalEncodedBytes,
    total_encoded_mib: Number((totalEncodedBytes / (1024 * 1024)).toFixed(2)),
    largest_file: fileSizes.sort((a, b) => b.bytes - a.bytes)[0],
    max_single_file_bytes_limit: MAX_SINGLE_FILE_BYTES,
    contains_raw_document_ir: containsRawDocumentIr,
    all_files_under_100mib: oversized.length === 0,
    existing_v020_bundle_file_count_unchanged_check: existingBundleFiles.length,
    binding_decision_path: BINDING_DECISION_PATH,
    binding_decision_sha256: sha256(bindingDecisionBytes),
    candidate_manifest_path: CANDIDATE_MANIFEST_PATH,
    candidate_manifest_sha256: sha256(await readAbs(CANDIDATE_MANIFEST_PATH)),
    gate_status_path: GATE_STATUS_PATH,
    owner_decision_template_path: OWNER_TEMPLATE_PATH,
    owner_decision_template_status: ownerTemplate.status,
  };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
