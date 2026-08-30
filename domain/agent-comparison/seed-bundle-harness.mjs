// Read-only harness that gets a (context, serviceAdapters) pair for the
// REAL, already-approved v0.20-r3 portable bundle -- the SAME bundle
// domain/runtime/configured-seed-runtime.mjs (production) already serves,
// and the SAME verification steps
// (domain/runtime/bundle-backed-seed-runtime.mjs performs before handing
// data to its OWN Flow, createThinStructuredFlow). This module never
// constructs a Flow itself and is never imported by app/ or by
// configured-seed-runtime.mjs -- it exists purely so an Agent-comparison
// AgentFlow (any of them, not just STRUCTURED_FIRST) can be smoke-tested
// against real VERIFIED data through the SAME
// createSeedRuntimeServiceAdapters construction point production uses,
// without this Turn touching production wiring at all.
//
// Nothing here writes to domain/releases/bundles/... or to any
// git-tracked file -- the bundle is unpacked into a fresh private
// mkdtemp() directory and that directory is removed by dispose().
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertBundleManifestBinding } from "../adapters/seed-release-bundle-manifest-binding.mjs";
import { verifyReleaseBundleDirectoryMatchesManifest } from "../adapters/seed-release-bundle-builder.mjs";
import { unpackReleaseBundle } from "../adapters/seed-release-bundle-unpack.mjs";
import { createSeedRuntimeServiceAdapters } from "../adapters/seed-runtime-service-adapters.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Matches domain/runtime/configured-seed-runtime.mjs's own pins exactly --
// duplicated here (not imported) because that module's constants are not
// exported, and this harness must never import anything from
// configured-seed-runtime.mjs itself (that module has module-level
// side effects: it eagerly constructs the process-wide production
// runtime singleton on import).
const EXPECTED_RELEASE_ID = "seed-release-v0.20";
const EXPECTED_APPROVED_REVISION = "seed-structured-artifacts-v0.7";

export async function createSeedBundleHarness({
  root = process.cwd(),
  bundleDir = path.resolve(root, "domain/releases/bundles/seed-release-v0.20-r3.candidate"),
  bundleManifestPath = path.resolve(root, "domain/releases/bundles/seed-release-v0.20-r3.candidate/bundle-manifest.json"),
  finalManifestPath = path.resolve(root, "domain/releases/seed-release.v0.20.manifest.json"),
  finalDecisionPath = path.resolve(root, "domain/releases/seed-release.v0.20.decision.json"),
} = {}) {
  const [manifestBytes, decisionBytes] = await Promise.all([readFile(finalManifestPath), readFile(finalDecisionPath)]);
  const finalManifest = JSON.parse(manifestBytes.toString("utf8"));
  const finalDecision = JSON.parse(decisionBytes.toString("utf8"));
  if (finalManifest.release_authorization?.decision_artifact_sha256 !== sha256(decisionBytes)) {
    throw new Error("final release decision SHA does not match the final manifest authorization pin");
  }
  if (finalDecision.status !== "APPROVED" || finalDecision.release_id !== EXPECTED_RELEASE_ID) {
    throw new Error("final release decision does not approve the expected v0.20 release");
  }
  await assertBundleManifestBinding(finalDecision, bundleManifestPath, root);
  await verifyReleaseBundleDirectoryMatchesManifest({ bundleDir });

  const realTempRoot = await realpath(os.tmpdir());
  const materializedRoot = await mkdtemp(path.join(realTempRoot, "agent-comparison-seed25-smoke-"));
  await unpackReleaseBundle({ bundleDir, destRoot: materializedRoot });
  for (const [absolutePath, bytes] of [[finalManifestPath, manifestBytes], [finalDecisionPath, decisionBytes]]) {
    const relative = path.relative(root, absolutePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("final release control path escapes root");
    const destination = path.join(materializedRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: "wx" });
  }

  const { context, serviceAdapters } = await createSeedRuntimeServiceAdapters({
    root: materializedRoot,
    structuredManifestPath: path.join(materializedRoot, "work/domain-seed/seed-structured-artifacts.v0.7.manifest.json"),
    canonicalReleaseManifestPath: path.join(materializedRoot, path.relative(root, finalManifestPath)),
    planPath: path.join(materializedRoot, "work/domain-seed/seed-thin-flow-plans.v0.13.clean.candidate.jsonl"),
    planManifestPath: path.join(materializedRoot, "work/domain-seed/seed-thin-flow-plans.v0.13.clean.candidate.manifest.json"),
    expectedReleaseId: EXPECTED_RELEASE_ID,
    expectedApprovedRevision: EXPECTED_APPROVED_REVISION,
  });

  return {
    context,
    serviceAdapters,
    async dispose() {
      await rm(materializedRoot, { recursive: true, force: true }).catch(() => {});
    },
  };
}
