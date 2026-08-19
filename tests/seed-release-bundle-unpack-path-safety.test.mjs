// Turn M11: fail-closed path-safety hardening for unpackReleaseBundle.
// An independent review reproduced a real gap: a bundle-manifest.json
// entry whose source_path was "../../escaped.txt" caused unpackReleaseBundle
// to write a file OUTSIDE destRoot with no rejection at all (PoC run in a
// disposable scratch directory, never against this repo). This file adds
// the synthetic negative fixtures for the fix before any implementation
// change, plus a regression check against the real, committed v0.20-r3
// bundle.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildReleaseBundle } from "../domain/adapters/seed-release-bundle-builder.mjs";
import { unpackReleaseBundle, KNOWN_BUNDLE_ROLES_BY_SCHEMA_VERSION } from "../domain/adapters/seed-release-bundle-unpack.mjs";
import { assertSafeManifestRelativePath, resolveWithinBase, assertNoSymlinkInAncestry } from "../domain/adapters/bundle-manifest-path-safety.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

async function fileExists(p) {
  try { await readFile(p); return true; } catch { return false; }
}
async function dirIsEmptyOrMissing(p) {
  try { return (await readdir(p)).length === 0; } catch { return true; }
}

let bundleDirAbs; let realManifestBytes; let realManifest;
test.before(async () => {
  bundleDirAbs = await mkdtemp(path.join(ROOT, "work", "bundle-path-safety-test-src-"));
  await buildReleaseBundle({
    bundleDir: path.relative(ROOT, bundleDirAbs), status: "CANDIDATE", root: ROOT,
    structuredManifestPath: "work/domain-seed/seed-structured-artifacts.v0.6.manifest.json",
    canonicalReleaseManifestPath: "domain/releases/seed-release.v0.19.manifest.json",
    planPath: "work/domain-seed/seed-thin-flow-plans.v0.6.jsonl",
    planManifestPath: "work/domain-seed/seed-thin-flow-plans.v0.6.manifest.json",
    expectedReleaseId: "seed-release-v0.19", expectedApprovedRevision: "seed-structured-artifacts-v0.6",
    companyDirectoryArtifactPath: "work/domain-seed/seed-company-directory.v0.2.approved.jsonl",
    companyDirectoryManifestPath: "work/domain-seed/seed-company-directory.v0.2.approved.manifest.json",
    companyDirectoryOwnerDecisionPath: "work/domain-seed/seed-company-directory-owner-decision.v0.2.approved.json",
    timelinePolicyDecisionPath: "work/domain-seed/seed-timeline-fact-narrative-policy-decision.v0.1.json",
  });
  realManifestBytes = await readFile(path.join(bundleDirAbs, "bundle-manifest.json"));
  realManifest = JSON.parse(realManifestBytes.toString("utf8"));
});
test.after(async () => { await rm(bundleDirAbs, { recursive: true, force: true }); });

const manifestFilePath = () => path.join(bundleDirAbs, "bundle-manifest.json");

async function withMutatedManifest(mutateFn, run) {
  const mutated = mutateFn(JSON.parse(JSON.stringify(realManifest)));
  await writeFile(manifestFilePath(), JSON.stringify(mutated));
  try {
    await run();
  } finally {
    await writeFile(manifestFilePath(), realManifestBytes);
  }
}

function cloneEntry(manifest, role) {
  const entry = manifest.entries.find((e) => e.role === role);
  if (!entry) throw new Error(`test setup: no entry with role ${role} in the real manifest`);
  return JSON.parse(JSON.stringify(entry));
}

// -- shared helper unit tests (isolated from filesystem/bundle setup) -----

