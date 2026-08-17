// One fail-closed construction point for the read-only Seed adapters that
// Runtime Host accepts through runAgentFlow(..., serviceAdapters). It does
// not create a Flow or answer policy. It only turns two explicit manifests
// (canonical DocumentIR + VERIFIED structured artifacts) into one pinned
// SharedContext and the four corresponding data adapters.
//
// RELEASE AUTHORIZATION BOUNDARY (added after the v0.15/v0.3 independent
// audit found that a manifest's own self-declared status:"VERIFIED_SEED_SUBSET"
// was being trusted with no human sign-off gate at all, and hardened again
// after a follow-up audit found the first version of this gate trusted the
// canonical manifest's OWN self-declared release_authorization block with no
// verification against an actual decision record): the canonical release
// manifest a caller points this at -- whether via the default path or via
// SEED_CANONICAL_RELEASE_MANIFEST_PATH -- must carry a release_authorization
// block whose decision_artifact_path resolves (safely, within root, with no
// symlink escape) to a real, readable JSON decision artifact whose own bytes
// hash to decision_artifact_sha256, and whose CONTENT independently confirms
// approved_by/approved_at/status AND binds the full approved release bundle
// (both manifests' own path+hash, corpus/coverage snapshot ids, release_id,
// approved revision, and every artifact's role/path/sha256/record_count in
// both manifests). "Path" here is load-bearing, not decorative: the actual
// canonicalReleaseManifestPath/structuredManifestPath this process was
// given must normalize (root-relative, "."/duplicate-separator-collapsed)
// to EXACTLY what the decision artifact declares, and must involve no
// symlink anywhere along the path -- byte-identical content copied to a
// different location, or reached through a same-named symlink alias, is
// refused even though its hash would match. Any missing/extra/mismatched
// artifact, or either manifest having been swapped for a different one
// (even a same-corpus-snapshot one, or a byte-identical copy at another
// path), fails closed with RELEASE_NOT_APPROVED before any Seed artifact is
// read.
// No manifest in this repository currently carries a release_authorization
// block, so this intentionally fails closed for every manifest that exists
// today, including domain/releases/seed-release.v0.15.draft.manifest.json.
// This is a release-authorization check only: it does not promote, verify,
// or otherwise alter the Candidate data it might be pointed at.
//
// PLAN + CHAIN BINDING (hardened after independent review found the Thin
// plan sat entirely outside this boundary -- any planPath/planManifestPath
// with a matching snapshot id, including one supplied via
// SEED_PLAN_PATH/SEED_PLAN_MANIFEST_PATH, could be substituted freely):
// planPath/planManifestPath are now REQUIRED constructor arguments, bound
// exactly like the canonical/structured manifests (path+hash+symlink,
// via the same assertManifestPathAndHashBinding), plus the plan
// manifest's own declared corpus/coverage snapshot ids and its
// source_gold/source_coverage path strings are cross-checked against the
// decision's own pins for them (which are in turn already proven to match
// the approved SEED_GOLD/FACT_COVERAGE_SNAPSHOT artifacts). The ONLY
// planPath/planManifestPath this function will ever accept are returned
// back to the caller as `authorizedRuntimeAssets` -- callers (see
// domain/runtime/seed-thin-runner.mjs) must open the plan store from
// THAT returned path, never from their own raw constructor argument, so
// a caller-side bug can never reintroduce the bypass this hardening
// closes. The structured manifest must also pin a CHAIN_MANIFEST role
// (16 Chain records for the current Seed corpus); construction verifies
// every non-null Event/Relation chain_id resolves in it, every Chain's
// own relation_ids resolve in the VERIFIED Relation set, and every
// Chain's own document_ids resolve in the canonical DocumentIR store.
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createSeedCanonicalDocumentIrStore } from "./seed-canonical-document-ir-store.mjs";
import { createSeedEvidenceArtifactStore } from "./seed-evidence-artifact-store.mjs";
import { createSeedFactArtifactStore } from "./seed-fact-artifact-store.mjs";
import { createSeedStructuredQueryAdapter } from "./seed-structured-query-adapter.mjs";
import { createGatedSeedCompanyResolver } from "./seed-company-resolver.mjs";

// A distinguishable, allowlisted error code (see createManagedSeedThinRuntime
// in seed-thin-runner.mjs) -- never a free-text message, so /ready can surface
// *which* fail-closed reason applied without leaking paths or stack traces.
export class ReleaseNotApprovedError extends Error {
  constructor(reason) {
    super(`RELEASE_NOT_APPROVED: ${reason}`);
    this.name = "ReleaseNotApprovedError";
    this.code = "RELEASE_NOT_APPROVED";
  }
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function strictUtf8(buffer, source) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch (error) { throw new Error(`${source}: invalid UTF-8: ${error.message}`); }
}

