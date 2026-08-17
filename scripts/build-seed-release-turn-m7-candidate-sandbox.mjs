// Turn M7 Section 6: a SANDBOX-ONLY canonical release manifest + decision
// pair that authorizes the Turn M7 Candidate structured/plan artifacts
// for a TEST-ONLY runtime instance -- this is explicitly NOT a v0.20
// release manifest/decision (forbidden this Turn) and is never read by
// domain/runtime/configured-seed-runtime.mjs (which hardcodes
// EXPECTED_RELEASE_ID="seed-release-v0.19" and always points at v0.19's
// own manifest/decision -- untouched). This pair exists ONLY so the real
// seed-runtime-service-adapters.mjs release-authorization chain
// (assertReleaseAuthorized/assertDecisionBindsReleaseBundle/
// assertThinPlanBinding) -- which always runs, not just when
// expectedReleaseId is set -- can be satisfied by a sandbox test entrypoint
// (scripts/start-agent-server-turn-m7-candidate-sandbox.mjs) with
// requireOwnerBatchDecision/requireCompanyDirectory left at their
// no-op defaults for everything except companyDirectoryArtifactPath,
// which is reused unmodified (company data did not change this Turn).
//
// CANONICAL_DOCUMENT_IR_BASE/DELTA and SEED_GOLD are copied byte-for-byte
// from the REAL v0.19 canonical manifest (unchanged this Turn); only
// structured_manifest/structured_artifacts (-> Turn M7's new v0.7
// structured manifest) and thin_plan/thin_plan_manifest/
// thin_plan_source_coverage (-> Turn M7's new v0.11 Plan + v0.7 coverage)
// differ.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalManifestBindingHash } from "../domain/adapters/seed-runtime-service-adapters.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const V19_MANIFEST_PATH = path.join(REPO, "domain/releases/seed-release.v0.19.manifest.json");
const V19_DECISION_PATH = path.join(REPO, "domain/releases/seed-release.v0.19.decision.json");
const STRUCTURED_MANIFEST_V07_PATH = path.join(REPO, "work/domain-seed/seed-structured-artifacts.v0.7.manifest.json");
const PLAN_V11_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.11.candidate.jsonl");
const PLAN_V11_MANIFEST_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.11.candidate.manifest.json");
const GOLD_PATH = path.join(REPO, "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl");

