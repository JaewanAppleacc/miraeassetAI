// Turn K item A: a MECHANICAL dependency-closure calculator for a release
// bundle. This never hand-types a list of "files a bundle needs" -- it
// derives that list by (1) actually running the real, already-tested
// release-authorization boundary (createSeedRuntimeServiceAdapters, the
// exact function domain/runtime/configured-seed-runtime.mjs calls), which
// fails closed exactly as production Runtime construction would if the
// release is not genuinely authorized, and then (2) re-reading the SAME
// release decision artifact that authorization relied on to enumerate
// every pinned artifact role/path/sha256/record_count it declares --
// canonical_artifacts[] (CANONICAL_DOCUMENT_IR_BASE/DELTA, SEED_GOLD),
// structured_artifacts[] (VERIFIED_EVIDENCE(+MANIFEST), VERIFIED_EVENT,
// VERIFIED_RELATION, CHAIN_MANIFEST, VERIFIED_FACT, FACT_COVERAGE_SNAPSHOT,
// OWNER_DECISION -- the structured Owner decision), thin_plan(+manifest),
// thin_plan_source_gold/coverage, and owner_batch_decision (the batch
// Owner decision) -- plus the two top-level manifests and the decision
// artifact itself. Company Directory (artifact/manifest/Owner decision)
// and the Timeline Fact Narrative Policy decision are not yet part of any
// existing release decision's own schema, so callers supply those paths
// explicitly; this function still independently re-verifies every one of
// their pinned hashes against real file bytes rather than trusting the
// caller's claim.
//
// Every entry's real, on-disk raw-byte SHA-256 is (re-)computed and
// compared against whatever hash pins it -- a caller-declared/decision-
// declared hash that does not match the actual file content is a build
// failure, not a warning. The SAME logical artifact referenced twice under
// different decision fields (SEED_GOLD via canonical_artifacts AND
// thin_plan_source_gold; FACT_COVERAGE_SNAPSHOT via structured_artifacts
// AND thin_plan_source_coverage) collapses to one closure entry -- but
// only if both references agree on path AND hash; disagreement is itself
// a build failure (an internally inconsistent decision artifact).
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createSeedRuntimeServiceAdapters } from "./seed-runtime-service-adapters.mjs";
import { assertNoSymlink } from "./seed-company-resolver.mjs";
// Turn M11: this closure calculator's own root-escape check is now the
// SHARED implementation (also used by seed-release-bundle-unpack.mjs's
// consume-side validation) rather than a private local copy -- see
// bundle-manifest-path-safety.mjs's header for why the two sides must not
// be able to silently diverge.
import { toRootRelative as sharedToRootRelative } from "./bundle-manifest-path-safety.mjs";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function toRootRelative(root, absPath) {
  return sharedToRootRelative(root, absPath, "computeReleaseBundleClosure");
}

async function readVerifiedFile(root, relativePath, label) {
  const absPath = path.resolve(root, relativePath);
  await assertNoSymlink(absPath, label);
  let buffer;
  try {
    buffer = await readFile(absPath);
  } catch (error) {
    throw new Error(`computeReleaseBundleClosure: ${label} (${relativePath}) could not be read: ${error.message}`);
  }
  return buffer;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value === "") throw new Error(`computeReleaseBundleClosure: ${label} is required`);
  return value;
}

