import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifySeedRelease } from "../scripts/verify-seed-release.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(repositoryRoot, "domain/releases/seed-release.v0.11.manifest.json");

test("Seed v0.11 release lock verifies hashes, counts, and cross references", async () => {
  const result = await verifySeedRelease({ manifestPath, root: repositoryRoot });
  assert.equal(result.release_id, "seed-release-v0.11");
  assert.equal(result.release_status, "BLOCKED_FOR_E2E");
  assert.deepEqual(result.counts, { gold: 25, evidence: 121, relations: 40, chains: 16 });
});

test("release verification fails closed when an artifact hash is changed", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "seed-release-test-"));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.artifacts[0].sha256 = "0".repeat(64);
  const tamperedManifestPath = path.join(temporaryDirectory, "manifest.json");
  await writeFile(tamperedManifestPath, `${JSON.stringify(manifest)}\n`);
  await assert.rejects(
    verifySeedRelease({ manifestPath: tamperedManifestPath, root: repositoryRoot }),
    /sha256/,
  );
});

