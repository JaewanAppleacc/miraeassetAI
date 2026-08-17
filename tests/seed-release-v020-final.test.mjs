import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { assertBundleManifestBinding } from "../domain/adapters/seed-release-bundle-manifest-binding.mjs";
import { canonicalManifestBindingHash } from "../domain/adapters/seed-runtime-service-adapters.mjs";
import { createBundleBackedSeedRuntime } from "../domain/runtime/bundle-backed-seed-runtime.mjs";
import { buildSeedReleaseV020Final } from "../scripts/build-seed-release-v020-final.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const MANIFEST = "domain/releases/seed-release.v0.20.manifest.json";
const DECISION = "domain/releases/seed-release.v0.20.decision.json";
const BUNDLE_DIR = "domain/releases/bundles/seed-release-v0.20-r3.candidate";
const BUNDLE_MANIFEST = `${BUNDLE_DIR}/bundle-manifest.json`;
const COMPANY_DECISION_SHA = "01bfb35409b304b7ff2b709774b41615e3087150b90a0abfd25e5f228cd73d47";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("final v0.20 builder is deterministic and matches the committed output files", async () => {
  const built = await buildSeedReleaseV020Final({ writeOutputs: false });
  assert.deepEqual(await readFile(path.join(ROOT, MANIFEST)), built.manifestBytes);
  assert.deepEqual(await readFile(path.join(ROOT, DECISION)), built.decisionBytes);
});

test("final manifest and decision mutually bind the exact approved revision and canonical content", async () => {
  const manifestBytes = await readFile(path.join(ROOT, MANIFEST));
  const decisionBytes = await readFile(path.join(ROOT, DECISION));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const decision = JSON.parse(decisionBytes.toString("utf8"));
  assert.equal(manifest.release_id, "seed-release-v0.20");
  assert.equal(manifest.release_status, "APPROVED");
  assert.equal(manifest.approved_revision, "seed-structured-artifacts-v0.7");
  assert.equal(manifest.release_authorization.decision_artifact_sha256, sha256(decisionBytes));
  assert.equal(decision.canonical_release_manifest.sha256, canonicalManifestBindingHash(manifest));
  assert.equal(decision.owner_authorization.push_authorized, false);
  assert.equal(decision.owner_authorization.deployment_authorized, false);
});

test("final decision externally pins the real r3 bundle manifest", async () => {
  const decision = JSON.parse(await readFile(path.join(ROOT, DECISION), "utf8"));
  const result = await assertBundleManifestBinding(decision, path.join(ROOT, BUNDLE_MANIFEST), ROOT);
  assert.equal(result.bundleManifest.status, "CANDIDATE");
  assert.equal(result.bundleManifest.release_id, "seed-release-v0.20-r3-candidate");
});

test("bundle-backed production Runtime reaches READY and preserves the Q18 information limit", async () => {
  const runtime = createBundleBackedSeedRuntime({
    root: ROOT,
    bundleDir: path.join(ROOT, BUNDLE_DIR),
    bundleManifestPath: path.join(ROOT, BUNDLE_MANIFEST),
    finalManifestPath: path.join(ROOT, MANIFEST),
    finalDecisionPath: path.join(ROOT, DECISION),
    expectedReleaseId: "seed-release-v0.20",
    expectedApprovedRevision: "seed-structured-artifacts-v0.7",
    expectedCompanyDirectoryOwnerDecisionSha256: COMPANY_DECISION_SHA,
  });
  assert.equal(await runtime.initialize(), true);
  assert.deepEqual(runtime.readiness(), { status: "READY", ready: true, error_code: null });
  const outcome = await runtime.run(
    "한화오션이 2024년 6월 14일 결정한 유상증자는 7월 10일 정정 후 실제로 발행까지 완료됐는가? 정정 후 발행 주식 수와 금액도 알려줘.",
    { question_id: "question_seed_v07_18" },
  );
  assert.equal(outcome.final_response.think_trace.execution_mode, "STRUCTURED");
  assert.match(outcome.final_response.answer, /54,495주/);
  assert.match(outcome.final_response.answer, /40,350원/);
  assert.match(outcome.final_response.answer, /발행총액은 원문에서 직접 공시된 항목으로 확인되지 않습니다/);
  assert.doesNotMatch(outcome.final_response.answer, /2,198,873,250\s*원(은|이)?\s*발행총액/);
});

test("bundle-backed Runtime fails closed when the expected production release identity is wrong", async () => {
  const runtime = createBundleBackedSeedRuntime({
    root: ROOT,
    bundleDir: path.join(ROOT, BUNDLE_DIR),
    bundleManifestPath: path.join(ROOT, BUNDLE_MANIFEST),
    finalManifestPath: path.join(ROOT, MANIFEST),
    finalDecisionPath: path.join(ROOT, DECISION),
    expectedReleaseId: "seed-release-v0.19",
    expectedApprovedRevision: "seed-structured-artifacts-v0.7",
    expectedCompanyDirectoryOwnerDecisionSha256: COMPANY_DECISION_SHA,
  });
  assert.equal(await runtime.initialize(), false);
  assert.deepEqual(runtime.readiness(), { status: "FAILED", ready: false, error_code: "SEED_RUNTIME_INIT_FAILED" });
});