async function readManifestWithBytes(manifestPath) {
  let bytes;
  try { bytes = await readFile(manifestPath); }
  catch (error) { throw new Error(`${manifestPath}: could not read manifest: ${error.message}`); }
  let value;
  try { value = JSON.parse(strictUtf8(bytes, manifestPath)); }
  catch (error) { throw new Error(`${manifestPath}: invalid manifest: ${error.message}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${manifestPath}: manifest must be an object`);
  return { value, bytes };
}

function roleMap(manifest, source) {
  const result = new Map();
  for (const artifact of manifest.artifacts ?? []) {
    if (typeof artifact?.role !== "string" || result.has(artifact.role)) throw new Error(`${source}: invalid or duplicate artifact role`);
    result.set(artifact.role, structuredClone(artifact));
  }
  return result;
}

function requireRole(roles, role, source) {
  const pin = roles.get(role);
  if (!pin) throw new Error(`${source}: missing role ${role}`);
  if (typeof pin.path !== "string" || !/^[0-9a-f]{64}$/.test(pin.sha256) || !Number.isInteger(pin.bytes)) {
    throw new Error(`${source}: invalid pin for ${role}`);
  }
  return pin;
}

// --- decision_artifact_path resolution: reject anything that is not a
// plain, root-relative path staying inside root, even after symlinks are
// followed. ---------------------------------------------------------------

function assertSafeRelativePath(candidatePath, root, source, field = "release_authorization.decision_artifact_path") {
  if (typeof candidatePath !== "string" || candidatePath === "") {
    throw new ReleaseNotApprovedError(`${source}: ${field} must be a non-empty string`);
  }
  if (path.isAbsolute(candidatePath)) {
    throw new ReleaseNotApprovedError(`${source}: ${field} must not be an absolute path`);
  }
  if (candidatePath.split(/[\\/]+/).some((segment) => segment === "..")) {
    throw new ReleaseNotApprovedError(`${source}: ${field} must not contain ".." segments`);
  }
  const normalizedRoot = root.endsWith(path.sep) ? root : root + path.sep;
  const resolved = path.resolve(root, candidatePath);
  if (resolved !== root && !resolved.startsWith(normalizedRoot)) {
    throw new ReleaseNotApprovedError(`${source}: ${field} resolves outside root`);
  }
  return resolved;
}

// Defense in depth beyond the textual check above: resolves every symlink
// in the candidate path (and in root, so a symlinked root compares fairly)
// and re-checks containment against the REAL filesystem location, not just
// the textual path. A decision_artifact_path that textually stays under
// root but is (or passes through) a symlink pointing outside root is still
// rejected. A missing file surfaces as RELEASE_NOT_APPROVED, not ENOENT.
async function resolveRealPathWithinRoot(resolvedPath, root, source) {
  let realResolved;
  let realRoot;
  try {
    [realResolved, realRoot] = await Promise.all([realpath(resolvedPath), realpath(root)]);
  } catch (error) {
    throw new ReleaseNotApprovedError(`${source}: decision artifact could not be resolved: ${error.message}`);
  }
  const normalizedRealRoot = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (realResolved !== realRoot && !realResolved.startsWith(normalizedRealRoot)) {
    throw new ReleaseNotApprovedError(`${source}: decision_artifact_path resolves outside root via a symlink`);
  }
  return realResolved;
}

// --- Decision artifact: the only trusted source of "this exact release
// bundle was approved". A canonical manifest's own release_authorization
// block is never trusted for anything beyond WHERE to find this file and
// what its bytes must hash to -- every other authorization fact (status,
// approver, timestamp, and the full approved artifact set) must appear
// again, independently, inside the decision artifact itself. -------------

function assertNonEmptyString(value, field, source) {
  if (typeof value !== "string" || value === "") throw new ReleaseNotApprovedError(`${source}: decision artifact ${field} must be a non-empty string`);
  return value;
}

// Normalization policy for a decision artifact's own declared manifest
// paths (canonical_release_manifest.path / structured_manifest.path):
// treated as POSIX-style, root-relative path text. "." segments and
// duplicate separators are collapsed (so "a/./b" and "a//b" both normalize
// to "a/b" -- benign re-formatting, not a security-relevant difference);
// backslashes are treated as separators too, so the same policy applies
// uniformly regardless of platform. Anything that normalizes to an
// absolute path or a path escaping its own root (starting with "..") is
// rejected outright -- a declared path is only ever meaningful as "this
// file, relative to root".
function normalizeDeclaredRelativePath(raw, field, source) {
  if (typeof raw !== "string" || raw === "") {
    throw new ReleaseNotApprovedError(`${source}: decision artifact ${field}.path must be a non-empty string`);
  }
  const normalized = path.posix.normalize(raw.replaceAll("\\", "/"));
  if (path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    throw new ReleaseNotApprovedError(`${source}: decision artifact ${field}.path must be a root-relative, non-escaping path`);
  }
  return normalized;
}

// Normalizes the ACTUAL path this process was given for a manifest (an
// absolute path, per every caller in this repository) down to the same
// root-relative POSIX form used for the declared path above, purely
// lexically (path.resolve/path.relative -- no filesystem access), so it can
// be compared by exact string equality against what the decision artifact
// declares.
function normalizeActualRelativePath(actualManifestPath, root, field, source) {
  const resolvedRoot = path.resolve(root);
  const resolvedActual = path.resolve(actualManifestPath);
  const relative = path.relative(resolvedRoot, resolvedActual);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ReleaseNotApprovedError(`${source}: ${field} path (${actualManifestPath}) does not resolve within root`);
  }
  return { resolvedActual, normalizedRelative: relative.split(path.sep).join("/") };
}

// Full path+hash binding check for one manifest side (canonical or
// structured). Three independent conditions must ALL hold:
//   1. the manifest path actually used, normalized relative to root, is
//      EXACTLY the path the decision artifact declares for this manifest --
//      byte-identical content copied to a different path is still refused,
//      and so is the same nominal path resolved from a different root;
//   2. that actual path involves no symlink anywhere along it (an alias
//      that happens to have the "right" name/location but is itself a
//      symlink is refused, regardless of what it points to or whether that
//      target's bytes would otherwise hash-match);
//   3. the manifest's own content hash matches decision_artifact_sha256's
//      sibling field for this manifest.
async function assertManifestPathAndHashBinding({ entry, field, actualManifestPath, actualHash, root, source }) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new ReleaseNotApprovedError(`${source}: decision artifact ${field} must be an object`);
  }
  if (typeof entry.sha256 !== "string" || !SHA256_HEX.test(entry.sha256)) {
    throw new ReleaseNotApprovedError(`${source}: decision artifact ${field}.sha256 is missing or malformed`);
  }
  const declaredPath = normalizeDeclaredRelativePath(entry.path, field, source);
  const { resolvedActual, normalizedRelative } = normalizeActualRelativePath(actualManifestPath, root, field, source);
  if (normalizedRelative !== declaredPath) {
    throw new ReleaseNotApprovedError(
      `${source}: decision artifact ${field}.path ("${declaredPath}") does not match the ${field} path actually used ("${normalizedRelative}")`,
    );
  }

  let realActual;
  try { realActual = await realpath(resolvedActual); }
  catch (error) { throw new ReleaseNotApprovedError(`${source}: ${field} path could not be resolved: ${error.message}`); }
  if (realActual !== resolvedActual) {
    throw new ReleaseNotApprovedError(`${source}: ${field} path involves a symlink, which is not permitted`);
  }

  if (entry.sha256 !== actualHash) {
    throw new ReleaseNotApprovedError(`${source}: decision artifact ${field}.sha256 does not match the actual ${field} content`);
  }
}

// Every declared artifact must appear, with an EXACT role/path/sha256/
// record_count match, and no manifest artifact may be missing from the
// declared set, and no declared entry may be left over unmatched (an
// artifact added, removed, or altered in any of these four fields fails
// closed either way).
function assertArtifactSetMatches(declared, actualArtifacts, label, source) {
  if (!Array.isArray(declared)) throw new ReleaseNotApprovedError(`${source}: decision artifact ${label} must be an array`);
  const actual = Array.isArray(actualArtifacts) ? actualArtifacts : [];
  const declaredByRole = new Map();
  for (const entry of declared) {
    if (!entry || typeof entry.role !== "string" || declaredByRole.has(entry.role)) {
      throw new ReleaseNotApprovedError(`${source}: decision artifact ${label} has an invalid or duplicate role entry`);
    }
    declaredByRole.set(entry.role, entry);
  }
  if (declaredByRole.size !== actual.length) {
    throw new ReleaseNotApprovedError(`${source}: decision artifact ${label} count (${declaredByRole.size}) does not match the manifest's artifact count (${actual.length})`);
  }
  for (const artifact of actual) {
    const declaredEntry = declaredByRole.get(artifact.role);
    if (!declaredEntry) {
      throw new ReleaseNotApprovedError(`${source}: decision artifact ${label} is missing an approval entry for role ${artifact.role}`);
    }
    const declaredRecordCount = declaredEntry.record_count ?? null;
    const actualRecordCount = artifact.record_count ?? null;
    if (declaredEntry.path !== artifact.path || declaredEntry.sha256 !== artifact.sha256 || declaredRecordCount !== actualRecordCount) {
      throw new ReleaseNotApprovedError(`${source}: decision artifact ${label} entry for role ${artifact.role} does not match the manifest's own pin (path/sha256/record_count)`);
    }
    declaredByRole.delete(artifact.role);
  }
  if (declaredByRole.size > 0) {
    throw new ReleaseNotApprovedError(`${source}: decision artifact ${label} declares role(s) not present in the manifest: ${[...declaredByRole.keys()].join(", ")}`);
  }
}