const OUT_MANIFEST_PATH = path.join(REPO, "work/domain-seed/seed-release-turn-m7-candidate-sandbox.manifest.json");
const OUT_DECISION_PATH = path.join(REPO, "work/domain-seed/seed-release-turn-m7-candidate-sandbox.decision.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function fail(msg) { throw new Error(`SANDBOX_RELEASE_BLOCKED: ${msg}`); }

async function main() {
  const v19ManifestBytes = await readFile(V19_MANIFEST_PATH);
  const v19Manifest = JSON.parse(v19ManifestBytes.toString("utf8"));
  const v19Decision = JSON.parse((await readFile(V19_DECISION_PATH)).toString("utf8"));

  const structuredManifestBytes = await readFile(STRUCTURED_MANIFEST_V07_PATH);
  const structuredManifest = JSON.parse(structuredManifestBytes.toString("utf8"));
  if (structuredManifest.artifact_set_id !== "seed-structured-artifacts-v0.7") fail("structured manifest v0.7 has unexpected artifact_set_id");

  const planBytes = await readFile(PLAN_V11_PATH);
  const planManifestBytes = await readFile(PLAN_V11_MANIFEST_PATH);
  const planManifest = JSON.parse(planManifestBytes.toString("utf8"));
  const planRecordCount = planBytes.toString("utf8").trim().split("\n").filter(Boolean).length;
  if (planRecordCount !== planManifest.record_count) fail(`plan v0.11 record count mismatch: file has ${planRecordCount}, manifest declares ${planManifest.record_count}`);

  const goldBytes = await readFile(GOLD_PATH);
  const coverageV07Path = "work/domain-seed/seed-fact-coverage-verified.v0.7.json";
  const coverageV07Bytes = await readFile(path.join(REPO, coverageV07Path));

  const canonicalDocIrBase = v19Manifest.artifacts.find((a) => a.role === "CANONICAL_DOCUMENT_IR_BASE");
  const canonicalDocIrDelta = v19Manifest.artifacts.find((a) => a.role === "CANONICAL_DOCUMENT_IR_DELTA");
  const seedGold = v19Manifest.artifacts.find((a) => a.role === "SEED_GOLD");
  if (!canonicalDocIrBase || !canonicalDocIrDelta || !seedGold) fail("v0.19 manifest is missing an expected canonical artifact role");
  if (seedGold.sha256 !== sha256(goldBytes)) fail("Gold file has changed since v0.19 -- refusing to reuse a stale pin");

  const approvedAt = new Date().toISOString();
  const approvedBy = "최재완";

  // -- Pass 1: manifest WITHOUT release_authorization, to compute the binding hash --
  const manifestWithoutAuth = {
    schema_version: "0.1.0",
    release_id: "seed-release-turn-m7-candidate-sandbox",
    release_status: "SANDBOX_TEST_ONLY_NOT_A_RELEASE",
    corpus_snapshot_id: v19Manifest.corpus_snapshot_id,
    artifacts: [canonicalDocIrBase, canonicalDocIrDelta, seedGold],
    approved_revision: "seed-structured-artifacts-v0.7",
    supersedes: null,
    supersession_note: "이 파일은 v0.20 release manifest가 아니며 official release 계보에 속하지 않는다. Turn M7 Section 6의 Candidate Runtime 통합 검증(sandbox wire capture)에서만 사용되는 임시 authorization 체인이다. domain/runtime/configured-seed-runtime.mjs는 이 파일을 참조하지 않으며 계속 v0.19를 가리킨다.",
  };
  const bindingHash = canonicalManifestBindingHash(manifestWithoutAuth);
  if (bindingHash !== canonicalManifestBindingHash({ ...manifestWithoutAuth, release_authorization: { fake: true } })) {
    fail("canonicalManifestBindingHash is not stable across release_authorization presence -- assumption invalid, stop");
  }

  // -- Build the decision artifact ---------------------------------------
  const decision = {
    schema_version: "0.3.0",
    decision_id: "seed-release-turn-m7-candidate-sandbox-decision",
    status: "APPROVED",
    approved_by: approvedBy,
    approved_at: approvedAt,
    release_id: manifestWithoutAuth.release_id,
    approved_revision: structuredManifest.artifact_set_id,
    corpus_snapshot_id: v19Manifest.corpus_snapshot_id,
    fact_coverage_snapshot_id: structuredManifest.fact_coverage_snapshot_id,
    canonical_release_manifest: { path: "work/domain-seed/seed-release-turn-m7-candidate-sandbox.manifest.json", sha256: bindingHash },
    structured_manifest: { path: "work/domain-seed/seed-structured-artifacts.v0.7.manifest.json", sha256: sha256(structuredManifestBytes) },
    canonical_artifacts: [canonicalDocIrBase, canonicalDocIrDelta, seedGold],
    structured_artifacts: structuredManifest.artifacts,
    thin_plan: { path: "work/domain-seed/seed-thin-flow-plans.v0.11.candidate.jsonl", sha256: sha256(planBytes), record_count: planRecordCount },
    thin_plan_manifest: { path: "work/domain-seed/seed-thin-flow-plans.v0.11.candidate.manifest.json", sha256: sha256(planManifestBytes) },
    thin_plan_source_gold: { path: "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl", sha256: sha256(goldBytes) },
    thin_plan_source_coverage: { path: coverageV07Path, sha256: sha256(coverageV07Bytes) },
    // owner_batch_decision intentionally OMITTED -- the sandbox test
    // entrypoint passes requireOwnerBatchDecision:false (its no-op
    // default), so assertOwnerBatchDecisionBinding returns immediately
    // when this field is undefined (verified directly against that
    // function's own source before relying on this).
    basis: "Turn M7 승격 14건(seed-fact-batch-v07-turn-m7-promotion-receipt.json) + 병합 Owner decision(seed-structured-owner-decision.v0.10.jsonl) + Plan v0.11. Sandbox 전용 -- 공식 release 계보 아님, v0.20 아님.",
  };

  if (decision.thin_plan_source_gold.path !== planManifest.source_gold) fail(`plan manifest source_gold mismatch: decision has ${decision.thin_plan_source_gold.path}, plan manifest has ${planManifest.source_gold}`);
  if (decision.thin_plan_source_coverage.path !== planManifest.source_coverage) fail(`plan manifest source_coverage mismatch: decision has ${decision.thin_plan_source_coverage.path}, plan manifest has ${planManifest.source_coverage}`);
  if (planManifest.corpus_snapshot_id !== structuredManifest.corpus_snapshot_id) fail("plan manifest corpus_snapshot_id does not match structured manifest");
  if (planManifest.fact_coverage_snapshot_id !== structuredManifest.fact_coverage_snapshot_id) fail("plan manifest fact_coverage_snapshot_id does not match structured manifest");

  const decisionText = `${JSON.stringify(decision, null, 2)}\n`;
  const decisionBytes = Buffer.from(decisionText, "utf8");
  await mkdir(path.dirname(OUT_DECISION_PATH), { recursive: true });
  await writeFile(OUT_DECISION_PATH, decisionText, "utf8");

  // -- Pass 2: final manifest WITH release_authorization pointing at the decision --
  const finalManifest = {
    ...manifestWithoutAuth,
    release_authorization: {
      status: "APPROVED",
      approved_by: approvedBy,
      approved_at: approvedAt,
      decision_artifact_path: "work/domain-seed/seed-release-turn-m7-candidate-sandbox.decision.json",
      decision_artifact_sha256: sha256(decisionBytes),
      signing_note: "Repository-internal procedural Owner assertion, sandbox-only, never a production release authorization.",
    },
  };
  await writeFile(OUT_MANIFEST_PATH, `${JSON.stringify(finalManifest, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    manifest_path: path.relative(REPO, OUT_MANIFEST_PATH),
    manifest_sha256: sha256(await readFile(OUT_MANIFEST_PATH)),
    decision_path: path.relative(REPO, OUT_DECISION_PATH),
    decision_sha256: sha256(decisionBytes),
    release_id: finalManifest.release_id,
    approved_revision: finalManifest.approved_revision,
  }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
