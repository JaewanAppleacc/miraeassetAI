// Turn K item D (deployment side): materializes a release bundle (see
// seed-release-bundle-builder.mjs) back into a plain, uncompressed
// directory tree at its ORIGINAL relative paths -- so
// domain/runtime/configured-seed-runtime.mjs (unmodified, via
// SEED_RUNTIME_ROOT) can run against it exactly as it runs against the
// original work/ tree today. Gzip is purely a storage/transport
// optimization for the bundle at rest; nothing about Runtime construction
// itself needs to know a shard was ever compressed.
//
// Every decompression bound is the SMALLER of a hard-coded production
// ceiling and the bundle manifest's own declared expected size -- a
// manifest cannot loosen the effective limit past the code ceiling no
// matter what it claims, it can only ever tighten it. This, plus the
// exact-length and sha256 checks below, all complete before any byte is
// exposed to a caller: unpackReleaseBundle only returns after every entry
// has been fully written and independently re-verified, so nothing
// downstream (the DocumentStore, the Runtime) can ever observe a record
// that hasn't passed every bound.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSafe } from "./deterministic-gzip.mjs";

// Hard production ceilings -- never sourced from the bundle manifest,
// never overridable by a caller. See this module's header.
export const PRODUCTION_MAX_ENCODED_BYTES = 200 * 1024 * 1024;
export const PRODUCTION_MAX_DECODED_BYTES = 2 * 1024 * 1024 * 1024;
export const PRODUCTION_MAX_COMPRESSION_RATIO = 200;

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function unpackReleaseBundle({ bundleDir, destRoot }) {
  if (typeof bundleDir !== "string" || bundleDir === "") throw new Error("unpackReleaseBundle: bundleDir is required");
  if (typeof destRoot !== "string" || destRoot === "") throw new Error("unpackReleaseBundle: destRoot is required");

  const bundleManifestPath = path.join(bundleDir, "bundle-manifest.json");
  let bundleManifest;
  try {
    bundleManifest = JSON.parse(await readFile(bundleManifestPath, "utf8"));
  } catch (error) {
    throw new Error(`unpackReleaseBundle: could not read bundle-manifest.json: ${error.message}`);
  }
  if (!Array.isArray(bundleManifest.entries) || bundleManifest.entries.length === 0) {
    throw new Error("unpackReleaseBundle: bundle-manifest.json has no entries[]");
  }

  const unpackedFiles = [];
  for (const entry of bundleManifest.entries) {
    const srcPath = path.join(bundleDir, entry.bundle_path);
    const destPath = path.join(destRoot, entry.source_path);
    await mkdir(path.dirname(destPath), { recursive: true });

    if (entry.compression === "gzip") {
      const encoded = await readFile(srcPath);
      if (sha256(encoded) !== entry.encoded_sha256) {
        throw new Error(`unpackReleaseBundle: ${entry.bundle_path} encoded sha256 mismatch (bundle file was tampered or corrupted)`);
      }
      const maxEncodedBytes = Math.min(PRODUCTION_MAX_ENCODED_BYTES, typeof entry.encoded_bytes === "number" ? entry.encoded_bytes : PRODUCTION_MAX_ENCODED_BYTES);
      const maxDecodedBytes = Math.min(PRODUCTION_MAX_DECODED_BYTES, typeof entry.decoded_bytes === "number" ? entry.decoded_bytes : PRODUCTION_MAX_DECODED_BYTES);
      const { decoded } = gunzipSafe(encoded, { maxEncodedBytes, maxDecodedBytes, maxCompressionRatio: PRODUCTION_MAX_COMPRESSION_RATIO });
      if (typeof entry.decoded_bytes === "number" && decoded.length !== entry.decoded_bytes) {
        throw new Error(`unpackReleaseBundle: ${entry.bundle_path} decoded to ${decoded.length} bytes, expected exactly ${entry.decoded_bytes}`);
      }
      if (sha256(decoded) !== entry.decoded_sha256) {
        throw new Error(`unpackReleaseBundle: ${entry.bundle_path} decoded content sha256 mismatch`);
      }
      await writeFile(destPath, decoded);
    } else {
      const raw = await readFile(srcPath);
      if (sha256(raw) !== entry.decoded_sha256) {
        throw new Error(`unpackReleaseBundle: ${entry.bundle_path} sha256 mismatch (bundle file was tampered or corrupted)`);
      }
      await writeFile(destPath, raw);
    }
    unpackedFiles.push(entry.source_path);
  }

  return Object.freeze({ destRoot, unpacked_files: Object.freeze(unpackedFiles) });
}
