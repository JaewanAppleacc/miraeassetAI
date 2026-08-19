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
//
// Turn M11: an independent review reproduced a real path-traversal gap --
// a manifest entry's source_path of "../../escaped.txt" wrote a file
// OUTSIDE destRoot, because this module previously joined bundle_path/
// source_path onto their base directories with no rejection of absolute
// paths, ".." segments, symlink escapes, or duplicate/unexpected roles.
// The build side (seed-release-bundle-closure.mjs) already rejected these
// shapes when COMPUTING what a bundle should contain, but this consume
// side trusted whatever bundle-manifest.json it was handed. This turn
// adds a full STRUCTURAL pre-pass -- every entry's role/bundle_path/
// source_path is validated (including symlink-escape checks, which read
// but never write) BEFORE any destination file is created -- using the
// SAME shared helpers seed-release-bundle-closure.mjs uses, so the two
// sides cannot silently diverge on what counts as "safe" again.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSafe } from "./deterministic-gzip.mjs";
import { assertSafeManifestRelativePath, resolveWithinBase, assertNoSymlinkInAncestry } from "./bundle-manifest-path-safety.mjs";
import { assertNoSymlink } from "./seed-company-resolver.mjs";

// Hard production ceilings -- never sourced from the bundle manifest,
// never overridable by a caller. See this module's header.
export const PRODUCTION_MAX_ENCODED_BYTES = 200 * 1024 * 1024;
export const PRODUCTION_MAX_DECODED_BYTES = 2 * 1024 * 1024 * 1024;
export const PRODUCTION_MAX_COMPRESSION_RATIO = 200;