test("Turn M11: assertSafeManifestRelativePath rejects an absolute path", () => {
  assert.throws(() => assertSafeManifestRelativePath("/etc/passwd", "test"), /absolute/);
});
test("Turn M11: assertSafeManifestRelativePath rejects a '..' segment anywhere in the path", () => {
  assert.throws(() => assertSafeManifestRelativePath("../escaped.txt", "test"), /\.\./);
  assert.throws(() => assertSafeManifestRelativePath("a/../../escaped.txt", "test"), /\.\./);
  assert.throws(() => assertSafeManifestRelativePath("a/b/../../../escaped.txt", "test"), /\.\./);
});
test("Turn M11: assertSafeManifestRelativePath rejects empty and current-directory-only paths", () => {
  assert.throws(() => assertSafeManifestRelativePath("", "test"));
  assert.throws(() => assertSafeManifestRelativePath(".", "test"));
  assert.throws(() => assertSafeManifestRelativePath("./", "test"));
});
test("Turn M11: assertSafeManifestRelativePath accepts a genuine nested relative path", () => {
  assert.equal(assertSafeManifestRelativePath("work/domain-seed/seed-facts-verified.v0.8.jsonl", "test"), "work/domain-seed/seed-facts-verified.v0.8.jsonl");
});
test("Turn M11 counterexample/defense-in-depth: resolveWithinBase independently rejects an escaping path even given an already-normalized string", () => {
  assert.throws(() => resolveWithinBase("/tmp/base", "../escaped.txt", "test"), /outside/);
});
test("Turn M11: resolveWithinBase accepts a path that stays within base", () => {
  const resolved = resolveWithinBase("/tmp/base", "a/b.txt", "test");
  assert.equal(resolved, path.resolve("/tmp/base/a/b.txt"));
});

// -- end-to-end unpackReleaseBundle path-safety (items 1-13) --------------

test("Turn M11: bundle_path absolute path is rejected", async () => {
  const destRoot = await mkdtemp(path.join(ROOT, "work", "bps-test-dest-"));
  try {
    await withMutatedManifest((m) => {
      m.entries[0].bundle_path = "/tmp/absolute-bundle-path.raw";
      return m;
    }, async () => {
      await assert.rejects(unpackReleaseBundle({ bundleDir: bundleDirAbs, destRoot }), /absolute/);
    });
  } finally { await rm(destRoot, { recursive: true, force: true }); }
});

test("Turn M11: source_path absolute path is rejected", async () => {
  const destRoot = await mkdtemp(path.join(ROOT, "work", "bps-test-dest-"));
  try {
    await withMutatedManifest((m) => {
      m.entries[0].source_path = "/tmp/absolute-source-path.txt";
      return m;
    }, async () => {
      await assert.rejects(unpackReleaseBundle({ bundleDir: bundleDirAbs, destRoot }), /absolute/);
    });
  } finally { await rm(destRoot, { recursive: true, force: true }); }
});

test("Turn M11: bundle_path containing '..' is rejected", async () => {
  const destRoot = await mkdtemp(path.join(ROOT, "work", "bps-test-dest-"));
  try {
    await withMutatedManifest((m) => {
      m.entries[0].bundle_path = "../../escaped-bundle-path.raw";
      return m;
    }, async () => {
      await assert.rejects(unpackReleaseBundle({ bundleDir: bundleDirAbs, destRoot }), /\.\./);
    });
  } finally { await rm(destRoot, { recursive: true, force: true }); }
});

test("Turn M11 (the exact reproduced defect): source_path containing '..' is rejected, and no file is written outside destRoot", async () => {
  const destRoot = await mkdtemp(path.join(ROOT, "work", "bps-test-dest-"));
  const escapedTarget = path.resolve(destRoot, "..", "escaped-by-source-path.txt");
  try {
    await withMutatedManifest((m) => {
      m.entries[0].source_path = "../escaped-by-source-path.txt";
      return m;
    }, async () => {
      await assert.rejects(unpackReleaseBundle({ bundleDir: bundleDirAbs, destRoot }), /\.\./);
    });
    assert.equal(await fileExists(escapedTarget), false, "no file should ever be written outside destRoot");
  } finally {
    await rm(escapedTarget, { force: true });
    await rm(destRoot, { recursive: true, force: true });
  }
});