export async function computeReleaseBundleClosure({
  structuredManifestPath,
  canonicalReleaseManifestPath,
  planPath,
  planManifestPath,
  root,
  expectedReleaseId,
  expectedApprovedRevision,
  companyDirectoryArtifactPath,
  companyDirectoryManifestPath,
  companyDirectoryOwnerDecisionPath,
  expectedCompanyDirectoryOwnerDecisionSha256,
  timelinePolicyDecisionPath,
} = {}) {
  requireNonEmptyString(structuredManifestPath, "structuredManifestPath");
  requireNonEmptyString(canonicalReleaseManifestPath, "canonicalReleaseManifestPath");
  requireNonEmptyString(planPath, "planPath");
  requireNonEmptyString(planManifestPath, "planManifestPath");
  requireNonEmptyString(root, "root");
  requireNonEmptyString(companyDirectoryArtifactPath, "companyDirectoryArtifactPath");
  requireNonEmptyString(companyDirectoryManifestPath, "companyDirectoryManifestPath");
  requireNonEmptyString(companyDirectoryOwnerDecisionPath, "companyDirectoryOwnerDecisionPath");
  requireNonEmptyString(timelinePolicyDecisionPath, "timelinePolicyDecisionPath");

  // Step 1: the real authorization boundary. A v0.20 CANDIDATE bundle must
  // bind Company Directory and the batch Owner decision unconditionally --
  // this is not the caller's choice to make (see Turn K item G / the
  // requireCompanyDirectory production-policy discussion in
  // domain/releases/README.md's "v0.20 release-binding checklist").
  await createSeedRuntimeServiceAdapters({
    structuredManifestPath, canonicalReleaseManifestPath, planPath, planManifestPath, root,
    expectedReleaseId, expectedApprovedRevision, requireOwnerBatchDecision: true,
    companyDirectoryArtifactPath, companyDirectoryManifestPath, companyDirectoryOwnerDecisionPath,
    expectedCompanyDirectoryOwnerDecisionSha256, requireCompanyDirectory: true,
  });

  const canonicalManifestRel = toRootRelative(root, path.resolve(root, canonicalReleaseManifestPath));
  const canonicalManifestBytes = await readVerifiedFile(root, canonicalManifestRel, "canonical release manifest");
  const canonicalManifest = JSON.parse(canonicalManifestBytes.toString("utf8"));

  const decisionRel = requireNonEmptyString(canonicalManifest.release_authorization?.decision_artifact_path, "canonical manifest release_authorization.decision_artifact_path");
  const decisionBytes = await readVerifiedFile(root, decisionRel, "release decision artifact");
  if (sha256(decisionBytes) !== canonicalManifest.release_authorization.decision_artifact_sha256) {
    throw new Error("computeReleaseBundleClosure: release decision artifact sha256 does not match the canonical manifest's pin");
  }
  const decision = JSON.parse(decisionBytes.toString("utf8"));

  const structuredManifestRel = toRootRelative(root, path.resolve(root, structuredManifestPath));
  const structuredManifestBytes = await readVerifiedFile(root, structuredManifestRel, "structured manifest");

  // path -> { role, path, sha256, record_count } -- keyed by root-relative
  // path so the SAME logical artifact referenced under two decision
  // fields (SEED_GOLD / FACT_COVERAGE_SNAPSHOT) collapses to one entry,
  // with a hard failure if the two references ever disagree.
  const closure = new Map();

  async function addEntry(role, relativePath, expectedSha256, recordCount) {
    const rel = toRootRelative(root, path.resolve(root, relativePath));
    const buffer = await readVerifiedFile(root, rel, role);
    const actualSha256 = sha256(buffer);
    if (typeof expectedSha256 === "string" && actualSha256 !== expectedSha256) {
      throw new Error(`computeReleaseBundleClosure: ${role} (${rel}) sha256 mismatch (actual ${actualSha256}, pinned ${expectedSha256})`);
    }
    const existing = closure.get(rel);
    if (existing) {
      if (existing.sha256 !== actualSha256) {
        throw new Error(`computeReleaseBundleClosure: ${rel} is referenced twice with disagreeing sha256 (roles ${existing.role} and ${role}) -- the decision artifact is internally inconsistent`);
      }
      return; // already present under an earlier role reference -- no duplicate entry
    }
    closure.set(rel, Object.freeze({ role, path: rel, sha256: actualSha256, record_count: recordCount ?? null, bytes: buffer.length }));
  }

  await addEntry("CANONICAL_RELEASE_MANIFEST", canonicalManifestRel, sha256(canonicalManifestBytes), null);
  await addEntry("RELEASE_DECISION", decisionRel, sha256(decisionBytes), null);
  await addEntry("STRUCTURED_MANIFEST", structuredManifestRel, sha256(structuredManifestBytes), null);

  if (!Array.isArray(decision.canonical_artifacts) || decision.canonical_artifacts.length === 0) {
    throw new Error("computeReleaseBundleClosure: decision.canonical_artifacts must be a non-empty array");
  }
  for (const artifact of decision.canonical_artifacts) {
    await addEntry(artifact.role, artifact.path, artifact.sha256, artifact.record_count);
  }
  if (!Array.isArray(decision.structured_artifacts) || decision.structured_artifacts.length === 0) {
    throw new Error("computeReleaseBundleClosure: decision.structured_artifacts must be a non-empty array");
  }
  for (const artifact of decision.structured_artifacts) {
    await addEntry(artifact.role, artifact.path, artifact.sha256, artifact.record_count);
  }

  for (const [role, field] of [
    ["THIN_PLAN", "thin_plan"], ["THIN_PLAN_MANIFEST", "thin_plan_manifest"],
    ["SEED_GOLD", "thin_plan_source_gold"], ["FACT_COVERAGE_SNAPSHOT", "thin_plan_source_coverage"],
    ["OWNER_BATCH_DECISION", "owner_batch_decision"],
  ]) {
    const pin = decision[field];
    if (!pin || typeof pin.path !== "string" || typeof pin.sha256 !== "string") {
      throw new Error(`computeReleaseBundleClosure: decision.${field} must declare {path, sha256}`);
    }
    await addEntry(role, pin.path, pin.sha256, pin.record_count ?? null);
  }

  // Company Directory: not yet part of any existing release decision's own
  // schema (see domain/releases/README.md's v0.20 checklist) -- the caller
  // supplies the three paths explicitly; Step 1 above already proved they
  // are release-authorized (requireCompanyDirectory: true), so here we
  // only need each real file's own hash for the closure entry, cross-
  // checked against the Owner decision's own declared pins.
  const companyDecisionRel = toRootRelative(root, path.resolve(root, companyDirectoryOwnerDecisionPath));
  const companyDecisionBytes = await readVerifiedFile(root, companyDecisionRel, "company directory owner decision");
  const companyDecision = JSON.parse(companyDecisionBytes.toString("utf8"));
  await addEntry("COMPANY_DIRECTORY_OWNER_DECISION", companyDecisionRel, sha256(companyDecisionBytes), companyDecision.record_count ?? null);
  await addEntry("COMPANY_DIRECTORY", companyDirectoryArtifactPath, companyDecision.artifact_sha256, companyDecision.record_count ?? null);
  await addEntry("COMPANY_DIRECTORY_MANIFEST", companyDirectoryManifestPath, companyDecision.manifest_sha256, null);

  // Timeline Fact Narrative Policy decision: a standalone leaf decision
  // (see gap-classification.mjs's header comment) -- also not yet part of
  // any release decision schema. Required to be APPROVED, since an
  // unapproved policy decision has no business being pinned into a
  // release bundle.
  const timelineDecisionRel = toRootRelative(root, path.resolve(root, timelinePolicyDecisionPath));
  const timelineDecisionBytes = await readVerifiedFile(root, timelineDecisionRel, "timeline fact narrative policy decision");
  const timelineDecision = JSON.parse(timelineDecisionBytes.toString("utf8"));
  if (timelineDecision.owner_disposition !== "APPROVED") {
    throw new Error(`computeReleaseBundleClosure: timeline policy decision owner_disposition is "${timelineDecision.owner_disposition}", not "APPROVED"`);
  }
  await addEntry("TIMELINE_FACT_NARRATIVE_POLICY_DECISION", timelineDecisionRel, sha256(timelineDecisionBytes), null);

  return Object.freeze({
    release_id: decision.release_id,
    approved_revision: decision.approved_revision,
    corpus_snapshot_id: decision.corpus_snapshot_id,
    fact_coverage_snapshot_id: decision.fact_coverage_snapshot_id,
    entries: Object.freeze([...closure.values()].sort((a, b) => a.path.localeCompare(b.path))),
  });
}
