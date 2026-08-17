// Turn K item A/C/G: builds a release bundle directory from a MECHANICAL
// dependency closure (see seed-release-bundle-closure.mjs) -- copying
// every closure entry's real bytes into the bundle, deterministically
// gzip-compressing the two large Canonical DocumentIR shards (item C), and
// then independently re-walking the resulting directory to prove it
// contains EXACTLY the closure's file set: nothing missing, nothing
// extra. Development-only artifacts (review packets, Harness raw results,
// receipts, ...) are never part of the closure in the first place (see
// seed-release-bundle-closure.mjs's own header), so they can never end up
// in a bundle built from it.
//
// status is caller-supplied but constrained to a small allowlist that
// deliberately EXCLUDES "APPROVED"/"READY" -- see Turn K item G: a bundle
// built by this module is never itself a claim of final release
// authorization. Only a separately-created release decision (never
// created by this module) can make that claim, and only by externally
// pinning this bundle manifest's raw-byte hash (see
// seed-release-bundle-manifest-binding.mjs) -- the bundle manifest never
// approves itself.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { computeReleaseBundleClosure } from "./seed-release-bundle-closure.mjs";
import { gzipDeterministic } from "./deterministic-gzip.mjs";

const ALLOWED_BUNDLE_STATUSES = Object.freeze(["CANDIDATE", "RELEASE_PENDING"]);
const GZIP_ROLES = Object.freeze(["CANONICAL_DOCUMENT_IR_BASE", "CANONICAL_DOCUMENT_IR_DELTA"]);
const BUNDLE_MANIFEST_FILENAME = "bundle-manifest.json";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function walkFiles(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(full, base)));
    else if (entry.isFile()) files.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return files;
}

// Returns the bundle-relative path (inside bundleDir) a closure entry
// should be written to: DocumentIR shards get a ".gz" suffix (the
// compressed form is the only copy the bundle carries), everything else
// keeps its original closure path unchanged.
function bundleRelativePathFor(entry) {
  return GZIP_ROLES.includes(entry.role) ? `${entry.path}.gz` : entry.path;
}