test("Turn M11: a bundle_path pointing at a real symlink is rejected (bundle input symlink escape)", async () => {
  const destRoot = await mkdtemp(path.join(ROOT, "work", "bps-test-dest-"));
  const symlinkName = "evil-symlink.raw";
  const symlinkPath = path.join(bundleDirAbs, symlinkName);
  const outsideTarget = path.join(ROOT, "work", "domain-seed", "seed-gold-promotion-candidates.v0.17.jsonl");
  try {
    await symlink(outsideTarget, symlinkPath);
    await withMutatedManifest((m) => {
      m.entries[0].bundle_path = symlinkName;
      return m;
    }, async () => {
      await assert.rejects(unpackReleaseBundle({ bundleDir: bundleDirAbs, destRoot }), /symlink/);
    });
  } finally {
    await rm(symlinkPath, { force: true });
    await rm(destRoot, { recursive: true, force: true });
  }
});

test("Turn M11: a pre-existing symlink in destRoot's ancestry for a source_path is rejected (destination parent symlink escape)", async () => {
  const destRoot = await mkdtemp(path.join(ROOT, "work", "bps-test-dest-"));
  const outsideDir = await mkdtemp(path.join(ROOT, "work", "bps-test-outside-"));
  const trapDir = path.join(destRoot, "work");
  try {
    await symlink(outsideDir, trapDir);
    await withMutatedManifest((m) => {
      m.entries[0].source_path = "work/planted-via-symlinked-parent.txt";
      return m;
    }, async () => {
      await assert.rejects(unpackReleaseBundle({ bundleDir: bundleDirAbs, destRoot }), /symlink/);
    });
    assert.equal(await fileExists(path.join(outsideDir, "planted-via-symlinked-parent.txt")), false);
  } finally {
    await rm(trapDir, { force: true });
    await rm(outsideDir, { recursive: true, force: true });
    await rm(destRoot, { recursive: true, force: true });
  }
});

test("Turn M11: duplicate role across two entries is rejected", async () => {
  const destRoot = await mkdtemp(path.join(ROOT, "work", "bps-test-dest-"));
  try {
    await withMutatedManifest((m) => {
      const dup = cloneEntry(m, "SEED_GOLD");
      dup.bundle_path = `duplicate-role-${dup.bundle_path}`;
      dup.source_path = `duplicate-role-${dup.source_path}`;
      m.entries.push(dup);
      return m;
    }, async () => {
      await assert.rejects(unpackReleaseBundle({ bundleDir: bundleDirAbs, destRoot }), /duplicate role/i);
    });
  } finally { await rm(destRoot, { recursive: true, force: true }); }
});

test("Turn M11: duplicate bundle_path across two entries is rejected", async () => {
  const destRoot = await mkdtemp(path.join(ROOT, "work", "bps-test-dest-"));
  try {
    await withMutatedManifest((m) => {
      const dup = cloneEntry(m, "SEED_GOLD");
      dup.role = "DUPLICATE_BUNDLE_PATH_TEST_ROLE";
      dup.source_path = "duplicate-bundle-path-different-source.jsonl";
      // dup.bundle_path deliberately left identical to the real SEED_GOLD entry's bundle_path
      m.entries.push(dup);
      return m;
    }, async () => {
      await assert.rejects(unpackReleaseBundle({ bundleDir: bundleDirAbs, destRoot }), /duplicate.*bundle_path/i);
    });
  } finally { await rm(destRoot, { recursive: true, force: true }); }
});

test("Turn M11: duplicate source_path across two entries is rejected", async () => {
  const destRoot = await mkdtemp(path.join(ROOT, "work", "bps-test-dest-"));
  try {
    await withMutatedManifest((m) => {
      const dup = cloneEntry(m, "SEED_GOLD");
      dup.role = "DUPLICATE_SOURCE_PATH_TEST_ROLE";
      dup.bundle_path = "duplicate-source-path-different-bundle.jsonl";
      // dup.source_path deliberately left identical to the real SEED_GOLD entry's source_path
      m.entries.push(dup);
      return m;
    }, async () => {
      await assert.rejects(unpackReleaseBundle({ bundleDir: bundleDirAbs, destRoot }), /duplicate.*source_path/i);
    });
  } finally { await rm(destRoot, { recursive: true, force: true }); }
});

