import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertBundleManifestBinding } from "../adapters/seed-release-bundle-manifest-binding.mjs";
import { verifyReleaseBundleDirectoryMatchesManifest } from "../adapters/seed-release-bundle-builder.mjs";
import { unpackReleaseBundle } from "../adapters/seed-release-bundle-unpack.mjs";
import { createNoFlowConnectedRunner } from "./no-flow-connected-runner.mjs";
import { createSeedThinRunner } from "./seed-thin-runner.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Production bootstrap for a Git-tracked portable bundle. Control-plane
// files (final manifest/decision) are verified from the source tree, then
// copied into a fresh private temp root together with the fully verified
// bundle payload. Runtime stores are constructed only after every bundle
// entry has passed encoded/decoded hashes and decompression limits.
export function createBundleBackedSeedRuntime({
  root,
  bundleDir,
  bundleManifestPath,
  finalManifestPath,
  finalDecisionPath,
  expectedReleaseId,
  expectedApprovedRevision,
  expectedCompanyDirectoryOwnerDecisionSha256,
} = {}) {
  for (const [name, value] of Object.entries({ root, bundleDir, bundleManifestPath, finalManifestPath, finalDecisionPath })) {
    if (typeof value !== "string" || value === "") throw new TypeError(`${name} is required`);
  }
  const fallback = createNoFlowConnectedRunner();
  let state = "IDLE";
  let runner = null;
  let initialization;
  let materializedRoot = null;

  async function initialize() {
    initialization ??= (async () => {
      state = "INITIALIZING";
      try {
        const [manifestBytes, decisionBytes] = await Promise.all([
          readFile(finalManifestPath), readFile(finalDecisionPath),
        ]);
        const finalManifest = JSON.parse(manifestBytes.toString("utf8"));
        const finalDecision = JSON.parse(decisionBytes.toString("utf8"));
        if (finalManifest.release_authorization?.decision_artifact_sha256 !== sha256(decisionBytes)) {
          throw new Error("final release decision SHA does not match the final manifest authorization pin");
        }
        if (finalDecision.status !== "APPROVED" || finalDecision.release_id !== expectedReleaseId) {
          throw new Error("final release decision does not approve the expected production release");
        }
        await assertBundleManifestBinding(finalDecision, bundleManifestPath, root);
        await verifyReleaseBundleDirectoryMatchesManifest({ bundleDir });

        const realTempRoot = await realpath(os.tmpdir());
        materializedRoot = await mkdtemp(path.join(realTempRoot, "seed-release-v020-production-"));
        await unpackReleaseBundle({ bundleDir, destRoot: materializedRoot });
        for (const [relativePath, bytes] of [[finalManifestPath, manifestBytes], [finalDecisionPath, decisionBytes]]) {
          const relative = path.relative(root, relativePath);
          if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("final release control path escapes root");
          const destination = path.join(materializedRoot, relative);
          await mkdir(path.dirname(destination), { recursive: true });
          await writeFile(destination, bytes, { flag: "wx" });
        }

        runner = await createSeedThinRunner({
          root: materializedRoot,
          structuredManifestPath: path.join(materializedRoot, "work/domain-seed/seed-structured-artifacts.v0.7.manifest.json"),
          canonicalReleaseManifestPath: path.join(materializedRoot, path.relative(root, finalManifestPath)),
          planPath: path.join(materializedRoot, "work/domain-seed/seed-thin-flow-plans.v0.13.clean.candidate.jsonl"),
          planManifestPath: path.join(materializedRoot, "work/domain-seed/seed-thin-flow-plans.v0.13.clean.candidate.manifest.json"),
          expectedReleaseId,
          expectedApprovedRevision,
          requireOwnerBatchDecision: true,
          requireCompanyDirectory: true,
          companyDirectoryArtifactPath: path.join(materializedRoot, "work/domain-seed/seed-company-directory.v0.2.approved.jsonl"),
          companyDirectoryManifestPath: path.join(materializedRoot, "work/domain-seed/seed-company-directory.v0.2.approved.manifest.json"),
          companyDirectoryOwnerDecisionPath: path.join(materializedRoot, "work/domain-seed/seed-company-directory-owner-decision.v0.2.approved.json"),
          expectedCompanyDirectoryOwnerDecisionSha256,
        });
        state = "READY";
        return true;
      } catch {
        if (materializedRoot) await rm(materializedRoot, { recursive: true, force: true }).catch(() => {});
        materializedRoot = null;
        runner = null;
        state = "FAILED";
        return false;
      }
    })();
    return initialization;
  }

  return Object.freeze({
    async run(question, requestOptions = {}) {
      const ready = await initialize();
      return ready ? runner(question, requestOptions) : fallback(question, requestOptions);
    },
    initialize,
    readiness() {
      return Object.freeze({
        status: state,
        ready: state === "READY",
        error_code: state === "FAILED" ? "SEED_RUNTIME_INIT_FAILED" : null,
      });
    },
  });
}
