// Builds the v0.17 APPROVED release bundle: a new canonical release
// manifest + a new JSON decision artifact binding the v0.5 structured
// manifest (with its new CHAIN_MANIFEST role) AND the v0.5 Thin plan --
// closing both Codex-review findings (plan outside the trust boundary,
// Chain artifact absent from the release bundle). v0.16's manifest/decision
// are never modified; this is a new, independent revision.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalManifestBindingHash } from "../domain/adapters/seed-runtime-service-adapters.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APPROVED_AT = new Date().toISOString();
const APPROVED_BY = "최재완";
const CORPUS_SNAPSHOT_ID = "corpus_04750795e1a2d5c3";

const CANONICAL_OUT = "domain/releases/seed-release.v0.17.manifest.json";
const DECISION_OUT = "domain/releases/seed-release.v0.17.decision.json";
const STRUCTURED_MANIFEST = "work/domain-seed/seed-structured-artifacts.v0.5.manifest.json";
const PLAN_PATH = "work/domain-seed/seed-thin-flow-plans.v0.5.jsonl";
const PLAN_MANIFEST_PATH = "work/domain-seed/seed-thin-flow-plans.v0.5.manifest.json";

function sha256(buffer) { return createHash("sha256").update(buffer).digest("hex"); }
async function readAbs(p) { return readFile(path.join(REPO, p)); }
async function sha256OfFile(p) { return sha256(await readAbs(p)); }
async function readJsonAbs(p) { return JSON.parse((await readAbs(p)).toString("utf8")); }
function pinArtifacts(artifacts) { return artifacts.map((a) => ({ role: a.role, path: a.path, sha256: a.sha256, record_count: a.record_count ?? null })); }

async function main() {
  const structuredManifest = await readJsonAbs(STRUCTURED_MANIFEST);
  if (structuredManifest.status !== "VERIFIED_SEED_SUBSET") throw new Error("structured manifest is not VERIFIED_SEED_SUBSET");
  if (structuredManifest.excluded_question_ids.length !== 0) throw new Error("structured manifest still excludes questions");
  const chainRole = structuredManifest.artifacts.find((a) => a.role === "CHAIN_MANIFEST");
  if (!chainRole) throw new Error("structured manifest is missing CHAIN_MANIFEST -- Codex finding #2 not actually closed");

  const planManifest = await readJsonAbs(PLAN_MANIFEST_PATH);
  if (planManifest.record_count !== 25) throw new Error(`expected 25 plan records, found ${planManifest.record_count}`);
  const planBytes = await readAbs(PLAN_PATH);
  const planRecordCount = planBytes.toString("utf8").trim().split("\n").length;
  if (planRecordCount !== 25) throw new Error(`plan file line count ${planRecordCount} != 25`);

  const canonicalDocIrBase = "work/domain-seed/seed-canonical-document-ir.v0.6.jsonl";
  const canonicalDocIrDelta = "work/domain-seed/seed-canonical-document-ir.v0.15.delta.jsonl";
  const goldPath = "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl";
  const coveragePath = "work/domain-seed/seed-fact-coverage-verified.v0.5.json";

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
    release_id: "seed-release-v0.17",
    release_status: "APPROVED",
    corpus_snapshot_id: CORPUS_SNAPSHOT_ID,
    artifacts: canonicalArtifactsBase,
    approved_revision: structuredManifest.artifact_set_id,
    supersedes: "domain/releases/seed-release.v0.16.manifest.json",
    supersession_note:
      "Codex 독립 검수 결함 2건 보완: (1) Thin plan을 release decision에 결합(경로+SHA+record_count+corpus/coverage snapshot id+source_gold/source_coverage 고정), "
      + "(2) Chain artifact(16건)를 structured manifest에 포함하고 Event/Relation chain_id 참조 무결성을 Runtime 구성 시 검증. "
      + "Fact/Coverage/Evidence는 Q02/Q04/Q05/Q10 metric-fail 원인조사로 식별된 6건 신규 grounding 데이터 포함(seed-structured-owner-decision.v0.5).",
  };

  const canonicalContentHash = canonicalManifestBindingHash(canonicalBase);
  const structuredManifestBytes = await readAbs(STRUCTURED_MANIFEST);
  const structuredContentHash = sha256(structuredManifestBytes);
  const planHash = sha256(planBytes);
  const planManifestHash = await sha256OfFile(PLAN_MANIFEST_PATH);
  const goldHash = canonicalArtifactsBase.find((a) => a.role === "SEED_GOLD").sha256;
  const coverageHash = structuredManifest.artifacts.find((a) => a.role === "FACT_COVERAGE_SNAPSHOT").sha256;

  const decision = {
    schema_version: "0.2.0",
    decision_id: "seed-release-v0.17-decision",
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
    // --- Codex finding #1: Thin plan binding -----------------------
    thin_plan: { path: PLAN_PATH, sha256: planHash, record_count: planRecordCount },
    thin_plan_manifest: { path: PLAN_MANIFEST_PATH, sha256: planManifestHash },
    thin_plan_source_gold: { path: goldPath, sha256: goldHash },
    thin_plan_source_coverage: { path: coveragePath, sha256: coverageHash },
    basis:
      "seed-structured-owner-decision-v0.5 (88/88 APPROVE, Owner: 최재완) + scripts/promote-seed-structured-artifacts-v04.mjs + "
      + "scripts/build-and-promote-seed-fact-batch-v05.mjs promotions (referential closure verified, official schema validation passed) + "
      + "Codex 독립 검수 결함 2건(plan binding, chain binding) 보완. "
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
    release_id: canonicalBase.release_id,
    fact_coverage_snapshot_id: decision.fact_coverage_snapshot_id,
  }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