test("Turn M11: a manifest missing a required role (schema_version 0.1.0) is rejected", async () => {
  const destRoot = await mkdtemp(path.join(ROOT, "work", "bps-test-dest-"));
  try {
    await withMutatedManifest((m) => {
      m.entries = m.entries.filter((e) => e.role !== "SEED_GOLD");
      return m;
    }, async () => {
      await assert.rejects(unpackReleaseBundle({ bundleDir: bundleDirAbs, destRoot }), /missing required role|SEED_GOLD/i);
    });
  } finally { await rm(destRoot, { recursive: true, force: true }); }
});

test("Turn M11: an unknown/unexpected extra role (not in the schema_version 0.1.0 role set) is rejected", async () => {
  const destRoot = await mkdtemp(path.join(ROOT, "work", "bps-test-dest-"));
  try {
    await withMutatedManifest((m) => {
      const extra = cloneEntry(m, "SEED_GOLD");
      extra.role = "SOME_FUTURE_ROLE_NOT_YET_APPROVED";
      // bundle-manifest.json itself is a real, already-existing, non-symlink
      // file in bundleDirAbs that no entry references -- this lets the
      // fixture pass the (correct, earlier-in-the-pre-pass) symlink check
      // and actually reach the role-set check this test targets.
      extra.bundle_path = "bundle-manifest.json";
      extra.source_path = "extra-unknown-role-source.jsonl";
      m.entries.push(extra);
      return m;
    }, async () => {
      await assert.rejects(unpackReleaseBundle({ bundleDir: bundleDirAbs, destRoot }), /unknown role|unexpected role/i);
    });
  } finally { await rm(destRoot, { recursive: true, force: true }); }
});

test("Turn M11: when path/role validation fails, NOTHING is written -- destRoot ends up empty (not partially populated)", async () => {
  const destRoot = await mkdtemp(path.join(ROOT, "work", "bps-test-dest-"));
  try {
    await withMutatedManifest((m) => {
      // put the bad entry LAST so a naive per-entry loop would have
      // already written 20 good files before reaching it
      const bad = cloneEntry(m, "SEED_GOLD");
      bad.role = "TRAILING_BAD_ROLE";
      bad.bundle_path = "../trailing-bad-bundle-path.jsonl";
      bad.source_path = "trailing-bad-source-path.jsonl";
      m.entries.push(bad);
      return m;
    }, async () => {
      await assert.rejects(unpackReleaseBundle({ bundleDir: bundleDirAbs, destRoot }));
    });
    assert.equal(await dirIsEmptyOrMissing(destRoot), true, "destRoot must be empty after a rejected unpack -- structural validation must run before any write");
  } finally { await rm(destRoot, { recursive: true, force: true }); }
});

// -- regression: the real, committed, approved v0.20-r3 bundle ------------

test("Turn M11 regression: the real, committed seed-release-v0.20-r3.candidate bundle still unpacks successfully with all 21 entries", async () => {
  const realBundleDir = path.join(ROOT, "domain/releases/bundles/seed-release-v0.20-r3.candidate");
  const destRoot = await mkdtemp(path.join(ROOT, "work", "bps-test-real-v020r3-"));
  try {
    const { unpacked_files } = await unpackReleaseBundle({ bundleDir: realBundleDir, destRoot });
    assert.equal(unpacked_files.length, 21);
  } finally { await rm(destRoot, { recursive: true, force: true }); }
});

// -- Turn M11.1 item 1: duplicate detection on NORMALIZED/RESOLVED paths,
// never the raw manifest string. "a/b.json", "a/./b.json", "a//b.json",
// and "a\\b.json" must all be recognized as the SAME path. -------------

const SEED_GOLD_SOURCE = "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl";
const SOURCE_PATH_ALIASES = [
  "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl",
  "work/domain-seed/./seed-gold-promotion-candidates.v0.17.jsonl",
  "work/domain-seed//seed-gold-promotion-candidates.v0.17.jsonl",
  "work\\domain-seed\\seed-gold-promotion-candidates.v0.17.jsonl",
];

