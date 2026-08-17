import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createManagedSeedThinRuntime } from "../domain/runtime/seed-thin-runner.mjs";
import { readSeedRuntimeConfiguration } from "../domain/runtime/configured-seed-runtime.mjs";
import { GET as getReady } from "../app/ready/route.ts";
const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const APPROVED_CANONICAL_MANIFEST = path.join(ROOT, "tests/fixtures/seed-release.v0.11.approved.manifest.json");
const STRUCTURED_MANIFEST_WITH_CHAIN = path.join(ROOT, "tests/fixtures/seed-structured-artifacts.v01-with-chain.test-fixture.manifest.json");

test("deployment artifact configuration is resolved and pinned by value", () => {
  const env = {
    SEED_RUNTIME_ROOT: "deploy",
    SEED_STRUCTURED_MANIFEST_PATH: "manifests/structured.json",
    SEED_PLAN_PATH: "/mounted/plans.jsonl",
  };
  const configuration = readSeedRuntimeConfiguration(env, "/srv/app");
  env.SEED_RUNTIME_ROOT = "attacker";
  env.SEED_STRUCTURED_MANIFEST_PATH = "changed.json";
  assert.deepEqual(configuration, {
    root: "/srv/app/deploy",
    structuredManifestPath: "/srv/app/deploy/manifests/structured.json",
    canonicalReleaseManifestPath: undefined,
    planPath: "/mounted/plans.jsonl",
    planManifestPath: undefined,
  });
  assert.equal(Object.isFrozen(configuration), true);
});

test("deployment artifact configuration rejects ambiguous whitespace paths", () => {
  assert.throws(() => readSeedRuntimeConfiguration({ SEED_RUNTIME_ROOT: " deploy " }, "/srv/app"), /trimmed path/);
  assert.throws(() => readSeedRuntimeConfiguration({ SEED_PLAN_PATH: " plan.jsonl " }, "/srv/app"), /trimmed path/);
});

test("managed Seed Runtime exposes IDLE -> READY without leaking internals", async () => {
  const runtime = createManagedSeedThinRuntime({ root: ROOT, structuredManifestPath: STRUCTURED_MANIFEST_WITH_CHAIN, canonicalReleaseManifestPath: APPROVED_CANONICAL_MANIFEST });
  assert.deepEqual(runtime.readiness(), { status: "IDLE", ready: false, error_code: null });
  assert.equal(await runtime.initialize(), true);
  assert.deepEqual(runtime.readiness(), { status: "READY", ready: true, error_code: null });
});

test("initialization failure is visible as a stable safe code while answer execution remains fail-closed", async () => {
  const runtime = createManagedSeedThinRuntime({ root: ROOT, structuredManifestPath: path.join(ROOT, "missing.json") });
  assert.equal(await runtime.initialize(), false);
  assert.deepEqual(runtime.readiness(), { status: "FAILED", ready: false, error_code: "SEED_RUNTIME_INIT_FAILED" });
  const outcome = await runtime.run("질문", { question_id: "Q-001" });
  assert.equal(outcome.final_response.think_trace.execution_mode, "EARLY_EXIT");
  assert.equal(JSON.stringify(runtime.readiness()).includes(ROOT), false);
});

// The configured singleton now verifies and materializes the final v0.20
// portable bundle before reporting readiness.
test("GET /ready attests the final bundle-backed v0.20 configured runtime", async () => {
  const response = await getReady();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { status: "READY", ready: true, error_code: null });
});
