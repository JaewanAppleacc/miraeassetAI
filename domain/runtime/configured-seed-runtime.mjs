import path from "node:path";
import { createManagedSeedThinRuntime } from "./seed-thin-runner.mjs";

function optionalPath(env, name, root) {
  const value = env[name];
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.trim() !== value) throw new TypeError(`${name} must be a trimmed path`);
  return path.resolve(root, value);
}

// Deployment may mount the immutable Seed bundle outside the source tree.
// The selected paths are copied once at module construction; later env
// mutation cannot redirect a live process to a different artifact set.
export function readSeedRuntimeConfiguration(env = process.env, cwd = process.cwd()) {
  const configuredRoot = env.SEED_RUNTIME_ROOT;
  if (configuredRoot !== undefined && (typeof configuredRoot !== "string" || configuredRoot === "" || configuredRoot.trim() !== configuredRoot)) {
    throw new TypeError("SEED_RUNTIME_ROOT must be a non-empty trimmed path");
  }
  const root = path.resolve(cwd, configuredRoot ?? ".");
  return Object.freeze({
    root,
    structuredManifestPath: optionalPath(env, "SEED_STRUCTURED_MANIFEST_PATH", root),
    canonicalReleaseManifestPath: optionalPath(env, "SEED_CANONICAL_RELEASE_MANIFEST_PATH", root),
    planPath: optionalPath(env, "SEED_PLAN_PATH", root),
    planManifestPath: optionalPath(env, "SEED_PLAN_MANIFEST_PATH", root),
  });
}

// Process-wide immutable-artifact runtime. Both /answer and /ready share
// the same single initialization attempt and readiness state.
//
// v0.19 (owner_batch_decision now genuinely load-bearing): v0.18 resolved
// the v0.17 audit finding (domain/releases/seed-release.v0.17.BLOCKED.audit-report.json)
// -- Owner (최재완) reviewed and APPROVEd all 6 items via a real,
// externally authored decision artifact (work/domain-seed/seed-structured-
// owner-decision.v0.7-batch.decision.jsonl) -- but v0.18's decision only
// DECLARED that binding (path/sha256/record_count/all_approve); nothing in
// createSeedRuntimeServiceAdapters actually read or verified it, so it was
// decorative, not load-bearing. domain/adapters/seed-runtime-service-
// adapters.mjs now runs assertOwnerBatchDecisionBinding as part of every
// construction: path safety (root-relative, no absolute/".." segments, no
// symlink anywhere along the path), raw-byte SHA-256, fatal-UTF-8 JSONL
// parsing, actual record_count, no duplicate fact_id/evidence_id, every
// item APPROVE with a reviewer matching approved_by and a valid ISO
// reviewed_at, a recomputed (never merely trusted) all_approve, and two
// cross-validations: every item must resolve in the promoted VERIFIED
// Fact/Evidence stores AND match exactly (evidence_id/owner_disposition/
// reviewer/reviewed_at) the structured manifest's own merged
// OWNER_DECISION artifact. v0.19 reuses v0.18's data byte-for-byte (Fact
// v0.7/Evidence v0.9/Coverage v0.6/Gold v0.17/Plan v0.6/Chain v0.2, all
// unchanged) -- see domain/releases/seed-release.v0.19.manifest.json /
// .decision.json and tests/seed-owner-batch-decision-binding.test.mjs for
// the full attack-scenario coverage of the new check. v0.18's own
// manifest/decision are never modified.
//
// v0.19 does NOT claim the overall Release Gate is open: Q07/Q21/Q24
// metric_fail (4) and 17 REVIEW_REQUIRED items remain unresolved and are
// explicitly tracked as BLOCKED in domain/releases/seed-release.v0.18.RELEASE_GATE_STATUS.json
// (unchanged, still accurate) -- this singleton serves grounded STRUCTURED
// answers again (the Runtime/API gate passes), but that is a narrower
// claim than "ready to ship". No new Facts or Thin Flow templates were
// added to move Seed scores. v0.18/v0.17/v0.5 and v0.16/v0.4 remain on
// disk, untouched, as audit history.
//
// An env override below reaches the exact same release-authorization gate
// as this default, so redirecting SEED_CANONICAL_RELEASE_MANIFEST_PATH/
// SEED_PLAN_PATH/SEED_PLAN_MANIFEST_PATH to an unapproved manifest or plan
// still fails closed -- the override changes WHICH artifact is read, never
// whether it must be authorized.
//
// PRODUCTION ANTI-ROLLBACK (adapter-code hardening only -- no new release
// revision was needed; v0.19's existing release_id/approved_revision
// already carry everything this policy checks): a byte-valid,
// correctly-decision-bound release is not automatically a CURRENT one.
// domain/releases/seed-release.v0.17.manifest.json is exactly this kind of
// trap: self-consistent, same corpus_snapshot_id, and (before this
// hardening) constructed successfully even via an env-var override --
// despite being discarded audit history (self-approved batch, see
// seed-release.v0.17.BLOCKED.audit-report.json). expectedReleaseId/
// expectedApprovedRevision/requireOwnerBatchDecision below are the
// operational policy that closes that gap (see assertExpectedReleaseIdentity
// in domain/adapters/seed-runtime-service-adapters.mjs) -- they are
// hardcoded literals, NEVER read from `configured`/environment variables,
// so an env override can redirect WHICH file is read but can never change
// WHICH release identity this process is willing to accept. Redirecting
// SEED_CANONICAL_RELEASE_MANIFEST_PATH (alone or together with the
// matching structured/plan paths) to v0.17, v0.18, or any release whose
// release_id/approved_revision don't match below fails closed with
// RELEASE_NOT_APPROVED -- see tests/seed-runtime-production-anti-rollback.test.mjs.
const EXPECTED_RELEASE_ID = "seed-release-v0.19";
const EXPECTED_APPROVED_REVISION = "seed-structured-artifacts-v0.6";