for (const [i, alias] of SOURCE_PATH_ALIASES.entries()) {
  test(`Turn M11.1: source_path alias #${i} (${JSON.stringify(alias)}) is recognized as a duplicate of the real SEED_GOLD source_path`, async () => {
    const destRoot = await mkdtemp(path.join(ROOT, "work", "bps-test-dest-"));
    try {
      await withMutatedManifest((m) => {
        const dup = cloneEntry(m, "SEED_GOLD");
        dup.role = `ALIAS_SOURCE_DUP_TEST_ROLE_${i}`;
        dup.bundle_path = `alias-source-dup-test-${i}.jsonl`; // unique -- isolates the source_path check
        dup.source_path = alias;
        m.entries.push(dup);
        return m;
      }, async () => {
        await assert.rejects(unpackReleaseBundle({ bundleDir: bundleDirAbs, destRoot }), /duplicate.*source_path/i);
      });
    } finally { await rm(destRoot, { recursive: true, force: true }); }
  });
}

const BUNDLE_PATH_ALIASES = [
  "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl",
  "work/domain-seed/./seed-gold-promotion-candidates.v0.17.jsonl",
  "work/domain-seed//seed-gold-promotion-candidates.v0.17.jsonl",
  "work\\domain-seed\\seed-gold-promotion-candidates.v0.17.jsonl",
];

for (const [i, alias] of BUNDLE_PATH_ALIASES.entries()) {
  test(`Turn M11.1: bundle_path alias #${i} (${JSON.stringify(alias)}) is recognized as a duplicate of the real SEED_GOLD bundle_path`, async () => {
    const destRoot = await mkdtemp(path.join(ROOT, "work", "bps-test-dest-"));
    try {
      await withMutatedManifest((m) => {
        const dup = cloneEntry(m, "SEED_GOLD");
        dup.role = `ALIAS_BUNDLE_DUP_TEST_ROLE_${i}`;
        dup.bundle_path = alias;
        dup.source_path = `alias-bundle-dup-test-${i}.jsonl`; // unique -- isolates the bundle_path check
        m.entries.push(dup);
        return m;
      }, async () => {
        await assert.rejects(unpackReleaseBundle({ bundleDir: bundleDirAbs, destRoot }), /duplicate.*bundle_path/i);
      });
    } finally { await rm(destRoot, { recursive: true, force: true }); }
  });
}

test("Turn M11.1 counterexample: two entries with genuinely DIFFERENT source_paths (not aliases of each other) are never flagged as duplicates", async () => {
  const destRoot = await mkdtemp(path.join(ROOT, "work", "bps-test-dest-"));
  try {
    await withMutatedManifest((m) => {
      const extra = cloneEntry(m, "SEED_GOLD");
      extra.role = "GENUINELY_DIFFERENT_SOURCE_PATH_ROLE";
      extra.bundle_path = "genuinely-different.jsonl";
      extra.source_path = "work/domain-seed/genuinely-different.jsonl";
      m.entries.push(extra);
      return m;
    }, async () => {
      // still fails (unknown role), but NOT on a duplicate-path message --
      // proves the alias check isn't over-triggering on unrelated paths.
      await assert.rejects(unpackReleaseBundle({ bundleDir: bundleDirAbs, destRoot }), (error) => {
        assert.equal(/duplicate/i.test(error.message), false, `unexpected duplicate-path rejection: ${error.message}`);
        return true;
      });
    });
  } finally { await rm(destRoot, { recursive: true, force: true }); }
});

// -- Turn M11.1 item 2: assertNoSymlinkInAncestry only treats ENOENT as
// "doesn't exist yet"; any other realpath error (EACCES/ELOOP/ENOTDIR/...)
// must fail closed. --------------------------------------------------------

test("Turn M11.1: assertNoSymlinkInAncestry fails closed on ENOTDIR (a path component that should be a directory is actually a plain file), never silently treating it as 'not yet existing'", async () => {
  const baseDir = await mkdtemp(path.join(ROOT, "work", "bps-test-enotdir-"));
  const blockerFile = path.join(baseDir, "blocker-file");
  try {
    await writeFile(blockerFile, "not a directory");
    // "blocker-file/nested/target.txt" -- blocker-file exists but is a
    // FILE, so treating it as a directory ancestor must throw ENOTDIR
    // when realpath is attempted on the "nested" component beneath it.
    const targetAbs = path.join(baseDir, "blocker-file", "nested", "target.txt");
    await assert.rejects(
      assertNoSymlinkInAncestry(targetAbs, baseDir, "test"),
      /could not verify/i,
    );
  } finally { await rm(baseDir, { recursive: true, force: true }); }
});