// The canonical manifest carries its OWN release_authorization block
// (including the decision artifact's hash), so hashing its raw on-disk bytes
// to bind "the approved canonical manifest" is circular -- the file's bytes
// can never be fixed before the decision artifact naming its hash is
// itself finalized. The content actually being approved is everything
// EXCEPT the authorization stamp attached on top of it afterward (the same
// reason a signature is never computed over itself): this hashes a
// deterministic JSON re-serialization of the manifest with
// release_authorization removed. Re-serializing (rather than trusting
// on-disk byte layout) also means this pin is insensitive to incidental
// re-formatting of the file, which is a property, not a hazard, given the
// structured manifest sibling pin below already hashes real raw bytes.
// Exported so release-bundle authoring tooling (e.g. scripts that mint a
// real release_authorization decision artifact) can compute the exact
// same binding hash this module will later verify against -- never a
// second, hand-reimplemented copy of this algorithm that could silently
// drift from what construction actually checks.
export function canonicalManifestBindingHash(canonicalManifest) {
  const withoutAuthorization = { ...canonicalManifest };
  delete withoutAuthorization.release_authorization;
  return sha256Hex(Buffer.from(`${JSON.stringify(withoutAuthorization, null, 2)}\n`, "utf8"));
}

async function loadAndVerifyDecisionArtifact({ auth, canonicalManifestPath, root }) {
  const safeResolved = assertSafeRelativePath(auth.decision_artifact_path, root, canonicalManifestPath);
  const realResolved = await resolveRealPathWithinRoot(safeResolved, root, canonicalManifestPath);

  let rawBytes;
  try { rawBytes = await readFile(realResolved); }
  catch (error) { throw new ReleaseNotApprovedError(`${canonicalManifestPath}: decision artifact could not be read: ${error.message}`); }

  const actualHash = sha256Hex(rawBytes);
  if (actualHash !== auth.decision_artifact_sha256) {
    throw new ReleaseNotApprovedError(
      `${canonicalManifestPath}: decision artifact sha256 mismatch (declared ${auth.decision_artifact_sha256}, actual ${actualHash})`,
    );
  }

  let decision;
  try { decision = JSON.parse(strictUtf8(rawBytes, realResolved)); }
  catch (error) { throw new ReleaseNotApprovedError(`${canonicalManifestPath}: decision artifact is not valid JSON: ${error.message}`); }
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    throw new ReleaseNotApprovedError(`${canonicalManifestPath}: decision artifact must be a JSON object`);
  }

  // The manifest's own release_authorization block is never trusted alone
  // for status/approver/timestamp -- each must be independently confirmed
  // by the decision artifact's own declared values, byte-for-byte equal.
  if (decision.status !== "APPROVED" || decision.status !== auth.status) {
    throw new ReleaseNotApprovedError(`${canonicalManifestPath}: decision artifact status does not confirm APPROVED`);
  }
  if (assertNonEmptyString(decision.approved_by, "approved_by", canonicalManifestPath) !== auth.approved_by) {
    throw new ReleaseNotApprovedError(`${canonicalManifestPath}: decision artifact approved_by does not match the manifest's declared approved_by`);
  }
  if (assertNonEmptyString(decision.approved_at, "approved_at", canonicalManifestPath) !== auth.approved_at) {
    throw new ReleaseNotApprovedError(`${canonicalManifestPath}: decision artifact approved_at does not match the manifest's declared approved_at`);
  }

  return decision;
}

// Binds the decision artifact to the EXACT release bundle it was written
// for: both manifests' own content hashes, both snapshot ids, release_id,
// the approved structured revision, and every artifact pin in both
// manifests. Swapping either manifest for a different file -- even one
// sharing the same corpus_snapshot_id -- changes that manifest's binding
// hash and/or its artifact set, so it is caught here regardless of which
// manifest was swapped.
async function assertDecisionBindsReleaseBundle({
  decision, canonicalManifest, canonicalManifestPath, structuredManifest, structuredManifestPath, structuredManifestBytes, root,
}) {
  await assertManifestPathAndHashBinding({
    entry: decision.canonical_release_manifest, field: "canonical_release_manifest",
    actualManifestPath: canonicalManifestPath, actualHash: canonicalManifestBindingHash(canonicalManifest),
    root, source: canonicalManifestPath,
  });
  await assertManifestPathAndHashBinding({
    entry: decision.structured_manifest, field: "structured_manifest",
    actualManifestPath: structuredManifestPath, actualHash: sha256Hex(structuredManifestBytes),
    root, source: canonicalManifestPath,
  });

  if (assertNonEmptyString(decision.corpus_snapshot_id, "corpus_snapshot_id", canonicalManifestPath) !== canonicalManifest.corpus_snapshot_id
    || decision.corpus_snapshot_id !== structuredManifest.corpus_snapshot_id) {
    throw new ReleaseNotApprovedError(`${canonicalManifestPath}: decision artifact corpus_snapshot_id does not match both manifests`);
  }
  if (assertNonEmptyString(decision.fact_coverage_snapshot_id, "fact_coverage_snapshot_id", canonicalManifestPath) !== structuredManifest.fact_coverage_snapshot_id) {
    throw new ReleaseNotApprovedError(`${canonicalManifestPath}: decision artifact fact_coverage_snapshot_id does not match the structured manifest`);
  }
  if (assertNonEmptyString(decision.release_id, "release_id", canonicalManifestPath) !== canonicalManifest.release_id) {
    throw new ReleaseNotApprovedError(`${canonicalManifestPath}: decision artifact release_id does not match the canonical manifest's release_id`);
  }
  if (assertNonEmptyString(decision.approved_revision, "approved_revision", canonicalManifestPath) !== structuredManifest.artifact_set_id) {
    throw new ReleaseNotApprovedError(`${canonicalManifestPath}: decision artifact approved_revision does not match the structured manifest's artifact_set_id`);
  }

  assertArtifactSetMatches(decision.canonical_artifacts, canonicalManifest.artifacts, "canonical_artifacts", canonicalManifestPath);
  assertArtifactSetMatches(decision.structured_artifacts, structuredManifest.artifacts, "structured_artifacts", canonicalManifestPath);
}

