// Turn P3: read-only release identity pin for ComparisonRecord
// (release_id, release_manifest_sha256). Deliberately does NOT import or
// modify domain/agent-comparison/seed-bundle-harness.mjs -- it reads the
// same git-tracked, already-approved bundle-manifest.json bytes
// independently, the same duplication-over-coupling pattern
// seed-bundle-harness.mjs itself already uses for EXPECTED_RELEASE_ID
// (see that file's own comment: duplicated rather than imported, to avoid
// depending on a module with unwanted side effects / to keep this reader
// independent of that harness's own construction path).
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

// Matches seed-bundle-harness.mjs's own EXPECTED_RELEASE_ID exactly (Turn
// P1's pin for the v0.20-r3 bundle) and configured-seed-runtime.mjs's
// production pin -- never changed here independently of those.
export const EXPECTED_RELEASE_ID = "seed-release-v0.20";

export async function computeReleaseManifestSha256({
  root = process.cwd(),
  bundleManifestPath = path.resolve(root, "domain/releases/bundles/seed-release-v0.20-r3.candidate/bundle-manifest.json"),
} = {}) {
  const bytes = await readFile(bundleManifestPath);
  return createHash("sha256").update(bytes).digest("hex");
}
