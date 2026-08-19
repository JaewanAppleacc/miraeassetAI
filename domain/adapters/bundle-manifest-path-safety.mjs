// Turn M11: a small, shared path-safety layer for release bundle
// manifests, used by BOTH the build side (seed-release-bundle-closure.mjs,
// which computes what a bundle SHOULD contain) and the consume side
// (seed-release-bundle-unpack.mjs, which materializes a bundle it was
// GIVEN back onto disk). Extracted here so the two sides can never
// silently diverge on what counts as a "safe" path -- before this turn,
// closure.mjs had its own private root-escape check and unpack.mjs had
// none at all, which is exactly the asymmetry an independent review
// found and reproduced (a manifest entry's `source_path` containing
// `../../escaped.txt` was written outside destRoot with no rejection).
//
// This module deliberately does NOT invent a new bundle format or a new
// manifest schema field -- it only tightens what "a manifest_entry path
// string" is allowed to mean, for the CURRENT schema_version ("0.1.0")
// that domain/adapters/seed-release-bundle-builder.mjs already writes.
import { realpath } from "node:fs/promises";
import path from "node:path";

// Rejects, BEFORE any path.join/path.resolve normalization gets a chance
// to collapse anything: non-strings, empty strings, absolute paths, any
// ".." path segment (checked on the RAW string, not the resolved one --
// so "a/../../b" is caught here even though a naive resolved-path check
// might only notice the escape after collapsing), and a path that -- once
// "." segments and empty segments are stripped -- has no real filename
// left (e.g. ".", "./", "a/./" with nothing else). Returns the same path
// with redundant "." segments removed, normalized to forward slashes,
// for callers that want a canonical form to store/compare.
export function assertSafeManifestRelativePath(candidateRelPath, label) {
  if (typeof candidateRelPath !== "string" || candidateRelPath === "") {
    throw new Error(`${label}: path is required and must be a non-empty string`);
  }
  if (path.isAbsolute(candidateRelPath) || candidateRelPath.startsWith("/") || candidateRelPath.startsWith("\\")) {
    throw new Error(`${label}: absolute paths are not permitted (${JSON.stringify(candidateRelPath)})`);
  }
  const rawSegments = candidateRelPath.split(/[\\/]+/);
  if (rawSegments.some((segment) => segment === "..")) {
    throw new Error(`${label}: ".." path segments are not permitted (${JSON.stringify(candidateRelPath)})`);
  }
  const meaningfulSegments = rawSegments.filter((segment) => segment !== "" && segment !== ".");
  if (meaningfulSegments.length === 0) {
    throw new Error(`${label}: path is empty or resolves only to the current directory (${JSON.stringify(candidateRelPath)})`);
  }
  return meaningfulSegments.join("/");
}

// Defense-in-depth (assertSafeManifestRelativePath above should already
// make this unreachable): after joining `relPath` onto `baseDir` and
// normalizing, the result must still resolve to somewhere AT OR BELOW
// baseDir. Returns the resolved absolute path.
export function resolveWithinBase(baseDir, relPath, label) {
  const baseAbs = path.resolve(baseDir);
  const targetAbs = path.resolve(baseAbs, relPath);
  const relFromBase = path.relative(baseAbs, targetAbs);
  if (relFromBase === "" || relFromBase.startsWith("..") || path.isAbsolute(relFromBase)) {
    throw new Error(`${label}: path resolves outside its base directory (${JSON.stringify(relPath)})`);
  }
  return targetAbs;
}

// Mirrors seed-release-bundle-closure.mjs's own pre-Turn-M11 private
// `toRootRelative` helper exactly (same signature/semantics: `candidate`
// may already be absolute or may need resolving against `root` first),
// extracted here so closure.mjs (the BUILD side) and
// seed-release-bundle-unpack.mjs (the CONSUME side) share one definition
// of "safe root-relative path" instead of two that could silently drift
// apart -- which is exactly how the path-traversal gap this turn closes
// was possible in the first place (closure.mjs already rejected escapes;
// unpack.mjs had no equivalent check at all).
export function toRootRelative(root, candidate, label = "toRootRelative") {
  const abs = path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate);
  const rel = path.relative(root, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`${label}: ${abs} resolves outside root ${root}`);
  }
  return rel.split(path.sep).join("/");
}

// Walks UP from targetAbs's parent directory toward baseAbs, and for
// every ancestor that ALREADY EXISTS on disk, confirms its realpath is
// itself (no symlink component). Stops at the first ancestor that does
// not yet exist -- a directory that doesn't exist yet cannot be a
// symlink, and mkdir(..., { recursive: true }) will create genuine plain
// directories from that point down. This is the destination-side
// counterpart to assertNoSymlink (seed-company-resolver.mjs), which
// requires the full path to already exist and so cannot be used for a
// file about to be CREATED.
//
// Turn M11.1: only ENOENT ("this ancestor genuinely does not exist yet")
// is treated as pass-through. Any OTHER realpath failure -- EACCES
// (permission denied), ELOOP (symlink loop), ENOTDIR (a path component
// that should be a directory is actually a file), or anything else -- is
// NOT "doesn't exist yet"; it is an inconclusive or actively suspicious
// state, and fail-closed is the only safe response. Silently treating
// every realpath error the same way (the pre-Turn-M11.1 behavior) would
// let e.g. an ELOOP symlink cycle or a permission-denied ancestor slip
// through as if it were simply absent.
export async function assertNoSymlinkInAncestry(targetAbs, baseAbs, label) {
  const stopAt = path.resolve(baseAbs);
  let current = path.dirname(path.resolve(targetAbs));
  const chain = [];
  while (true) {
    chain.push(current);
    if (current === stopAt) break;
    const parent = path.dirname(current);
    if (parent === current) break; // reached filesystem root without hitting stopAt
    current = parent;
  }
  for (const dir of chain) {
    let real;
    try {
      real = await realpath(dir);
    } catch (error) {
      if (error && error.code === "ENOENT") continue; // does not exist yet -- nothing to check
      throw new Error(`${label}: could not verify path component ${dir} is not a symlink: ${error.message}`);
    }
    if (path.resolve(real) !== dir) {
      throw new Error(`${label}: an existing path component is a symlink (${dir})`);
    }
  }
}