test("Turn M11.1 counterexample: assertNoSymlinkInAncestry still correctly passes through a genuinely nonexistent (ENOENT) ancestor chain", async () => {
  const baseDir = await mkdtemp(path.join(ROOT, "work", "bps-test-enoent-ok-"));
  try {
    const targetAbs = path.join(baseDir, "does", "not", "exist", "yet", "target.txt");
    await assert.doesNotReject(assertNoSymlinkInAncestry(targetAbs, baseDir, "test"));
  } finally { await rm(baseDir, { recursive: true, force: true }); }
});

test("Turn M11.1: an end-to-end unpack against a destRoot whose ancestry contains an ENOTDIR-shaped blocker fails closed (not just the unit-level helper)", async () => {
  const destRoot = await mkdtemp(path.join(ROOT, "work", "bps-test-dest-"));
  const blockerFile = path.join(destRoot, "work-blocker");
  try {
    await writeFile(blockerFile, "not a directory");
    await withMutatedManifest((m) => {
      const dup = cloneEntry(m, "SEED_GOLD");
      dup.role = "ENOTDIR_E2E_TEST_ROLE";
      dup.bundle_path = "enotdir-e2e-test.jsonl";
      dup.source_path = "work-blocker/nested/target.jsonl";
      m.entries.push(dup);
      return m;
    }, async () => {
      await assert.rejects(unpackReleaseBundle({ bundleDir: bundleDirAbs, destRoot }));
    });
  } finally { await rm(destRoot, { recursive: true, force: true }); }
});

// -- Turn M11.1 item 3: the role contract is a genuinely immutable frozen
// Array, not Object.freeze(new Set(...)) (which does not actually block
// .add()/.delete()). External mutation attempts must never affect a
// subsequent unpack() call. -------------------------------------------

test("Turn M11.1: the role contract is a frozen Array, and both the outer object and the array itself reject mutation", () => {
  const roles010 = KNOWN_BUNDLE_ROLES_BY_SCHEMA_VERSION["0.1.0"];
  assert.ok(Array.isArray(roles010), "role contract must be a real Array, not a Set");
  assert.equal(Object.isFrozen(KNOWN_BUNDLE_ROLES_BY_SCHEMA_VERSION), true);
  assert.equal(Object.isFrozen(roles010), true);
  assert.throws(() => roles010.push("EVIL_INJECTED_ROLE"), TypeError);
  assert.throws(() => { roles010[0] = "EVIL_OVERWRITE"; }, TypeError);
  assert.equal(roles010.includes("EVIL_INJECTED_ROLE"), false);
});

test("Turn M11.1: mutating a Set an external caller derives FROM the role array never affects the exported array or a subsequent unpackReleaseBundle call", async () => {
  const roles010 = KNOWN_BUNDLE_ROLES_BY_SCHEMA_VERSION["0.1.0"];
  const externallyDerivedSet = new Set(roles010);
  externallyDerivedSet.add("EVIL_INJECTED_ROLE_VIA_DERIVED_SET");
  externallyDerivedSet.delete("SEED_GOLD");

  // the exported contract itself is untouched by mutating a Set built from it
  assert.equal(roles010.includes("EVIL_INJECTED_ROLE_VIA_DERIVED_SET"), false);
  assert.equal(roles010.includes("SEED_GOLD"), true);
  assert.equal(roles010.length, 21);

  // and a REAL unpack call afterward still validates against the real,
  // untainted 21-role set -- proving unpackReleaseBundle builds its own
  // local Set fresh on every call, never reusing a caller-mutable one.
  const destRoot = await mkdtemp(path.join(ROOT, "work", "bps-test-dest-"));
  try {
    const { unpacked_files } = await unpackReleaseBundle({ bundleDir: bundleDirAbs, destRoot });
    assert.equal(unpacked_files.length, 21);
  } finally { await rm(destRoot, { recursive: true, force: true }); }
});
