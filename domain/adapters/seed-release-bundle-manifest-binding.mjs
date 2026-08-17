// Turn K item B: the bundle manifest must never approve itself. This
// mirrors the SAME external-pinning shape domain/adapters/
// seed-runtime-service-adapters.mjs already uses for the canonical/
// structured manifests (a release decision pins their path+raw-byte
// SHA-256, and construction re-hashes the REAL file rather than trusting
// any self-declared hash inside the manifest) -- applied one level up, to
// the bundle manifest itself.
//
// No v0.20 release decision exists yet (Turn K forbids creating one). This
// module is the CONTRACT + fixture-tested verifier a future v0.20 decision
// will be checked against: assertBundleManifestBinding(decisionLike,
// bundleManifestPath, root) takes any object with a `bundle_manifest:
// {path, sha256}` field (a real v0.20 decision, or a test fixture shaped
// like one) and fails closed unless the REAL file at that path, read as
// raw bytes RIGHT NOW, hashes to exactly that pinned value. A bundle
// manifest that is internally self-consistent (all of its own declared
// entry hashes check out) but was swapped for a different bundle manifest
// altogether -- even one that still passes verifyReleaseBundleDirectoryMatchesManifest
// against ITS OWN entries -- is refused, because the decision's pin no
// longer matches the swapped file's real bytes.
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { ReleaseNotApprovedError } from "./seed-runtime-service-adapters.mjs";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function assertNoSymlink(candidatePath, label) {
  const resolved = path.resolve(candidatePath);
  let real;
  try { real = await realpath(resolved); }
  catch (error) { throw new ReleaseNotApprovedError(`${label}: path could not be resolved: ${error.message}`); }
  if (real !== resolved) throw new ReleaseNotApprovedError(`${label}: path involves a symlink, which is not permitted`);
}

// decisionLike: any object exposing `bundle_manifest: { path, sha256 }`
// (a real future v0.20 decision, or a test fixture). bundleManifestPath is
// the ACTUAL path this process was given to treat as "the bundle
// manifest" -- exactly like canonical/structured manifest binding, the
// caller-supplied path must itself normalize to what the decision
// declares; a byte-identical copy at a different path is refused.
export async function assertBundleManifestBinding(decisionLike, bundleManifestPath, root) {
  if (!decisionLike || typeof decisionLike !== "object") {
    throw new ReleaseNotApprovedError("assertBundleManifestBinding: decisionLike must be an object");
  }
  const pin = decisionLike.bundle_manifest;
  if (!pin || typeof pin.path !== "string" || pin.path === "" || typeof pin.sha256 !== "string") {
    throw new ReleaseNotApprovedError("assertBundleManifestBinding: decision is missing a bundle_manifest {path, sha256} pin");
  }
  if (typeof bundleManifestPath !== "string" || bundleManifestPath === "") {
    throw new ReleaseNotApprovedError("assertBundleManifestBinding: bundleManifestPath is required");
  }
  if (typeof root !== "string" || root === "") {
    throw new ReleaseNotApprovedError("assertBundleManifestBinding: root is required");
  }

  const actualAbs = path.resolve(root, bundleManifestPath);
  const declaredAbs = path.resolve(root, pin.path);
  if (actualAbs !== declaredAbs) {
    throw new ReleaseNotApprovedError(
      `assertBundleManifestBinding: bundleManifestPath (${actualAbs}) does not match the decision's declared bundle_manifest.path (${declaredAbs})`,
    );
  }

  await assertNoSymlink(actualAbs, "bundle manifest");

  let bytes;
  try {
    bytes = await readFile(actualAbs);
  } catch (error) {
    throw new ReleaseNotApprovedError(`assertBundleManifestBinding: bundle manifest could not be read: ${error.message}`);
  }
  const actualSha256 = sha256(bytes);
  if (actualSha256 !== pin.sha256) {
    throw new ReleaseNotApprovedError(
      `assertBundleManifestBinding: bundle manifest sha256 mismatch (actual ${actualSha256}, decision-pinned ${pin.sha256}) -- ` +
        "the bundle manifest file was replaced after the decision pinned it, or the decision pins the wrong file",
    );
  }

  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new ReleaseNotApprovedError(`assertBundleManifestBinding: bundle manifest is not valid JSON: ${error.message}`);
  }
  return Object.freeze({ bundleManifestPath: actualAbs, bundleManifestSha256: actualSha256, bundleManifest: manifest });
}
