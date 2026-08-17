// Builds the APPROVED release bundle for the v0.4-promoted structured
// artifacts: a new canonical release manifest (v0.16), a new machine-
// readable JSON release decision artifact, and the release_authorization
// block binding them together -- in the exact shape
// domain/adapters/seed-runtime-service-adapters.mjs's assertReleaseAuthorized
// requires (see domain/releases/README.md's "Release authorization:
// decision artifact 계약" section). No Git signature: approved_by is a
// procedural, repository-internal Owner assertion, not a cryptographic
// signature -- documented limitation, not implemented here.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalManifestBindingHash } from "../domain/adapters/seed-runtime-service-adapters.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APPROVED_AT = new Date().toISOString();
const APPROVED_BY = "최재완";
const CORPUS_SNAPSHOT_ID = "corpus_04750795e1a2d5c3";

const CANONICAL_OUT = "domain/releases/seed-release.v0.16.manifest.json";
const DECISION_OUT = "domain/releases/seed-release.v0.16.decision.json";
const STRUCTURED_MANIFEST = "work/domain-seed/seed-structured-artifacts.v0.4.manifest.json";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
async function readAbs(relPath) {
  return readFile(path.join(REPO, relPath));
}
async function sha256OfFile(relPath) {
  return sha256(await readAbs(relPath));
}
async function readJsonAbs(relPath) {
  return JSON.parse((await readAbs(relPath)).toString("utf8"));
}
function pinArtifacts(artifacts) {
  return artifacts.map((a) => ({ role: a.role, path: a.path, sha256: a.sha256, record_count: a.record_count ?? null }));
}

async function main() {
  const structuredManifest = await readJsonAbs(STRUCTURED_MANIFEST);
  if (structuredManifest.status !== "VERIFIED_SEED_SUBSET") throw new Error("structured manifest is not VERIFIED_SEED_SUBSET -- refusing to build a release bundle around it");
  if (structuredManifest.excluded_question_ids.length !== 0) throw new Error("structured manifest still excludes questions -- refusing");

  // --- 1. Canonical release manifest v0.16 content, WITHOUT
  // release_authorization yet (that block references the decision
  // artifact's hash, which in turn references THIS manifest's binding
  // hash computed over this exact pre-authorization content -- see
  // canonicalManifestBindingHash's own header comment for why the order
  // must be this way). Same corpus DocumentIR shards as the still-unapproved
  // v0.15 draft (no new documents needed for this promotion); SEED_GOLD
  // points at the newly-promoted, Owner-approved v0.17 Gold.
  const canonicalDocIrBase = "work/domain-seed/seed-canonical-document-ir.v0.6.jsonl";
  const canonicalDocIrDelta = "work/domain-seed/seed-canonical-document-ir.v0.15.delta.jsonl";
  const goldPath = "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl";

  const canonicalArtifactsBase = [
    { role: "CANONICAL_DOCUMENT_IR_BASE", path: canonicalDocIrBase, sha256: await sha256OfFile(canonicalDocIrBase), bytes: (await readAbs(canonicalDocIrBase)).length, record_count: 54 },
    { role: "CANONICAL_DOCUMENT_IR_DELTA", path: canonicalDocIrDelta, sha256: await sha256OfFile(canonicalDocIrDelta), bytes: (await readAbs(canonicalDocIrDelta)).length, record_count: 14 },
    { role: "SEED_GOLD", path: goldPath, sha256: await sha256OfFile(goldPath), bytes: (await readAbs(goldPath)).length, record_count: 25 },
  ];

  const canonicalBase = {
    schema_version: "0.1.0",
    release_id: "seed-release-v0.16",
    release_status: "APPROVED",
    corpus_snapshot_id: CORPUS_SNAPSHOT_ID,
    artifacts: canonicalArtifactsBase,
    approved_revision: structuredManifest.artifact_set_id,
    e2e_readiness_note:
      "82/82 v0.4 structured review packet 항목 APPROVE(seed-structured-owner-decision-v0.4). Q3/Q22 포함 25/25 질문 승인. "
      + "excluded_question_ids=[]. row=16(evidence_3af676a5...) 제거, row=17(evidence_c0b7c71e...) 승격.",
  };

  const canonicalContentHash = canonicalManifestBindingHash(canonicalBase);
  const structuredManifestBytes = await readAbs(STRUCTURED_MANIFEST);
  const structuredContentHash = sha256(structuredManifestBytes);

  // --- 2. Decision artifact: machine-readable JSON, not Markdown. Pins
  // path+hash of both manifests, both snapshot ids, release_id, approved
  // revision, and every artifact's role/path/sha256/record_count in both
  // manifests -- exactly what assertDecisionBindsReleaseBundle requires.
  const decision = {
    schema_version: "0.1.0",
    decision_id: "seed-release-v0.16-decision",
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
    basis:
      "seed-structured-owner-decision-v0.4 (82/82 APPROVE, Owner: 최재완) + scripts/promote-seed-structured-artifacts-v04.mjs promotion "
      + "(referential closure verified, official schema validation passed for Evidence/Fact/Event/Coverage). "
      + "signing_limitation: approved_by는 암호학적 서명이 아니라 저장소 내부 절차적 Owner assertion이다 "
      + "(domain/releases/README.md 'Release Gate: 승인 신원의 한계와 최종 신뢰 anchor' 절 참조). "
      + "최종 배포 신뢰 anchor는 protected branch 리뷰 또는 서명된 release tag/commit이며 이 decision artifact가 아니다.",
  };
  const decisionText = `${JSON.stringify(decision, null, 2)}\n`;
  await writeFile(path.join(REPO, DECISION_OUT), decisionText, "utf8");
  const decisionHash = sha256(Buffer.from(decisionText, "utf8"));

  // --- 3. Final canonical manifest: base content + the authorization
  // block pointing at the decision artifact just written.
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
    canonical_content_hash_bound_by_decision: canonicalContentHash,
    structured_manifest_hash_bound_by_decision: structuredContentHash,
    release_id: canonicalBase.release_id,
    approved_revision: canonicalBase.approved_revision,
    fact_coverage_snapshot_id: decision.fact_coverage_snapshot_id,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
