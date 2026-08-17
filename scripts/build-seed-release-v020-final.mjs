#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalManifestBindingHash } from "../domain/adapters/seed-runtime-service-adapters.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APPROVED_AT = "2026-08-17T23:07:20Z";
const CANDIDATE_MANIFEST_PATH = "domain/releases/seed-release.v0.20-r3.candidate.manifest.json";
const CANDIDATE_BINDING_PATH = "domain/releases/seed-release.v0.20-r3.candidate.binding-decision.json";
const OWNER_DECISION_PATH = "domain/releases/seed-release.v0.20-r3.candidate.owner-decision.approved.json";
const CLEAN_CLONE_GATE_PATH = "domain/releases/seed-release.v0.20-r3.candidate.RELEASE_GATE_STATUS.v0.3.json";
const BUNDLE_MANIFEST_PATH = "domain/releases/bundles/seed-release-v0.20-r3.candidate/bundle-manifest.json";
const FINAL_MANIFEST_PATH = "domain/releases/seed-release.v0.20.manifest.json";
const FINAL_DECISION_PATH = "domain/releases/seed-release.v0.20.decision.json";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = async (relativePath) => JSON.parse(await readFile(path.join(ROOT, relativePath), "utf8"));
const readSha = async (relativePath) => sha256(await readFile(path.join(ROOT, relativePath)));

export async function buildSeedReleaseV020Final({ writeOutputs = true } = {}) {
  const [candidateManifest, candidateBinding, ownerDecision, cleanCloneGate, bundleManifest] = await Promise.all([
    readJson(CANDIDATE_MANIFEST_PATH), readJson(CANDIDATE_BINDING_PATH), readJson(OWNER_DECISION_PATH),
    readJson(CLEAN_CLONE_GATE_PATH), readJson(BUNDLE_MANIFEST_PATH),
  ]);
  if (candidateManifest.release_status !== "CANDIDATE" || candidateManifest.release_id !== "seed-release-v0.20-r3-candidate") {
    throw new Error("v0.20 final build requires the reviewed r3 Candidate manifest");
  }
  if (ownerDecision.status !== "APPROVED" || !Object.values(ownerDecision.checklist ?? {}).every((value) => value === true)) {
    throw new Error("v0.20 final build requires the five-item Owner approval");
  }
  if (cleanCloneGate.gates?.official_clean_clone !== "PASS" || cleanCloneGate.overall !== "READY_FOR_FINAL_RELEASE_AUTHORIZATION") {
    throw new Error("v0.20 final build requires a passing official clean-clone gate");
  }
  if (bundleManifest.status !== "CANDIDATE" || bundleManifest.release_id !== candidateManifest.release_id) {
    throw new Error("v0.20 final build requires the exact r3 Candidate bundle");
  }

  const finalManifestWithoutAuthorization = {
    ...candidateManifest,
    release_id: "seed-release-v0.20",
    release_status: "APPROVED",
    supersedes: "domain/releases/seed-release.v0.19.manifest.json",
    supersession_note: "Owner가 검수한 v0.20-r3 Candidate의 데이터·clean Plan v0.13·응답 출력·Q18 정보한계 정책을 그대로 최종 승인한다. r3 bundle bytes는 변경하지 않으며 별도 final decision이 bundle manifest, Candidate Owner decision, official clean-clone gate를 외부 pin한다. v0.19 이하와 모든 Candidate 감사 이력은 수정하지 않는다.",
  };
  delete finalManifestWithoutAuthorization.release_authorization;

  const finalDecision = {
    ...candidateBinding,
    decision_id: "seed-release-v0.20-decision",
    status: "APPROVED",
    approved_by: "최재완",
    approved_at: APPROVED_AT,
    release_id: "seed-release-v0.20",
    canonical_release_manifest: {
      path: FINAL_MANIFEST_PATH,
      sha256: canonicalManifestBindingHash(finalManifestWithoutAuthorization),
    },
    bundle_manifest: {
      path: BUNDLE_MANIFEST_PATH,
      sha256: await readSha(BUNDLE_MANIFEST_PATH),
    },
    candidate_owner_decision: {
      path: OWNER_DECISION_PATH,
      sha256: await readSha(OWNER_DECISION_PATH),
    },
    official_clean_clone_gate: {
      path: CLEAN_CLONE_GATE_PATH,
      sha256: await readSha(CLEAN_CLONE_GATE_PATH),
      source_commit: cleanCloneGate.subject_source_commit,
      status: "PASS",
    },
    owner_authorization: {
      instruction: "이어서작업해줘",
      scope: "CREATE_FINAL_V020_AND_BIND_LOCAL_PRODUCTION_RUNTIME",
      push_authorized: false,
      deployment_authorized: false,
    },
    basis: "The reviewed r3 Candidate, five-item Owner approval, and official clean-clone gate all pass. This decision authorizes final v0.20 construction and local production binding, but not push or deployment.",
    signing_note: "Repository-internal procedural Owner assertion, not a cryptographic signature. The external bundle-manifest SHA pin prevents the Candidate bundle from approving itself.",
  };
  const decisionBytes = Buffer.from(`${JSON.stringify(finalDecision, null, 2)}\n`, "utf8");
  const finalManifest = {
    ...finalManifestWithoutAuthorization,
    release_authorization: {
      status: "APPROVED",
      approved_by: finalDecision.approved_by,
      approved_at: finalDecision.approved_at,
      decision_artifact_path: FINAL_DECISION_PATH,
      decision_artifact_sha256: sha256(decisionBytes),
      signing_note: "Repository-internal procedural Owner assertion; the decision also pins the portable r3 bundle manifest externally.",
    },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(finalManifest, null, 2)}\n`, "utf8");

  if (writeOutputs) {
    await writeFile(path.join(ROOT, FINAL_DECISION_PATH), decisionBytes);
    await writeFile(path.join(ROOT, FINAL_MANIFEST_PATH), manifestBytes);
  }
  return Object.freeze({
    finalDecision, finalManifest, decisionBytes, manifestBytes,
    decisionSha256: sha256(decisionBytes), manifestSha256: sha256(manifestBytes),
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await buildSeedReleaseV020Final();
  console.log(JSON.stringify({
    manifest: FINAL_MANIFEST_PATH, manifest_sha256: result.manifestSha256,
    decision: FINAL_DECISION_PATH, decision_sha256: result.decisionSha256,
  }, null, 2));
}
