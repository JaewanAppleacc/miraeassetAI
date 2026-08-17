// Turn M8 Section 7: a SANDBOX-ONLY canonical release manifest + decision
// pair authorizing the Turn M8 CLEAN Plan (v0.12.clean.candidate) for a
// test-only runtime instance -- NOT a v0.20 release manifest/decision
// (forbidden this Turn), never read by domain/runtime/configured-seed-
// runtime.mjs (untouched, still points at v0.19). Reuses Turn M7's
// structured-artifacts.v0.7.manifest.json UNCHANGED (Facts v0.8/
// Coverage v0.7/Evidence v0.9/Events/Relations/Chain/merged Owner
// decision v0.10 -- none of that changes this Turn, only the Plan does)
// -- only thin_plan/thin_plan_manifest differ from Turn M7's own sandbox
// chain.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalManifestBindingHash } from "../domain/adapters/seed-runtime-service-adapters.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const V19_MANIFEST_PATH = path.join(REPO, "domain/releases/seed-release.v0.19.manifest.json");
const STRUCTURED_MANIFEST_V07_PATH = path.join(REPO, "work/domain-seed/seed-structured-artifacts.v0.7.manifest.json");
const PLAN_V12_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.12.clean.candidate.jsonl");
const PLAN_V12_MANIFEST_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.12.clean.candidate.manifest.json");
const GOLD_PATH = path.join(REPO, "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl");

