import path from "node:path";
import { createBundleBackedSeedRuntime } from "./bundle-backed-seed-runtime.mjs";

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

// Process-wide production runtime. Both /answer and /ready share one lazy
// initialization. v0.20 reads its data exclusively from the Git-tracked r3
// portable bundle: the external final decision first pins the bundle
// manifest, then every encoded/decoded entry is verified and materialized
// into a fresh private temp root. The hardcoded release identity prevents
// environment overrides from rolling production back to an older release.
const EXPECTED_RELEASE_ID = "seed-release-v0.20";
const EXPECTED_APPROVED_REVISION = "seed-structured-artifacts-v0.7";

// The approved Company Directory v0.2 decision is separately caller-pinned;
// bundle integrity alone cannot swap the entity-label authority.
const EXPECTED_COMPANY_DIRECTORY_OWNER_DECISION_SHA256 = "01bfb35409b304b7ff2b709774b41615e3087150b90a0abfd25e5f228cd73d47";

const configured = readSeedRuntimeConfiguration();
export const configuredSeedRuntime = createBundleBackedSeedRuntime({
  root: configured.root,
  bundleDir: path.resolve(configured.root, "domain/releases/bundles/seed-release-v0.20-r3.candidate"),
  bundleManifestPath: path.resolve(configured.root, "domain/releases/bundles/seed-release-v0.20-r3.candidate/bundle-manifest.json"),
  finalManifestPath: path.resolve(configured.root, "domain/releases/seed-release.v0.20.manifest.json"),
  finalDecisionPath: path.resolve(configured.root, "domain/releases/seed-release.v0.20.decision.json"),
  expectedReleaseId: EXPECTED_RELEASE_ID,
  expectedApprovedRevision: EXPECTED_APPROVED_REVISION,
  expectedCompanyDirectoryOwnerDecisionSha256: EXPECTED_COMPANY_DIRECTORY_OWNER_DECISION_SHA256,
});
