// Historical/supersession record for the v0.4-promoted, Owner-approved
// v0.16 release bundle (domain/releases/seed-release.v0.16.manifest.json +
// seed-release.v0.16.decision.json). The v0.16/v0.4 pair is left byte-
// identical on disk (never overwritten -- see tests/seed-release-v017.test.mjs
// for its superseding replacement, which covers the same positive-path
// assertions this file used to make: promoted counts, row=16/17 evidence
// swap, and the release-authorization gate). This file now documents,
// rather than hides, the expected consequence of the plan+chain hardening
// added to domain/adapters/seed-runtime-service-adapters.mjs after v0.16
// was approved: v0.16's decision artifact was minted before Thin plan and
// CHAIN_MANIFEST binding existed, so it does not (and structurally cannot,
// without being re-approved) carry those pins -- construction now refuses
// it with a structural error, not a silent pass-through, and that refusal
// itself is the thing under test here.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createSeedRuntimeServiceAdapters } from "../domain/adapters/seed-runtime-service-adapters.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);

test("the v0.16/v0.4 bundle, approved before Thin-plan/Chain binding existed, can no longer construct without those pins", async () => {
  await assert.rejects(
    createSeedRuntimeServiceAdapters({
      structuredManifestPath: path.join(ROOT, "work/domain-seed/seed-structured-artifacts.v0.4.manifest.json"),
      canonicalReleaseManifestPath: path.join(ROOT, "domain/releases/seed-release.v0.16.manifest.json"),
    }),
    /planPath is required/,
  );
});

test("supplying real v0.1-era plan paths still refuses v0.16, because its decision artifact was never bound to any plan", async () => {
  await assert.rejects(
    createSeedRuntimeServiceAdapters({
      structuredManifestPath: path.join(ROOT, "work/domain-seed/seed-structured-artifacts.v0.4.manifest.json"),
      canonicalReleaseManifestPath: path.join(ROOT, "domain/releases/seed-release.v0.16.manifest.json"),
      planPath: path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.4.jsonl"),
      planManifestPath: path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.4.manifest.json"),
      root: ROOT,
    }),
    (error) => {
      assert.equal(error.code, "RELEASE_NOT_APPROVED");
      assert.match(error.message, /thin_plan/);
      return true;
    },
  );
});

test("the v0.16/v0.4 artifacts on disk remain untouched by this hardening (structured store still reports the pre-hardening counts when read directly)", async () => {
  const { readFile } = await import("node:fs/promises");
  const manifest = JSON.parse(await readFile(path.join(ROOT, "work/domain-seed/seed-structured-artifacts.v0.4.manifest.json"), "utf8"));
  assert.equal(manifest.artifacts.some((a) => a.role === "CHAIN_MANIFEST"), false);
  const facts = manifest.artifacts.find((a) => a.role === "VERIFIED_FACT");
  assert.equal(facts.record_count, 67);
  const evidence = manifest.artifacts.find((a) => a.role === "VERIFIED_EVIDENCE");
  assert.equal(evidence.record_count, 213);
});