const OUT_MANIFEST_PATH = path.join(REPO, "work/domain-seed/seed-release-turn-m8-clean-plan-sandbox.manifest.json");
const OUT_DECISION_PATH = path.join(REPO, "work/domain-seed/seed-release-turn-m8-clean-plan-sandbox.decision.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function fail(msg) { throw new Error(`M8_SANDBOX_RELEASE_BLOCKED: ${msg}`); }

async function main() {
  const v19Manifest = JSON.parse((await readFile(V19_MANIFEST_PATH)).toString("utf8"));
  const structuredManifestBytes = await readFile(STRUCTURED_MANIFEST_V07_PATH);
  const structuredManifest = JSON.parse(structuredManifestBytes.toString("utf8"));
  if (structuredManifest.artifact_set_id !== "seed-structured-artifacts-v0.7") fail("structured manifest v0.7 has unexpected artifact_set_id");

  const planBytes = await readFile(PLAN_V12_PATH);
  const planManifestBytes = await readFile(PLAN_V12_MANIFEST_PATH);
  const planManifest = JSON.parse(planManifestBytes.toString("utf8"));
  const planRecordCount = planBytes.toString("utf8").trim().split("\n").filter(Boolean).length;
  if (planRecordCount !== planManifest.record_count) fail(`plan v0.12 record count mismatch`);
  if (planManifest.corpus_snapshot_id !== structuredManifest.corpus_snapshot_id) fail("plan manifest corpus_snapshot_id mismatch");
  if (planManifest.fact_coverage_snapshot_id !== structuredManifest.fact_coverage_snapshot_id) fail("plan manifest fact_coverage_snapshot_id mismatch");

  const goldBytes = await readFile(GOLD_PATH);
  const canonicalDocIrBase = v19Manifest.artifacts.find((a) => a.role === "CANONICAL_DOCUMENT_IR_BASE");
  const canonicalDocIrDelta = v19Manifest.artifacts.find((a) => a.role === "CANONICAL_DOCUMENT_IR_DELTA");
  const seedGold = v19Manifest.artifacts.find((a) => a.role === "SEED_GOLD");
  if (seedGold.sha256 !== sha256(goldBytes)) fail("Gold file has changed since v0.19 -- refusing to reuse a stale pin");

  const approvedAt = new Date().toISOString();
  const approvedBy = "최재완";

  const manifestWithoutAuth = {
    schema_version: "0.1.0",
    release_id: "seed-release-turn-m8-clean-plan-sandbox",
    release_status: "SANDBOX_TEST_ONLY_NOT_A_RELEASE",
    corpus_snapshot_id: v19Manifest.corpus_snapshot_id,
    artifacts: [canonicalDocIrBase, canonicalDocIrDelta, seedGold],
    approved_revision: "seed-structured-artifacts-v0.7",
    supersedes: null,
    supersession_note: "이 파일은 v0.20 release manifest가 아니며 official release 계보에 속하지 않는다. Turn M8 Section 7의 clean-Plan Candidate Runtime 통합 검증(wire r12)에서만 사용되는 임시 authorization 체인이다. domain/runtime/configured-seed-runtime.mjs는 이 파일을 참조하지 않으며 계속 v0.19를 가리킨다. Turn M7의 sandbox 체인(seed-release-turn-m7-candidate-sandbox.*)과의 유일한 차이는 thin_plan -- v0.11(오염된 Candidate 계보)이 아니라 v0.12.clean(v0.6 기반)을 가리킨다.",
  };
  const bindingHash = canonicalManifestBindingHash(manifestWithoutAuth);

  const decision = {
    schema_version: "0.3.0",
    decision_id: "seed-release-turn-m8-clean-plan-sandbox-decision",
    status: "APPROVED",
    approved_by: approvedBy,
    approved_at: approvedAt,
    release_id: manifestWithoutAuth.release_id,
    approved_revision: structuredManifest.artifact_set_id,
    corpus_snapshot_id: v19Manifest.corpus_snapshot_id,
    fact_coverage_snapshot_id: structuredManifest.fact_coverage_snapshot_id,
    canonical_release_manifest: { path: "work/domain-seed/seed-release-turn-m8-clean-plan-sandbox.manifest.json", sha256: bindingHash },
    structured_manifest: { path: "work/domain-seed/seed-structured-artifacts.v0.7.manifest.json", sha256: sha256(structuredManifestBytes) },
    canonical_artifacts: [canonicalDocIrBase, canonicalDocIrDelta, seedGold],
    structured_artifacts: structuredManifest.artifacts,
    thin_plan: { path: "work/domain-seed/seed-thin-flow-plans.v0.12.clean.candidate.jsonl", sha256: sha256(planBytes), record_count: planRecordCount },
    thin_plan_manifest: { path: "work/domain-seed/seed-thin-flow-plans.v0.12.clean.candidate.manifest.json", sha256: sha256(planManifestBytes) },
    thin_plan_source_gold: { path: "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl", sha256: sha256(goldBytes) },
    thin_plan_source_coverage: { path: "work/domain-seed/seed-fact-coverage-verified.v0.7.json", sha256: sha256(await readFile(path.join(REPO, "work/domain-seed/seed-fact-coverage-verified.v0.7.json"))) },
    basis: "Turn M8 clean Plan (v0.6 기반, v0.7-v0.11 Candidate 계보 미상속) + Turn M7 승격 14건 Fact. Sandbox 전용 -- 공식 release 계보 아님, v0.20 아님.",
  };
  if (decision.thin_plan_source_gold.path !== planManifest.source_gold) fail("plan manifest source_gold mismatch");
  if (decision.thin_plan_source_coverage.path !== planManifest.source_coverage) fail("plan manifest source_coverage mismatch");

  const decisionText = `${JSON.stringify(decision, null, 2)}\n`;
  const decisionBytes = Buffer.from(decisionText, "utf8");
  await mkdir(path.dirname(OUT_DECISION_PATH), { recursive: true });
  await writeFile(OUT_DECISION_PATH, decisionText, "utf8");

  const finalManifest = {
    ...manifestWithoutAuth,
    release_authorization: {
      status: "APPROVED", approved_by: approvedBy, approved_at: approvedAt,
      decision_artifact_path: "work/domain-seed/seed-release-turn-m8-clean-plan-sandbox.decision.json",
      decision_artifact_sha256: sha256(decisionBytes),
      signing_note: "Repository-internal procedural Owner assertion, sandbox-only, never a production release authorization.",
    },
  };
  await writeFile(OUT_MANIFEST_PATH, `${JSON.stringify(finalManifest, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    manifest_path: path.relative(REPO, OUT_MANIFEST_PATH), manifest_sha256: sha256(await readFile(OUT_MANIFEST_PATH)),
    decision_path: path.relative(REPO, OUT_DECISION_PATH), decision_sha256: sha256(decisionBytes),
    release_id: finalManifest.release_id, approved_revision: finalManifest.approved_revision,
  }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