export async function buildReleaseBundle({
  bundleDir,
  status = "CANDIDATE",
  root,
  generatedAt,
  ...closureOptions
} = {}) {
  if (!ALLOWED_BUNDLE_STATUSES.includes(status)) {
    throw new Error(`buildReleaseBundle: status must be one of ${ALLOWED_BUNDLE_STATUSES.join(", ")} (never APPROVED/READY -- see this module's header)`);
  }
  if (typeof bundleDir !== "string" || bundleDir === "") throw new Error("buildReleaseBundle: bundleDir is required");
  if (typeof root !== "string" || root === "") throw new Error("buildReleaseBundle: root is required");
  if (generatedAt !== undefined && (typeof generatedAt !== "string" || !Number.isFinite(Date.parse(generatedAt)))) {
    throw new Error("buildReleaseBundle: generatedAt must be an ISO-compatible date string when provided");
  }

  const closure = await computeReleaseBundleClosure({ root, ...closureOptions });
  const bundleDirAbs = path.resolve(root, bundleDir);
  await mkdir(bundleDirAbs, { recursive: true });

  const manifestEntries = [];
  for (const entry of closure.entries) {
    const sourceBytes = await readFile(path.join(root, entry.path));
    if (sha256(sourceBytes) !== entry.sha256) {
      throw new Error(`buildReleaseBundle: ${entry.path} changed on disk between closure computation and bundling -- refusing to bundle a moving target`);
    }
    const bundleRelPath = bundleRelativePathFor(entry);
    const destAbs = path.join(bundleDirAbs, bundleRelPath);
    await mkdir(path.dirname(destAbs), { recursive: true });

    if (GZIP_ROLES.includes(entry.role)) {
      const encoded = gzipDeterministic(sourceBytes);
      await writeFile(destAbs, encoded);
      const writtenBack = await readFile(destAbs);
      if (sha256(writtenBack) !== sha256(encoded)) throw new Error(`buildReleaseBundle: ${bundleRelPath} was not written correctly`);
      manifestEntries.push({
        role: entry.role, bundle_path: bundleRelPath, source_path: entry.path,
        compression: "gzip", gzip_level: 9,
        decoded_sha256: entry.sha256, decoded_bytes: sourceBytes.length,
        encoded_sha256: sha256(encoded), encoded_bytes: encoded.length,
        record_count: entry.record_count,
      });
    } else {
      await writeFile(destAbs, sourceBytes);
      const writtenBack = await readFile(destAbs);
      if (sha256(writtenBack) !== entry.sha256) throw new Error(`buildReleaseBundle: ${bundleRelPath} was not written correctly`);
      manifestEntries.push({
        role: entry.role, bundle_path: bundleRelPath, source_path: entry.path,
        compression: "none",
        decoded_sha256: entry.sha256, decoded_bytes: sourceBytes.length,
        record_count: entry.record_count,
      });
    }
  }

  const bundleManifest = {
    schema_version: "0.1.0",
    status,
    release_id: closure.release_id,
    approved_revision: closure.approved_revision,
    corpus_snapshot_id: closure.corpus_snapshot_id,
    fact_coverage_snapshot_id: closure.fact_coverage_snapshot_id,
    generated_at: generatedAt ?? new Date().toISOString(),
    entry_count: manifestEntries.length,
    entries: manifestEntries.sort((a, b) => a.bundle_path.localeCompare(b.bundle_path)),
    note: "status is CANDIDATE/RELEASE_PENDING only -- this manifest never approves itself; a separate release decision must externally pin this file's own raw-byte SHA-256 (see seed-release-bundle-manifest-binding.mjs) before this bundle can be treated as release-authorized.",
  };
  const bundleManifestPath = path.join(bundleDirAbs, BUNDLE_MANIFEST_FILENAME);
  const bundleManifestBytes = Buffer.from(`${JSON.stringify(bundleManifest, null, 2)}\n`, "utf8");
  await writeFile(bundleManifestPath, bundleManifestBytes);

  // Closure the loop: re-walk the ACTUAL directory and prove it holds
  // exactly the expected file set. Any leftover file from a prior partial
  // build, or any file this loop didn't just write, fails the build.
  await verifyReleaseBundleDirectoryMatchesManifest({ bundleDir: bundleDirAbs });

  return Object.freeze({
    bundleDir: bundleDirAbs,
    bundleManifestPath,
    bundleManifestSha256: sha256(await readFile(bundleManifestPath)),
    entries: Object.freeze(manifestEntries),
  });
}

// Re-reads bundle-manifest.json from disk (never trusts an in-memory
// object) and confirms: (1) every declared entry's file exists at its
// declared bundle_path with the declared hash, and (2) the directory
// contains NO file outside {declared entries, bundle-manifest.json
// itself}. Reusable standalone -- also exercised directly by tests that
// inject a stray extra file after a normal build.
export async function verifyReleaseBundleDirectoryMatchesManifest({ bundleDir }) {
  const bundleManifestPath = path.join(bundleDir, BUNDLE_MANIFEST_FILENAME);
  const bundleManifest = JSON.parse(await readFile(bundleManifestPath, "utf8"));

  const expectedFiles = new Set([BUNDLE_MANIFEST_FILENAME, ...bundleManifest.entries.map((e) => e.bundle_path)]);
  const actualFiles = new Set(await walkFiles(bundleDir));

  const missing = [...expectedFiles].filter((f) => !actualFiles.has(f));
  if (missing.length > 0) throw new Error(`verifyReleaseBundleDirectoryMatchesManifest: missing file(s) declared in the manifest: ${missing.join(", ")}`);
  const extra = [...actualFiles].filter((f) => !expectedFiles.has(f));
  if (extra.length > 0) throw new Error(`verifyReleaseBundleDirectoryMatchesManifest: unexpected extra file(s) not declared in the manifest: ${extra.join(", ")}`);

  for (const entry of bundleManifest.entries) {
    const bytes = await readFile(path.join(bundleDir, entry.bundle_path));
    const actualHash = sha256(bytes);
    const expectedHash = entry.compression === "gzip" ? entry.encoded_sha256 : entry.decoded_sha256;
    if (actualHash !== expectedHash) {
      throw new Error(`verifyReleaseBundleDirectoryMatchesManifest: ${entry.bundle_path} sha256 mismatch (actual ${actualHash}, expected ${expectedHash})`);
    }
  }
  return Object.freeze({ file_count: actualFiles.size, status: bundleManifest.status });
}