// --- Thin plan binding: the plan is NOT an implementation detail outside
// the trust boundary. A caller (including SEED_PLAN_PATH/SEED_PLAN_MANIFEST_PATH
// env overrides) can supply ANY planPath/planManifestPath -- this function
// is the only place that decides whether Runtime construction is allowed
// to proceed with it. Every check below must hold: the plan and plan
// manifest's own path+hash bind exactly like a canonical/structured
// manifest (assertManifestPathAndHashBinding, reused verbatim -- same
// symlink/copy/normalization rules), the plan manifest's own declared
// corpus/coverage snapshot ids must equal the already-verified structured
// manifest's, and the plan manifest's own source_gold/source_coverage path
// strings must equal what the decision independently pins for them --
// which are in turn cross-checked against the SEED_GOLD /
// FACT_COVERAGE_SNAPSHOT artifact entries already proven correct by
// assertArtifactSetMatches above. A plan built from a different (even
// same-corpus-snapshot) Gold or Coverage file fails at one of these
// checks, not silently swapped in.
async function assertThinPlanBinding({
  decision, structuredManifest, canonicalManifestPath, planPath, planManifestPath, root,
}) {
  if (typeof planPath !== "string" || planPath === "") throw new Error("planPath is required");
  if (typeof planManifestPath !== "string" || planManifestPath === "") throw new Error("planManifestPath is required");

  const [planBytes, planManifestBytes] = await Promise.all([
    readFile(planPath).catch((error) => { throw new ReleaseNotApprovedError(`${canonicalManifestPath}: thin_plan could not be read: ${error.message}`); }),
    readFile(planManifestPath).catch((error) => { throw new ReleaseNotApprovedError(`${canonicalManifestPath}: thin_plan_manifest could not be read: ${error.message}`); }),
  ]);

  await assertManifestPathAndHashBinding({
    entry: decision.thin_plan, field: "thin_plan", actualManifestPath: planPath, actualHash: sha256Hex(planBytes), root, source: canonicalManifestPath,
  });
  await assertManifestPathAndHashBinding({
    entry: decision.thin_plan_manifest, field: "thin_plan_manifest", actualManifestPath: planManifestPath, actualHash: sha256Hex(planManifestBytes), root, source: canonicalManifestPath,
  });

  const declaredRecordCount = decision.thin_plan.record_count;
  if (!Number.isInteger(declaredRecordCount) || declaredRecordCount < 1) {
    throw new ReleaseNotApprovedError(`${canonicalManifestPath}: decision artifact thin_plan.record_count is missing or invalid`);
  }
  const planLines = strictUtf8(planBytes, planPath).trim().length ? strictUtf8(planBytes, planPath).trim().split("\n") : [];
  if (planLines.length !== declaredRecordCount) {
    throw new ReleaseNotApprovedError(`${canonicalManifestPath}: thin_plan actual record count (${planLines.length}) does not match decision artifact thin_plan.record_count (${declaredRecordCount})`);
  }

  let planManifest;
  try { planManifest = JSON.parse(strictUtf8(planManifestBytes, planManifestPath)); }
  catch (error) { throw new ReleaseNotApprovedError(`${canonicalManifestPath}: thin_plan_manifest is not valid JSON: ${error.message}`); }
  if (planManifest.record_count !== declaredRecordCount) {
    throw new ReleaseNotApprovedError(`${canonicalManifestPath}: thin_plan_manifest.record_count does not match decision artifact thin_plan.record_count`);
  }
  if (planManifest.corpus_snapshot_id !== structuredManifest.corpus_snapshot_id) {
    throw new ReleaseNotApprovedError(`${canonicalManifestPath}: thin_plan_manifest.corpus_snapshot_id does not match the approved structured manifest`);
  }
  if (planManifest.fact_coverage_snapshot_id !== structuredManifest.fact_coverage_snapshot_id) {
    throw new ReleaseNotApprovedError(`${canonicalManifestPath}: thin_plan_manifest.fact_coverage_snapshot_id does not match the approved structured manifest`);
  }

  for (const [manifestField, decisionField, label] of [
    ["source_gold", "thin_plan_source_gold", "source_gold"],
    ["source_coverage", "thin_plan_source_coverage", "source_coverage"],
  ]) {
    const pinned = decision[decisionField];
    if (!pinned || typeof pinned.path !== "string" || pinned.path === "" || typeof pinned.sha256 !== "string" || !SHA256_HEX.test(pinned.sha256)) {
      throw new ReleaseNotApprovedError(`${canonicalManifestPath}: decision artifact ${decisionField} is missing or malformed`);
    }
    if (planManifest[manifestField] !== pinned.path) {
      throw new ReleaseNotApprovedError(`${canonicalManifestPath}: thin_plan_manifest.${manifestField} ("${planManifest[manifestField]}") does not match decision artifact ${decisionField}.path ("${pinned.path}")`);
    }
    const actualSha256 = await sha256Hex(await readFile(path.resolve(root, pinned.path)).catch((error) => {
      throw new ReleaseNotApprovedError(`${canonicalManifestPath}: ${label} (${pinned.path}) could not be read: ${error.message}`);
    }));
    if (actualSha256 !== pinned.sha256) {
      throw new ReleaseNotApprovedError(`${canonicalManifestPath}: decision artifact ${decisionField}.sha256 does not match the actual ${label} content`);
    }
  }

  return { planPath, planManifestPath };
}

// --- Chain referential integrity: a structural/domain check (plain
// Error, not ReleaseNotApprovedError -- this is "is the approved bundle
// internally consistent", not "was this bundle approved at all"). Two
// tiers, deliberately not the same severity:
//   BLOCKING (throws): every non-null Event/Relation chain_id resolves to
//   a real Chain record; every Chain's own relation_ids resolve within
//   the VERIFIED Relation set. These are cheap, always-resolvable-in-
//   principle facts about THIS bundle's own three artifacts -- a failure
//   here means the bundle is internally inconsistent, not that the wider
//   corpus is incomplete.
//   ADVISORY (recorded, never thrown): every Chain's own document_ids
//   resolve in the canonical DocumentIR store. A Seed-scoped canonical
//   bundle legitimately does not need to carry every document a
//   corpus-wide Chain's lineage ever touched (e.g. an early "anchor"
//   document that precedes anything actually cited as Fact/Evidence
//   grounding for the current question set) -- StructuredStore is not
//   required to support Chain lookups itself, and nothing here is ever
//   served live from Chain data. Findings are returned, not swallowed, so
//   a caller that DOES need full corpus-wide document coverage (e.g. the
//   real release's own validation) can still assert zero findings itself.
async function assertChainReferentialIntegrity({ chainRecords, eventRecords, relationRecords, documentStoreAdapter, source }) {
  const chainById = new Map();
  for (const chain of chainRecords) {
    if (typeof chain.chain_id !== "string" || chainById.has(chain.chain_id)) throw new Error(`${source}: invalid or duplicate chain_id in Chain artifact`);
    if (!Array.isArray(chain.document_ids) || chain.document_ids.length === 0) throw new Error(`${source}: chain ${chain.chain_id} has no document_ids`);
    if (!Array.isArray(chain.relation_ids)) throw new Error(`${source}: chain ${chain.chain_id} has no relation_ids array`);
    if (chain.document_count !== chain.document_ids.length) throw new Error(`${source}: chain ${chain.chain_id} document_count does not match document_ids.length`);
    if (chain.relation_count !== chain.relation_ids.length) throw new Error(`${source}: chain ${chain.chain_id} relation_count does not match relation_ids.length`);
    chainById.set(chain.chain_id, chain);
  }

  const relationById = new Map(relationRecords.map((r) => [r.relation_id, r]));
  for (const event of eventRecords) {
    if (event.chain_id != null && !chainById.has(event.chain_id)) {
      throw new Error(`${source}: event ${event.event_id} references chain_id ${event.chain_id}, which does not exist in the Chain artifact`);
    }
  }
  for (const relation of relationRecords) {
    if (relation.chain_id != null && !chainById.has(relation.chain_id)) {
      throw new Error(`${source}: relation ${relation.relation_id} references chain_id ${relation.chain_id}, which does not exist in the Chain artifact`);
    }
  }
  const documentResolutionWarnings = [];
  for (const chain of chainRecords) {
    for (const relationId of chain.relation_ids) {
      if (!relationById.has(relationId)) throw new Error(`${source}: chain ${chain.chain_id} references relation_id ${relationId}, which does not exist in the VERIFIED Relation set`);
    }
    for (const documentId of chain.document_ids) {
      const resolved = await documentStoreAdapter.getDocument(documentId);
      if (!resolved) {
        documentResolutionWarnings.push({ chain_id: chain.chain_id, document_id: documentId, question_ids: chain.question_ids ?? [] });
      }
    }
  }
  return Object.freeze({ documentResolutionWarnings: Object.freeze(documentResolutionWarnings) });
}

