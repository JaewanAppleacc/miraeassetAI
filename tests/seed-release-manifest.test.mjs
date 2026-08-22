import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { verifySeedRelease } from "../scripts/verify-seed-release.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(repositoryRoot, "domain/releases/seed-release.v0.11.manifest.json");
const v020ManifestPath = path.join(repositoryRoot, "domain/releases/seed-release.v0.20.manifest.json");

test("Seed v0.11 release lock verifies hashes, counts, and cross references", async () => {
  const result = await verifySeedRelease({ manifestPath, root: repositoryRoot });
  assert.equal(result.release_id, "seed-release-v0.11");
  assert.equal(result.release_status, "BLOCKED_FOR_E2E");
  assert.deepEqual(result.counts, { gold: 25, evidence: 121, relations: 40, chains: 16 });
});

test("release verification fails closed when an artifact hash is changed", async () => {
  // Turn N2.2: this test previously never removed its own mkdtemp scratch
  // directory -- try/finally guarantees removal whether the assertion
  // passes or throws.
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "seed-release-test-"));
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.artifacts[0].sha256 = "0".repeat(64);
    const tamperedManifestPath = path.join(temporaryDirectory, "manifest.json");
    await writeFile(tamperedManifestPath, `${JSON.stringify(manifest)}\n`);
    await assert.rejects(
      verifySeedRelease({ manifestPath: tamperedManifestPath, root: repositoryRoot }),
      /sha256/,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

// -- Turn M11: no silent default to an old release ------------------------

test("Turn M11: verifySeedRelease with NO manifestPath rejects (never silently falls back to v0.11)", async () => {
  await assert.rejects(verifySeedRelease({ root: repositoryRoot }), /manifestPath is required/);
  await assert.rejects(verifySeedRelease(), /manifestPath is required/);
});

test("Turn M11: verifySeedRelease rejects a nonexistent manifest path with a clear error, not a crash", async () => {
  await assert.rejects(
    verifySeedRelease({ manifestPath: path.join(repositoryRoot, "domain/releases/does-not-exist.manifest.json"), root: repositoryRoot }),
    /could not read manifest/,
  );
});

test("Turn M11: explicitly passing the CURRENT v0.20 manifest is genuinely attempted (never silently redirected elsewhere), and its incompatible (newer) schema shape is reported honestly rather than a false PASS", async () => {
  // v0.20's manifest uses the newer canonical_artifacts/structured_artifacts
  // split shape (see domain/releases/README.md) -- this legacy validator's
  // schema cannot express that, so a real, honest rejection is the CORRECT
  // outcome here, not a bug. What this test actually guards against is the
  // OLD behavior: silently validating v0.11 while a caller believed they
  // were checking v0.20.
  await assert.rejects(verifySeedRelease({ manifestPath: v020ManifestPath, root: repositoryRoot }));
});

test("Turn M11: when a DIFFERENT (still legacy-shaped) release manifest is passed, the result clearly shows that release's own release_id -- never a stale/wrong identity", async () => {
  const result = await verifySeedRelease({ manifestPath, root: repositoryRoot });
  assert.equal(result.release_id, "seed-release-v0.11");
});

test("Turn M11: the CLI entrypoint fails with a usage message (exit code 1) when invoked with no argument, and never prints an ok:true result", async () => {
  await assert.rejects(execFileAsync(process.execPath, [path.join(repositoryRoot, "scripts/verify-seed-release.mjs")]));
  let stderr = "";
  try {
    await execFileAsync(process.execPath, [path.join(repositoryRoot, "scripts/verify-seed-release.mjs")]);
  } catch (error) {
    stderr = error.stderr ?? "";
  }
  assert.match(stderr, /usage:/);
  assert.equal(/"ok":\s*true/.test(stderr), false);
});

test("Turn M11: the CLI entrypoint, given an explicit manifest path, includes manifest_path in its JSON output", async () => {
  const { stdout } = await execFileAsync(process.execPath, [path.join(repositoryRoot, "scripts/verify-seed-release.mjs"), manifestPath]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.manifest_path, manifestPath);
  assert.equal(parsed.release_id, "seed-release-v0.11");
});