// The CLOSED set of roles a bundle-manifest.json of a given schema_version
// is allowed to contain -- independently confirmed (Turn M11) to be
// IDENTICAL across every real release this codebase has built a bundle
// for (v0.19-sourced and the real, committed v0.20-r3 bundle both produce
// exactly this same 21-role set; only the file CONTENT behind each role
// differs release to release). This is deliberately a closed/exact set,
// not a permissive allowlist: a role missing from it OR an extra role not
// in it are both refused. A future schema_version that legitimately needs
// a different role set gets its OWN entry here (a version bump), never a
// silent loosening of "0.1.0"'s own set -- see this module's header and
// seed-release-bundle-builder.mjs's schema_version constant.
//
// Turn M11.1: stored as a frozen ARRAY, not `Object.freeze(new Set(...))`.
// Object.freeze on a Set only freezes the Set object's own (few, mostly
// non-enumerable) properties -- it does NOT block .add()/.delete(), which
// mutate the Set's internal slot rather than an own property, so a frozen
// Set is NOT actually immutable against mutation despite looking like it
// is. A frozen Array genuinely is: any attempted push/pop/index-assignment
// throws (ESM modules are always strict mode). Callers that need
// membership-testing build their OWN local Set from this array, fresh,
// every call (see unpackReleaseBundle below) -- so even a hypothetical
// caller holding a reference to this exact array could not affect
// validation by mutating a Set derived from it, only by (impossibly,
// since the array itself is frozen) mutating this array.
export const KNOWN_BUNDLE_ROLES_BY_SCHEMA_VERSION = Object.freeze({
  "0.1.0": Object.freeze([
    "CANONICAL_DOCUMENT_IR_BASE", "CANONICAL_DOCUMENT_IR_DELTA", "CANONICAL_RELEASE_MANIFEST",
    "CHAIN_MANIFEST", "COMPANY_DIRECTORY", "COMPANY_DIRECTORY_MANIFEST", "COMPANY_DIRECTORY_OWNER_DECISION",
    "FACT_COVERAGE_SNAPSHOT", "OWNER_BATCH_DECISION", "OWNER_DECISION", "RELEASE_DECISION", "SEED_GOLD",
    "STRUCTURED_MANIFEST", "THIN_PLAN", "THIN_PLAN_MANIFEST", "TIMELINE_FACT_NARRATIVE_POLICY_DECISION",
    "VERIFIED_EVENT", "VERIFIED_EVIDENCE", "VERIFIED_EVIDENCE_MANIFEST", "VERIFIED_FACT", "VERIFIED_RELATION",
  ]),
});

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// Pure structural validation of ONE manifest entry: role shape, safe
// relative bundle_path/source_path (rejecting absolute paths and ".."
// segments), and that both resolve within their respective base
// directories. Throws on the first violation; never touches the
// filesystem (see assertBundleEntrySafety below for the I/O-involving
// symlink checks, kept separate so this part stays trivially unit-
// testable and synchronous).
function assertBundleEntryPathShape(entry, index, bundleDir, destRoot) {
  const label = `unpackReleaseBundle: entries[${index}]`;
  if (typeof entry.role !== "string" || entry.role === "") {
    throw new Error(`${label}: role is required and must be a non-empty string`);
  }
  const bundleRel = assertSafeManifestRelativePath(entry.bundle_path, `${label}.bundle_path`);
  const sourceRel = assertSafeManifestRelativePath(entry.source_path, `${label}.source_path`);
  const srcAbs = resolveWithinBase(bundleDir, bundleRel, `${label}.bundle_path`);
  const destAbs = resolveWithinBase(destRoot, sourceRel, `${label}.source_path`);
  return { srcAbs, destAbs };
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
  const knownRolesArray = KNOWN_BUNDLE_ROLES_BY_SCHEMA_VERSION[bundleManifest.schema_version];
  if (!knownRolesArray) {
    throw new Error(`unpackReleaseBundle: unknown bundle-manifest.json schema_version ${JSON.stringify(bundleManifest.schema_version)}`);
  }
  // Fresh local Set, rebuilt from the frozen array on every call -- see
  // this module's header comment on KNOWN_BUNDLE_ROLES_BY_SCHEMA_VERSION
  // for why membership testing never holds onto a shared/exported Set.
  const knownRoles = new Set(knownRolesArray);

  // -- STRUCTURAL PRE-PASS: every entry is validated (shape, duplicates,
  // symlink escapes, role set) before ANY destination file is created.
  // Nothing in this pass writes to disk.
  //
  // Turn M11.1: duplicate bundle_path/source_path detection keys on the
  // fully RESOLVED absolute path (srcAbs/destAbs), never the raw manifest
  // string. Two textually different entries that alias the same real file
  // -- "a/b.json" vs "a/./b.json" vs "a//b.json" vs "a\\b.json" -- must be
  // treated as the SAME path for duplicate purposes; comparing raw strings
  // would let an attacker (or a buggy builder) smuggle two entries past
  // the duplicate check by spelling the identical destination two
  // different ways.
  const seenRoles = new Set();
  const seenBundlePaths = new Set();
  const seenSourcePaths = new Set();
  const resolved = [];
  for (const [index, entry] of bundleManifest.entries.entries()) {
    if (seenRoles.has(entry.role)) throw new Error(`unpackReleaseBundle: duplicate role ${JSON.stringify(entry.role)} across entries[${index}]`);
    seenRoles.add(entry.role);

    const { srcAbs, destAbs } = assertBundleEntryPathShape(entry, index, bundleDir, destRoot);

    if (seenBundlePaths.has(srcAbs)) throw new Error(`unpackReleaseBundle: duplicate bundle_path ${JSON.stringify(entry.bundle_path)} across entries[${index}] (resolves to the same file as an earlier entry)`);
    seenBundlePaths.add(srcAbs);
    if (seenSourcePaths.has(destAbs)) throw new Error(`unpackReleaseBundle: duplicate source_path ${JSON.stringify(entry.source_path)} across entries[${index}] (resolves to the same file as an earlier entry)`);
    seenSourcePaths.add(destAbs);

    // Bundle input side: the file MUST already exist (it is about to be
    // read), so the same full-path symlink check seed-company-resolver.mjs
    // uses for other trusted-input files applies directly.
    await assertNoSymlink(srcAbs, `unpackReleaseBundle: entries[${index}].bundle_path`);
    // Destination side: the file does NOT exist yet (it is about to be
    // created), so only its ANCESTOR directories can be inspected for a
    // symlink escape planted ahead of time.
    await assertNoSymlinkInAncestry(destAbs, destRoot, `unpackReleaseBundle: entries[${index}].source_path`);

    resolved.push({ entry, srcAbs, destAbs });
  }

  const missingRoles = [...knownRoles].filter((role) => !seenRoles.has(role));
  if (missingRoles.length > 0) {
    throw new Error(`unpackReleaseBundle: bundle-manifest.json is missing required role(s): ${missingRoles.join(", ")}`);
  }
  const unknownRoles = [...seenRoles].filter((role) => !knownRoles.has(role));
  if (unknownRoles.length > 0) {
    throw new Error(`unpackReleaseBundle: bundle-manifest.json declares unknown role(s) not permitted under schema_version ${bundleManifest.schema_version}: ${unknownRoles.join(", ")}`);
  }

  // -- WRITE PASS: only reached once every entry above has passed the
  // full structural/path/symlink/role validation.
  const unpackedFiles = [];
  for (const { entry, srcAbs, destAbs } of resolved) {
    await mkdir(path.dirname(destAbs), { recursive: true });

    if (entry.compression === "gzip") {
      const encoded = await readFile(srcAbs);
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
      await writeFile(destAbs, decoded);
    } else {
      const raw = await readFile(srcAbs);
      if (sha256(raw) !== entry.decoded_sha256) {
        throw new Error(`unpackReleaseBundle: ${entry.bundle_path} sha256 mismatch (bundle file was tampered or corrupted)`);
      }
      await writeFile(destAbs, raw);
    }
    unpackedFiles.push(entry.source_path);
  }

  return Object.freeze({ destRoot, unpacked_files: Object.freeze(unpackedFiles) });
}