// --- Owner batch decision binding: closes a gap where a release decision
// could DECLARE decision.owner_batch_decision (path/sha256/record_count/
// approved_by/all_approve -- see scripts/build-seed-release-v018-decision.mjs)
// without that claim ever being independently checked (tests/seed-release-v018.test.mjs
// verified it separately, but the real Runtime gate never read the file --
// that made it decorative, not load-bearing).
//
// Scope: this is a "if you claim it, we verify it" gate, not a requirement
// that every release declare one. When decision.owner_batch_decision is
// absent (every release that predates this concept -- v0.17 and earlier),
// this function is a no-op and construction proceeds exactly as before.
// When present, it becomes fully load-bearing: path safety (root-relative,
// no absolute/".." segments, and -- stricter than decision_artifact_path's
// own check -- ANY symlink anywhere along the resolved path is rejected,
// not just one that escapes root, mirroring assertManifestPathAndHashBinding's
// symlink-alias defense), raw-byte SHA-256 match, fatal-UTF-8 JSONL
// parsing, actual record_count match, no duplicate fact_id/evidence_id,
// every item owner_disposition==="APPROVE", every item's reviewer both
// non-empty AND equal to the declared approved_by, every item's
// reviewed_at a valid ISO date-time, and the declared all_approve is
// RECOMPUTED from the actual records rather than trusted verbatim. Two
// cross-validations close the loop: every batch fact_id/evidence_id must
// actually resolve in the promoted VERIFIED Fact/Evidence stores, AND must
// appear in the structured manifest's own merged OWNER_DECISION artifact
// with an EXACTLY matching evidence_id/owner_disposition/reviewer/
// reviewed_at -- a batch item that disagrees with (or is simply absent
// from) the merged decision of record fails closed.
async function assertOwnerBatchDecisionBinding({
  decision, root, canonicalManifestPath, ownerDecisionPin, readPinnedJsonl, factStoreAdapter, evidenceStoreAdapter, required = false,
}) {
  const declared = decision.owner_batch_decision;
  if (declared === undefined) {
    if (required) {
      throw new ReleaseNotApprovedError(`${canonicalManifestPath}: decision artifact is missing owner_batch_decision, which this Runtime's operational policy requires`);
    }
    return;
  }

  if (!declared || typeof declared !== "object" || Array.isArray(declared)) {
    throw new ReleaseNotApprovedError(`${canonicalManifestPath}: decision artifact owner_batch_decision must be an object`);
  }
  if (typeof declared.sha256 !== "string" || !SHA256_HEX.test(declared.sha256)) {
    throw new ReleaseNotApprovedError(`${canonicalManifestPath}: decision artifact owner_batch_decision.sha256 is missing or malformed`);
  }
  if (!Number.isInteger(declared.record_count) || declared.record_count < 1) {
    throw new ReleaseNotApprovedError(`${canonicalManifestPath}: decision artifact owner_batch_decision.record_count must be a positive integer`);
  }
  if (typeof declared.approved_by !== "string" || declared.approved_by === "") {
    throw new ReleaseNotApprovedError(`${canonicalManifestPath}: decision artifact owner_batch_decision.approved_by must be a non-empty string`);
  }
  if (typeof declared.all_approve !== "boolean") {
    throw new ReleaseNotApprovedError(`${canonicalManifestPath}: decision artifact owner_batch_decision.all_approve must be a boolean`);
  }

  // Path safety: root-relative only, no absolute/".." segments, and --
  // stricter than decision_artifact_path's own escape-only check -- ANY
  // symlink anywhere along the resolved path is rejected, whether it
  // escapes root or merely aliases an in-root file.
  const resolved = assertSafeRelativePath(declared.path, root, canonicalManifestPath, "owner_batch_decision.path");
  let real;
  try { real = await realpath(resolved); }
  catch (error) { throw new ReleaseNotApprovedError(`${canonicalManifestPath}: owner_batch_decision.path could not be resolved: ${error.message}`); }
  if (real !== resolved) {
    throw new ReleaseNotApprovedError(`${canonicalManifestPath}: owner_batch_decision.path involves a symlink, which is not permitted`);
  }

  let rawBytes;
  try { rawBytes = await readFile(resolved); }
  catch (error) { throw new ReleaseNotApprovedError(`${canonicalManifestPath}: owner_batch_decision could not be read: ${error.message}`); }
  const actualSha256 = sha256Hex(rawBytes);
  if (actualSha256 !== declared.sha256) {
    throw new ReleaseNotApprovedError(`${canonicalManifestPath}: owner_batch_decision.sha256 does not match the actual content`);
  }

  let items;
  try {
    const text = strictUtf8(rawBytes, resolved).trim();
    items = text.length ? text.split("\n").map((line) => JSON.parse(line)) : [];
  } catch (error) {
    throw new ReleaseNotApprovedError(`${canonicalManifestPath}: owner_batch_decision is not valid JSONL: ${error.message}`);
  }
  if (items.length !== declared.record_count) {
    throw new ReleaseNotApprovedError(`${canonicalManifestPath}: owner_batch_decision actual record count (${items.length}) does not match declared record_count (${declared.record_count})`);
  }

  const seenFactIds = new Set();
  const seenEvidenceIds = new Set();
  for (const [i, item] of items.entries()) {
    const label = `owner_batch_decision[${i}]`;
    if (!item || typeof item !== "object") throw new ReleaseNotApprovedError(`${canonicalManifestPath}: ${label} is not an object`);
    if (typeof item.fact_id !== "string" || item.fact_id === "") throw new ReleaseNotApprovedError(`${canonicalManifestPath}: ${label} is missing fact_id`);
    if (seenFactIds.has(item.fact_id)) throw new ReleaseNotApprovedError(`${canonicalManifestPath}: ${label} duplicate fact_id ${item.fact_id}`);
    seenFactIds.add(item.fact_id);
    if (typeof item.evidence_id !== "string" || item.evidence_id === "") throw new ReleaseNotApprovedError(`${canonicalManifestPath}: ${label} is missing evidence_id`);
    if (seenEvidenceIds.has(item.evidence_id)) throw new ReleaseNotApprovedError(`${canonicalManifestPath}: ${label} duplicate evidence_id ${item.evidence_id}`);
    seenEvidenceIds.add(item.evidence_id);
    if (item.owner_disposition !== "APPROVE") {
      throw new ReleaseNotApprovedError(`${canonicalManifestPath}: ${label} owner_disposition is "${item.owner_disposition}", not "APPROVE"`);
    }
    if (typeof item.reviewer !== "string" || item.reviewer === "") {
      throw new ReleaseNotApprovedError(`${canonicalManifestPath}: ${label} reviewer must be a non-empty string`);
    }
    if (item.reviewer !== declared.approved_by) {
      throw new ReleaseNotApprovedError(`${canonicalManifestPath}: ${label} reviewer ("${item.reviewer}") does not match owner_batch_decision.approved_by ("${declared.approved_by}")`);
    }
    if (typeof item.reviewed_at !== "string" || !ISO_DATETIME.test(item.reviewed_at)) {
      throw new ReleaseNotApprovedError(`${canonicalManifestPath}: ${label} reviewed_at must be a valid ISO date-time`);
    }
  }

  // Never trust the declared all_approve verbatim -- recompute from the
  // actual records (every item already proven APPROVE above, so this is
  // always true at this point, but the comparison below still catches a
  // declared all_approve that disagrees with what was just independently
  // established as reality).
  const actualAllApprove = items.every((item) => item.owner_disposition === "APPROVE");
  if (declared.all_approve !== actualAllApprove) {
    throw new ReleaseNotApprovedError(`${canonicalManifestPath}: owner_batch_decision.all_approve (${declared.all_approve}) does not match the recomputed value (${actualAllApprove})`);
  }

  // Cross-validate against the promoted VERIFIED stores: every batch item
  // must actually be servable, not merely declared.
  for (const item of items) {
    const fact = await factStoreAdapter.getFact(item.fact_id);
    if (!fact) throw new ReleaseNotApprovedError(`${canonicalManifestPath}: owner_batch_decision fact_id ${item.fact_id} does not resolve in the promoted VERIFIED Fact store`);
    const evidence = await evidenceStoreAdapter.getEvidence(item.evidence_id);
    if (!evidence) throw new ReleaseNotApprovedError(`${canonicalManifestPath}: owner_batch_decision evidence_id ${item.evidence_id} does not resolve in the promoted VERIFIED Evidence store`);
  }

  // Cross-validate against the structured manifest's own merged
  // OWNER_DECISION artifact: every batch item must appear there with an
  // EXACTLY matching evidence_id/owner_disposition/reviewer/reviewed_at --
  // a batch that was approved but never actually merged into the decision
  // of record (or was merged with different values) is refused.
  if (!ownerDecisionPin) throw new ReleaseNotApprovedError(`${canonicalManifestPath}: structured manifest is missing OWNER_DECISION, required to cross-validate owner_batch_decision`);
  const mergedRecords = await readPinnedJsonl(ownerDecisionPin, "OWNER_DECISION");
  const mergedByFactId = new Map(mergedRecords.filter((r) => typeof r?.fact_id === "string").map((r) => [r.fact_id, r]));
  for (const item of items) {
    const merged = mergedByFactId.get(item.fact_id);
    if (!merged) throw new ReleaseNotApprovedError(`${canonicalManifestPath}: owner_batch_decision fact_id ${item.fact_id} does not appear in the structured manifest's merged OWNER_DECISION`);
    if (merged.evidence_id !== item.evidence_id || merged.owner_disposition !== item.owner_disposition
      || merged.reviewer !== item.reviewer || merged.reviewed_at !== item.reviewed_at) {
      throw new ReleaseNotApprovedError(`${canonicalManifestPath}: owner_batch_decision entry for ${item.fact_id} does not match the merged OWNER_DECISION's own record (evidence_id/owner_disposition/reviewer/reviewed_at)`);
    }
  }
}