// Company Directory / CompanyResolver -- Turn J: an independently-verified
// Candidate (work/domain-seed/seed-company-directory.v0.1.candidate.jsonl,
// 70/70 records cross-checked against companies.jsonl, corpus_snapshot_id
// confirmed identical to v0.19's) was APPROVED by Owner (최재완) via
// work/domain-seed/seed-company-directory-owner-decision.v0.1.approved.json
// (never a self-approval, never an edit of the earlier PENDING template --
// see that file's own `supersedes_template_path`/`supersedes_template_sha256`).
// These are hardcoded literals (the SAME "pin WHICH identity this process
// accepts, let env only redirect WHICH file is read" pattern as
// EXPECTED_RELEASE_ID/EXPECTED_APPROVED_REVISION above) -- an env override
// redirecting the artifact/manifest/decision paths to different bytes still
// fails closed via createGatedSeedCompanyResolver's own hash/path/symlink/
// corpus_snapshot_id checks (see bindCompanyResolver in
// seed-runtime-service-adapters.mjs), because the sha256 pinned here never
// changes with the path. If this decision is ever superseded, this pin (not
// just the path) must be updated deliberately, not silently redirected.
const EXPECTED_COMPANY_DIRECTORY_OWNER_DECISION_SHA256 = "2d8766ba4c5c1da42758b7823feca96cbbab58e844dac6e68c580709f5c22a20";

const configured = readSeedRuntimeConfiguration();
export const configuredSeedRuntime = createManagedSeedThinRuntime({
  ...configured,
  structuredManifestPath: configured.structuredManifestPath
    ?? path.resolve(configured.root, "work/domain-seed/seed-structured-artifacts.v0.6.manifest.json"),
  canonicalReleaseManifestPath: configured.canonicalReleaseManifestPath
    ?? path.resolve(configured.root, "domain/releases/seed-release.v0.19.manifest.json"),
  planPath: configured.planPath ?? path.resolve(configured.root, "work/domain-seed/seed-thin-flow-plans.v0.6.jsonl"),
  planManifestPath: configured.planManifestPath
    ?? path.resolve(configured.root, "work/domain-seed/seed-thin-flow-plans.v0.6.manifest.json"),
  expectedReleaseId: EXPECTED_RELEASE_ID,
  expectedApprovedRevision: EXPECTED_APPROVED_REVISION,
  requireOwnerBatchDecision: true,
  requireCompanyDirectory: true,
  companyDirectoryArtifactPath: path.resolve(configured.root, "work/domain-seed/seed-company-directory.v0.1.candidate.jsonl"),
  companyDirectoryManifestPath: path.resolve(configured.root, "work/domain-seed/seed-company-directory.v0.1.candidate.manifest.json"),
  companyDirectoryOwnerDecisionPath: path.resolve(configured.root, "work/domain-seed/seed-company-directory-owner-decision.v0.1.approved.json"),
  expectedCompanyDirectoryOwnerDecisionSha256: EXPECTED_COMPANY_DIRECTORY_OWNER_DECISION_SHA256,
});
