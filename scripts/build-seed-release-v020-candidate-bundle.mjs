// Turn L2: builds the actual v0.20 CANDIDATE deployment bundle at its
// real, Git-trackable location (domain/releases/bundles/seed-release-v0.20/
// -- see .gitignore's negation rule for that one path). This is the SAME
// bundle the isolated portability test (tests/
// seed-release-isolated-deployment-e2e.test.mjs) copies byte-for-byte and
// unpacks -- it is never rebuilt from work/domain-seed inside that test
// anymore (Turn L2 item 2's fix).
//
// Uses seed-company-directory.v0.2.approved.* (Turn K item F's
// byte-equivalent promotion) per Turn L2 item 5 -- v0.1 candidate is
// audit history only from here on. domain/runtime/configured-seed-runtime.mjs
// itself is NOT repointed at v0.2 or at this bundle by this script; that
// remains a deliberately separate, not-yet-taken step (see Turn K item G
// / Turn L2 item 5's closing sentence).
//
// status stays CANDIDATE -- this script never creates or implies a v0.20
// release decision.
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildReleaseBundle } from "../domain/adapters/seed-release-bundle-builder.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE_DIR = "domain/releases/bundles/seed-release-v0.20";
const MAX_SINGLE_FILE_BYTES = 100 * 1024 * 1024; // 100 MiB (Turn L2 item 1's hard requirement)

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

async function walkFiles(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(full, base)));
    else if (entry.isFile()) files.push(path.relative(base, full));
  }
  return files;
}

async function main() {
  const result = await buildReleaseBundle({
    bundleDir: BUNDLE_DIR, status: "CANDIDATE", root: REPO,
    structuredManifestPath: "work/domain-seed/seed-structured-artifacts.v0.6.manifest.json",
    canonicalReleaseManifestPath: "domain/releases/seed-release.v0.19.manifest.json",
    planPath: "work/domain-seed/seed-thin-flow-plans.v0.6.jsonl",
    planManifestPath: "work/domain-seed/seed-thin-flow-plans.v0.6.manifest.json",
    expectedReleaseId: "seed-release-v0.19", expectedApprovedRevision: "seed-structured-artifacts-v0.6",
    companyDirectoryArtifactPath: "work/domain-seed/seed-company-directory.v0.2.approved.jsonl",
    companyDirectoryManifestPath: "work/domain-seed/seed-company-directory.v0.2.approved.manifest.json",
    companyDirectoryOwnerDecisionPath: "work/domain-seed/seed-company-directory-owner-decision.v0.2.approved.json",
    timelinePolicyDecisionPath: "work/domain-seed/seed-timeline-fact-narrative-policy-decision.v0.1.json",
  });

  const bundleDirAbs = path.resolve(REPO, BUNDLE_DIR);
  const files = await walkFiles(bundleDirAbs);
  let totalEncodedBytes = 0;
  const oversized = [];
  const fileSizes = [];
  for (const relPath of files) {
    const st = await stat(path.join(bundleDirAbs, relPath));
    totalEncodedBytes += st.size;
    fileSizes.push({ path: relPath, bytes: st.size });
    if (st.size >= MAX_SINGLE_FILE_BYTES) oversized.push({ path: relPath, bytes: st.size });
  }
  const containsRawDocumentIr = files.some((f) => /seed-canonical-document-ir.*\.jsonl$/.test(f) && !f.endsWith(".gz"));

  if (oversized.length > 0) {
    throw new Error(`BLOCKER: ${oversized.length} bundle file(s) are >= 100MiB: ${oversized.map((f) => `${f.path} (${f.bytes} bytes)`).join(", ")}`);
  }
  if (containsRawDocumentIr) {
    throw new Error("BLOCKER: bundle contains an uncompressed raw Canonical DocumentIR shard -- every DocumentIR shard must be the .gz form only");
  }

  const report = {
    bundle_dir: BUNDLE_DIR,
    bundle_manifest_sha256: result.bundleManifestSha256,
    status: "CANDIDATE",
    file_count: files.length,
    total_encoded_bytes: totalEncodedBytes,
    total_encoded_mib: Number((totalEncodedBytes / (1024 * 1024)).toFixed(2)),
    largest_file: fileSizes.sort((a, b) => b.bytes - a.bytes)[0],
    max_single_file_bytes_limit: MAX_SINGLE_FILE_BYTES,
    contains_raw_document_ir: containsRawDocumentIr,
    all_files_under_100mib: oversized.length === 0,
  };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