// --- Production anti-rollback: an operational policy, opt-in via
// expectedReleaseId/expectedApprovedRevision (undefined = no-op, so
// independent/legacy fixture-driven tests are unaffected). A canonical
// manifest + decision artifact pair can be byte-valid, correctly signed,
// internally self-consistent, and even share the current corpus_snapshot_id
// -- and still be a stale, audit-discarded release (e.g. v0.17, discarded
// for a self-approved batch -- see domain/releases/
// seed-release.v0.17.BLOCKED.audit-report.json) that must never be
// accepted as a production downgrade target. This checks the declared
// release_id against BOTH the canonical manifest and the decision artifact
// (not just one -- assertDecisionBindsReleaseBundle already proves they
// agree with each other, but that says nothing about whether the release
// they agree on is the CURRENT one), and optionally the decision's
// approved_revision, against caller-supplied expected values. The caller
// (domain/runtime/configured-seed-runtime.mjs) hardcodes these -- they are
// never sourced from environment variables, so an env override can change
// WHICH files are read but never WHICH release identity is required.
function assertExpectedReleaseIdentity({ canonicalManifest, decision, expectedReleaseId, expectedApprovedRevision, canonicalManifestPath }) {
  if (expectedReleaseId !== undefined) {
    if (canonicalManifest.release_id !== expectedReleaseId) {
      throw new ReleaseNotApprovedError(
        `${canonicalManifestPath}: canonical manifest release_id ("${canonicalManifest.release_id}") does not match the required production release_id ("${expectedReleaseId}")`,
      );
    }
    if (decision.release_id !== expectedReleaseId) {
      throw new ReleaseNotApprovedError(
        `${canonicalManifestPath}: decision artifact release_id ("${decision.release_id}") does not match the required production release_id ("${expectedReleaseId}")`,
      );
    }
  }
  if (expectedApprovedRevision !== undefined && decision.approved_revision !== expectedApprovedRevision) {
    throw new ReleaseNotApprovedError(
      `${canonicalManifestPath}: decision artifact approved_revision ("${decision.approved_revision}") does not match the required production approved_revision ("${expectedApprovedRevision}")`,
    );
  }
}

// Structural + decision-artifact + full-bundle-binding check, in that
// order. Nothing about the eventual Seed artifacts (Evidence/Fact/Coverage/
// Relation/DocumentIR) is read until every one of these passes. The Thin
// plan binds last, once the structured manifest it must agree with is
// already trusted.
async function assertReleaseAuthorized({
  canonicalManifest, canonicalManifestPath, structuredManifest, structuredManifestPath, structuredManifestBytes, planPath, planManifestPath, root,
}) {
  const auth = canonicalManifest.release_authorization;
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
    throw new ReleaseNotApprovedError(`${canonicalManifestPath} carries no release_authorization block`);
  }
  if (auth.status !== "APPROVED") {
    throw new ReleaseNotApprovedError(`${canonicalManifestPath} release_authorization.status is "${auth.status}", not "APPROVED"`);
  }
  if (typeof auth.approved_by !== "string" || auth.approved_by === "") {
    throw new ReleaseNotApprovedError(`${canonicalManifestPath} release_authorization.approved_by is missing`);
  }
  if (typeof auth.approved_at !== "string" || Number.isNaN(Date.parse(auth.approved_at))) {
    throw new ReleaseNotApprovedError(`${canonicalManifestPath} release_authorization.approved_at is missing or not a valid date-time`);
  }
  if (typeof auth.decision_artifact_sha256 !== "string" || !SHA256_HEX.test(auth.decision_artifact_sha256)) {
    throw new ReleaseNotApprovedError(`${canonicalManifestPath} release_authorization.decision_artifact_sha256 is missing or malformed`);
  }

  const decision = await loadAndVerifyDecisionArtifact({ auth, canonicalManifestPath, root });
  await assertDecisionBindsReleaseBundle({ decision, canonicalManifest, canonicalManifestPath, structuredManifest, structuredManifestPath, structuredManifestBytes, root });
  const planBinding = await assertThinPlanBinding({ decision, structuredManifest, canonicalManifestPath, planPath, planManifestPath, root });
  return { ...planBinding, decision };
}

// Company Directory / CompanyResolver release binding (opt-in): absent
// companyDirectoryArtifactPath means "this caller did not ask for company
// resolution" -- a strict no-op, identical to every existing caller's
// behavior today (context.companyLabels stays absent, and
// response-composer.mjs's existing UNRESOLVED_ENTITY_LABEL/PARTIAL path
// covers every entity exactly as it already does). Once
// companyDirectoryArtifactPath IS provided, though, this is the ONLY path
// through which a working CompanyResolver may be obtained inside this
// module -- createGatedSeedCompanyResolver already fail-closes on missing
// approval/hash mismatch/path mismatch/symlink; the corpus_snapshot_id
// cross-check below additionally ties the Company Directory's OWN
// approved snapshot to the SAME corpus_snapshot_id this specific release
// construction already established for Fact/Evidence/DocumentIR, so an
// otherwise-valid-but-stale Company Directory approval tied to a
// DIFFERENT corpus snapshot still fails closed. Every failure here is
// wrapped as ReleaseNotApprovedError so a caller/route (e.g. /ready) can
// detect it the exact same way as every other release-authorization
// failure in this module -- there is no silent "company resolution just
// won't work this time" path once it has been requested.
async function bindCompanyResolver({
  companyDirectoryArtifactPath, companyDirectoryManifestPath, companyDirectoryOwnerDecisionPath,
  expectedCompanyDirectoryOwnerDecisionSha256, root, expectedCorpusSnapshotId,
}) {
  if (companyDirectoryArtifactPath === undefined) return null;
  if (typeof companyDirectoryManifestPath !== "string" || companyDirectoryManifestPath === "") {
    throw new ReleaseNotApprovedError("companyDirectoryManifestPath is required when companyDirectoryArtifactPath is provided");
  }
  if (typeof companyDirectoryOwnerDecisionPath !== "string" || companyDirectoryOwnerDecisionPath === "") {
    throw new ReleaseNotApprovedError("companyDirectoryOwnerDecisionPath is required when companyDirectoryArtifactPath is provided");
  }
  let resolver;
  try {
    resolver = await createGatedSeedCompanyResolver({
      artifactPath: companyDirectoryArtifactPath, manifestPath: companyDirectoryManifestPath,
      ownerDecisionPath: companyDirectoryOwnerDecisionPath, expectedOwnerDecisionSha256: expectedCompanyDirectoryOwnerDecisionSha256,
      root,
    });
  } catch (error) {
    throw new ReleaseNotApprovedError(`company directory binding failed: ${error.message}`);
  }
  if (resolver.context.corpus_snapshot_id !== expectedCorpusSnapshotId) {
    throw new ReleaseNotApprovedError(
      `company directory corpus_snapshot_id ("${resolver.context.corpus_snapshot_id}") does not match this release's corpus_snapshot_id ("${expectedCorpusSnapshotId}")`,
    );
  }
  return resolver;
}

// A plain, Object.freeze-safe lookup object -- never a Proxy/getter trick
// -- so it stays JSON-serialization-safe and structurally matches exactly
// what response-composer.mjs already expects (`companyLabels?.[corpCode]`).
// Built once at construction from the gated resolver's own frozen records;
// no lookup after construction re-reads any file.
function companyLabelsFromResolver(resolver) {
  const labels = {};
  for (const corpCode of resolver.corpCodes()) labels[corpCode] = resolver.resolve(corpCode);
  return Object.freeze(labels);
}

export async function createSeedRuntimeServiceAdapters({
  structuredManifestPath,
  canonicalReleaseManifestPath,
  planPath,
  planManifestPath,
  root = process.cwd(),
  // Company Directory / CompanyResolver release binding -- all optional;
  // see bindCompanyResolver's own comment. Omitting
  // companyDirectoryArtifactPath is a strict no-op (matches every
  // existing caller's current behavior exactly).
  companyDirectoryArtifactPath,
  companyDirectoryManifestPath,
  companyDirectoryOwnerDecisionPath,
  expectedCompanyDirectoryOwnerDecisionSha256,
  // Opt-in production anti-rollback policy -- see assertExpectedReleaseIdentity
  // and assertOwnerBatchDecisionBinding's `required` flag. undefined/false
  // means no-op (preserves every independent/legacy fixture-driven test's
  // existing behavior); domain/runtime/configured-seed-runtime.mjs is the
  // one caller that always sets these, and hardcodes them rather than
  // sourcing them from environment variables.
  expectedReleaseId,
  expectedApprovedRevision,
  requireOwnerBatchDecision = false,
  // Turn K: same "opt-in production policy, hardcoded by the ONE
  // configured caller, never sourced from env" shape as
  // requireOwnerBatchDecision above -- undefined/false (the default)
  // preserves every existing generic/test caller's behavior (company
  // resolution stays fully optional). Once a caller sets this true, an
  // OMITTED or invalid companyDirectoryArtifactPath/*ManifestPath/
  // *OwnerDecisionPath fails the WHOLE construction closed with
  // RELEASE_NOT_APPROVED -- "no-op" is no longer an acceptable outcome
  // for that caller. domain/runtime/configured-seed-runtime.mjs sets this
  // true today (Turn K), ahead of any v0.20 release existing.
  requireCompanyDirectory = false,
} = {}) {
  if (typeof structuredManifestPath !== "string" || structuredManifestPath === "") throw new Error("structuredManifestPath is required");
  if (typeof canonicalReleaseManifestPath !== "string" || canonicalReleaseManifestPath === "") throw new Error("canonicalReleaseManifestPath is required");
  if (typeof planPath !== "string" || planPath === "") throw new Error("planPath is required");
  if (typeof planManifestPath !== "string" || planManifestPath === "") throw new Error("planManifestPath is required");
  if (requireCompanyDirectory && typeof companyDirectoryArtifactPath !== "string") {
    throw new ReleaseNotApprovedError("companyDirectoryArtifactPath is required by this caller's requireCompanyDirectory policy");
  }

  const [structured, canonical] = await Promise.all([
    readManifestWithBytes(structuredManifestPath), readManifestWithBytes(canonicalReleaseManifestPath),
  ]);
  const structuredManifest = structured.value;
  const canonicalManifest = canonical.value;
  const { decision, ...authorizedRuntimeAssets } = await assertReleaseAuthorized({
    canonicalManifest, canonicalManifestPath: canonicalReleaseManifestPath,
    structuredManifest, structuredManifestPath, structuredManifestBytes: structured.bytes,
    planPath, planManifestPath,
    root,
  });
  assertExpectedReleaseIdentity({ canonicalManifest, decision, expectedReleaseId, expectedApprovedRevision, canonicalManifestPath: canonicalReleaseManifestPath });
  if (structuredManifest.status !== "VERIFIED_SEED_SUBSET") throw new Error("structured manifest is not a VERIFIED Seed subset");
  if (structuredManifest.corpus_snapshot_id !== canonicalManifest.corpus_snapshot_id) throw new Error("canonical/structured corpus snapshot mismatch");
  if (typeof structuredManifest.fact_coverage_snapshot_id !== "string" || structuredManifest.fact_coverage_snapshot_id === "") {
    throw new Error("structured manifest is missing fact_coverage_snapshot_id");
  }

  const roles = roleMap(structuredManifest, structuredManifestPath);
  const evidence = requireRole(roles, "VERIFIED_EVIDENCE", structuredManifestPath);
  const evidenceManifest = requireRole(roles, "VERIFIED_EVIDENCE_MANIFEST", structuredManifestPath);
  const facts = requireRole(roles, "VERIFIED_FACT", structuredManifestPath);
  const coverage = requireRole(roles, "FACT_COVERAGE_SNAPSHOT", structuredManifestPath);
  const eventsPin = requireRole(roles, "VERIFIED_EVENT", structuredManifestPath);
  const relationPin = requireRole(roles, "VERIFIED_RELATION", structuredManifestPath);
  const chainPin = requireRole(roles, "CHAIN_MANIFEST", structuredManifestPath);
  const ownerDecisionPin = requireRole(roles, "OWNER_DECISION", structuredManifestPath);
  if (!Number.isInteger(facts.record_count) || facts.record_count < 1) throw new Error("VERIFIED_FACT record_count must be positive");

  const resolveArtifact = (pin) => path.resolve(root, pin.path);
  const readPinnedJsonl = async (pin, label) => {
    const bytes = await readFile(resolveArtifact(pin));
    if (sha256Hex(bytes) !== pin.sha256) throw new Error(`${label}: raw bytes do not match the structured manifest's own sha256 pin`);
    const text = strictUtf8(bytes, resolveArtifact(pin));
    return text.trim().length ? text.trim().split("\n").map((line) => JSON.parse(line)) : [];
  };

  const [documentStoreAdapter, evidenceStoreAdapter, factStoreAdapter, structuredStoreAdapter, eventRecords, relationRecords, chainRecords] = await Promise.all([
    // The release manifest stores bundle-relative artifact paths. Respect
    // this adapter construction's explicit root instead of falling back to
    // process.cwd(); otherwise a materialized portable bundle can appear to
    // work only when an unrelated loose work/ tree happens to exist there.
    createSeedCanonicalDocumentIrStore(canonicalReleaseManifestPath, { root }),
    createSeedEvidenceArtifactStore({ evidencePath: resolveArtifact(evidence), manifestPath: resolveArtifact(evidenceManifest) }),
    createSeedFactArtifactStore({
      factArtifactPath: resolveArtifact(facts), factArtifactSha256: facts.sha256, factRecordCount: facts.record_count,
      factCoverageSnapshotPath: resolveArtifact(coverage), factCoverageSnapshotSha256: coverage.sha256,
    }),
    createSeedStructuredQueryAdapter({ manifestPath: structuredManifestPath, root }),
    readPinnedJsonl(eventsPin, "VERIFIED_EVENT"),
    readPinnedJsonl(relationPin, "VERIFIED_RELATION"),
    readPinnedJsonl(chainPin, "CHAIN_MANIFEST"),
  ]);

  const { documentResolutionWarnings } = await assertChainReferentialIntegrity({ chainRecords, eventRecords, relationRecords, documentStoreAdapter, source: structuredManifestPath });

  await assertOwnerBatchDecisionBinding({
    decision, root, canonicalManifestPath: canonicalReleaseManifestPath, ownerDecisionPin, readPinnedJsonl, factStoreAdapter, evidenceStoreAdapter,
    required: requireOwnerBatchDecision,
  });

  const companyResolver = await bindCompanyResolver({
    companyDirectoryArtifactPath, companyDirectoryManifestPath, companyDirectoryOwnerDecisionPath,
    expectedCompanyDirectoryOwnerDecisionSha256, root, expectedCorpusSnapshotId: structuredManifest.corpus_snapshot_id,
  });

  // requireCompanyDirectory: true means bindCompanyResolver above must have
  // produced a resolver -- any bindCompanyResolver failure already threw
  // ReleaseNotApprovedError before reaching this line, so the only way
  // companyResolver is null here under that policy is a caller that never
  // supplied companyDirectoryArtifactPath at all (the strict no-op path).
  // That omission is itself a policy violation once required, so fail the
  // whole Runtime construction closed rather than silently degrading to
  // "no company resolution" in production.
  if (requireCompanyDirectory && !companyResolver) {
    throw new ReleaseNotApprovedError(
      `${canonicalReleaseManifestPath}: companyDirectoryArtifactPath/companyDirectoryManifestPath/companyDirectoryOwnerDecisionPath are required when requireCompanyDirectory is true`,
    );
  }

  const context = Object.freeze({
    corpus_snapshot_id: structuredManifest.corpus_snapshot_id,
    fact_coverage_snapshot_id: structuredManifest.fact_coverage_snapshot_id,
    // Present ONLY when the caller requested (and the gate approved)
    // company resolution -- absent (undefined) is a strict no-op for
    // every existing caller/Flow, identical to today's behavior.
    ...(companyResolver ? { companyLabels: companyLabelsFromResolver(companyResolver) } : {}),
  });
  const serviceAdapters = Object.freeze({ documentStoreAdapter, evidenceStoreAdapter, factStoreAdapter, structuredStoreAdapter });
  return Object.freeze({
    context, serviceAdapters, authorizedRuntimeAssets: Object.freeze({ ...authorizedRuntimeAssets }),
    // Advisory only -- see assertChainReferentialIntegrity's header comment.
    // A caller that must guarantee full corpus-wide Chain document coverage
    // (e.g. a release-validation script) should assert this is empty
    // itself; ordinary Runtime construction does not fail on it.
    chainIntegrity: Object.freeze({ documentResolutionWarnings }),
  });
}
