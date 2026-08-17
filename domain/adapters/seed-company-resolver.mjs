// CompanyResolver adapter (CANDIDATE-only): resolves a corp_code to a
// human-readable company name. Mirrors the construction-time-validate-
// then-Map-lookup-only shape already established by
// seed-question-plan-store.mjs and seed-structured-query-adapter.mjs --
// everything is verified once at construction (artifact/manifest raw-byte
// SHA, UTF-8, JSONL shape, duplicate/format checks, manifest record_count
// and corp_code-set-hash cross-check), then request-time lookups are pure
// synchronous Map reads against already-frozen records. No I/O, no
// re-validation, and no mutation is possible after construction.
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { abortReason, RequestAbortedError } from "../runtime/abortable.mjs";

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
// Same defense-in-depth symlink check seed-runtime-service-adapters.mjs
// uses for the canonical/structured/plan manifests: a path that resolves
// to the "right" location by name/hash is still refused if any component
// along it is a symlink -- a byte-identical copy reached through an alias
// is not the same trust anchor as the real on-disk file.
export async function assertNoSymlink(candidatePath, label) {
  const resolved = path.resolve(candidatePath);
  let real;
  try { real = await realpath(resolved); }
  catch (error) { throw new Error(`${label}: path could not be resolved: ${error.message}`); }
  if (real !== resolved) throw new Error(`${label}: path involves a symlink, which is not permitted`);
}
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
function decode(buffer, source) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch (error) { throw new Error(`${source}: invalid UTF-8: ${error.message}`); }
}

// PRE-INTEGRATION GATE (documented here since there is no release binding
// for this artifact yet -- see the Company Directory candidate manifest's
// own `status` field):
//   1. `manifest.status` MUST be read and checked by any future official-
//      mode caller before this resolver is wired into the production
//      Runtime -- a manifest whose status is not "VERIFIED"/release-bound
//      must never be accepted by an official caller. This constructor
//      itself does not enforce a specific status (it is also used to
//      validate SANDBOX/Candidate fixtures in tests), so that check is
//      the CALLER's responsibility once this graduates past Candidate.
//   2. `source_companies_sha256`/`source_corpus_snapshot_sha256` in the
//      manifest are BUILD PROVENANCE only (recorded by the builder script
//      at generation time) -- they are not re-verified against the live
//      companies.jsonl/corpus-snapshot.json here, and a future release
//      decision must be the thing that FINALLY pins them, the same way
//      seed-release.*.decision.json pins Fact/Evidence/Coverage artifacts.
//   3. The OFFICIAL-mode policy for an unresolved corp_code (silently
//      fall back vs. force PARTIAL) is NOT decided by this turn and must
//      not be wired into any production path before that decision is
//      made -- see response-composer.mjs's `unresolved_company_codes`
//      output, which only EXPOSES the metadata, never decides on it.
export async function createSeedCompanyResolver({ artifactPath, manifestPath, root = process.cwd() } = {}) {
  if (!artifactPath || !manifestPath) throw new Error("artifactPath and manifestPath are required");
  await Promise.all([assertNoSymlink(artifactPath, "company directory artifact"), assertNoSymlink(manifestPath, "company directory manifest")]);
  const [artifactBuffer, manifestBuffer] = await Promise.all([readFile(artifactPath), readFile(manifestPath)]);
  const manifest = JSON.parse(decode(manifestBuffer, manifestPath));

  if (!/^[0-9a-f]{64}$/.test(manifest.artifact_sha256) || sha256(artifactBuffer) !== manifest.artifact_sha256) {
    throw new Error("company directory artifact hash mismatch");
  }
  if (typeof manifest.artifact !== "string" || manifest.artifact === "") {
    throw new Error("company directory manifest is missing its own artifact path");
  }
  // The manifest's own declared artifact path (root-relative) must point
  // at the SAME file actually opened as `artifactPath` -- otherwise a
  // caller could be tricked into trusting a manifest whose SHA-256 pin
  // was computed for one file while a different file (reached via a
  // symlink alias or a mismatched constructor argument) is the one
  // actually read and indexed.
  if (path.resolve(root, manifest.artifact) !== path.resolve(artifactPath)) {
    throw new Error("company directory manifest artifact path does not match the provided artifactPath");
  }
  if (typeof manifest.corpus_snapshot_id !== "string" || manifest.corpus_snapshot_id === "") {
    throw new Error("company directory manifest snapshot is missing");
  }

  const index = new Map();
  const corpCodes = [];
  for (const [lineIndex, line] of decode(artifactBuffer, artifactPath).split(/\r?\n/).filter(Boolean).entries()) {
    let record;
    try { record = JSON.parse(line); } catch (error) { throw new Error(`${artifactPath}:${lineIndex + 1}: invalid JSON: ${error.message}`); }
    const allowed = new Set(["corp_code", "corp_name", "listed_name"]);
    if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error(`${artifactPath}:${lineIndex + 1}: unexpected company record field`);
    if (!/^\d{8}$/.test(record.corp_code)) throw new Error(`${artifactPath}:${lineIndex + 1}: invalid corp_code`);
    if (typeof record.corp_name !== "string" || record.corp_name.trim() !== record.corp_name || record.corp_name === "") {
      throw new Error(`${artifactPath}:${lineIndex + 1}: invalid corp_name`);
    }
    if (typeof record.listed_name !== "string" || record.listed_name.trim() !== record.listed_name || record.listed_name === "") {
      throw new Error(`${artifactPath}:${lineIndex + 1}: invalid listed_name`);
    }
    if (index.has(record.corp_code)) throw new Error(`${artifactPath}:${lineIndex + 1}: duplicate corp_code ${record.corp_code}`);
    index.set(record.corp_code, deepFreeze({ ...record }));
    corpCodes.push(record.corp_code);
  }

  if (index.size !== manifest.record_count) throw new Error("company directory record count mismatch");
  if (typeof manifest.corp_code_set_sha256 === "string") {
    const actualSetHash = sha256(Buffer.from([...corpCodes].sort().join(","), "utf8"));
    if (actualSetHash !== manifest.corp_code_set_sha256) throw new Error("company directory corp_code set hash mismatch");
  }

  return Object.freeze({
    resolve(corpCode, { signal } = {}) {
      if (signal?.aborted) throw new RequestAbortedError(abortReason(signal));
      if (typeof corpCode !== "string") return null;
      return index.get(corpCode) ?? null;
    },
    count() { return index.size; },
    // Exposes the full key set only -- never the frozen record objects
    // wholesale -- so a caller that wants a plain companyLabels object
    // (e.g. seed-runtime-service-adapters.mjs's companyLabelsFromResolver)
    // can build one deterministically without a second file read.
    corpCodes() { return [...index.keys()]; },
    context: deepFreeze({ corpus_snapshot_id: manifest.corpus_snapshot_id }),
    // Exposed ONLY so createGatedSeedCompanyResolver (below) can bind this
    // instance's real raw bytes/record_count/corpus_snapshot_id against an
    // Owner decision without re-reading/re-hashing the files a second
    // time. Never read by an official-mode caller directly -- an
    // ungated resolver is a CANDIDATE object, not an authorized one.
    _internalAuditBinding: Object.freeze({
      artifactPath, manifestPath, artifactSha256: manifest.artifact_sha256,
      recordCount: index.size, corpusSnapshotId: manifest.corpus_snapshot_id,
    }),
  });
}

// Release-authorization gate (this turn): the ONLY way an official-mode
// caller may obtain a working CompanyResolver. Refuses to construct a
// usable resolver unless an Owner decision file -- pinned by the CALLER's
// own expectedOwnerDecisionPath/expectedOwnerDecisionSha256, exactly the
// same "caller pins identity, gate verifies bytes" pattern
// seed-runtime-service-adapters.mjs already uses for the canonical
// release manifest/decision -- exists, resolves to APPROVED, and its own
// pinned fields (artifact_sha256/manifest_sha256/record_count/
// corpus_snapshot_id) match the REAL artifact this process just read byte-
// for-byte. A PENDING/REJECTED/missing/mismatched decision throws; there
// is no silent degrade path here (the caller decides what to do with an
// unresolved gate -- e.g. treat every corp_code as unresolved -- this
// function only decides whether the CompanyResolver itself may exist).
export async function createGatedSeedCompanyResolver({
  artifactPath, manifestPath, ownerDecisionPath, expectedOwnerDecisionSha256, root = process.cwd(),
} = {}) {
  if (!ownerDecisionPath) throw new Error("ownerDecisionPath is required");
  await assertNoSymlink(ownerDecisionPath, "company directory owner decision");
  const resolver = await createSeedCompanyResolver({ artifactPath, manifestPath, root });
  const binding = resolver._internalAuditBinding;

  const decisionBuffer = await readFile(ownerDecisionPath);
  const decisionSha256 = sha256(decisionBuffer);
  if (typeof expectedOwnerDecisionSha256 === "string" && decisionSha256 !== expectedOwnerDecisionSha256) {
    throw new Error(`${ownerDecisionPath}: owner decision sha256 (${decisionSha256}) does not match the caller-pinned expectedOwnerDecisionSha256 (${expectedOwnerDecisionSha256})`);
  }
  const decision = JSON.parse(decode(decisionBuffer, ownerDecisionPath));

  if (path.resolve(root, decision.artifact_path) !== path.resolve(binding.artifactPath)) {
    throw new Error(`${ownerDecisionPath}: decision artifact_path does not match the provided artifactPath`);
  }
  if (decision.artifact_sha256 !== binding.artifactSha256) {
    throw new Error(`${ownerDecisionPath}: decision artifact_sha256 does not match the artifact this process actually read`);
  }
  if (path.resolve(root, decision.manifest_path) !== path.resolve(binding.manifestPath)) {
    throw new Error(`${ownerDecisionPath}: decision manifest_path does not match the provided manifestPath`);
  }
  const manifestBuffer = await readFile(binding.manifestPath);
  if (decision.manifest_sha256 !== sha256(manifestBuffer)) {
    throw new Error(`${ownerDecisionPath}: decision manifest_sha256 does not match the manifest this process actually read`);
  }
  if (decision.record_count !== binding.recordCount) {
    throw new Error(`${ownerDecisionPath}: decision record_count (${decision.record_count}) does not match the actual resolver record_count (${binding.recordCount})`);
  }
  if (decision.corpus_snapshot_id !== binding.corpusSnapshotId) {
    throw new Error(`${ownerDecisionPath}: decision corpus_snapshot_id does not match the artifact's own corpus_snapshot_id`);
  }
  if (decision.owner_disposition !== "APPROVED") {
    throw new Error(`${ownerDecisionPath}: owner_disposition is "${decision.owner_disposition}", not "APPROVED" -- CompanyResolver is not release-authorized`);
  }
  if (typeof decision.reviewer !== "string" || decision.reviewer === "") {
    throw new Error(`${ownerDecisionPath}: an APPROVED decision must record a real reviewer`);
  }
  if (typeof decision.reviewed_at !== "string" || !ISO_DATETIME.test(decision.reviewed_at)) {
    throw new Error(`${ownerDecisionPath}: an APPROVED decision must record a valid ISO reviewed_at`);
  }

  return Object.freeze({
    resolve: resolver.resolve, count: resolver.count, corpCodes: resolver.corpCodes, context: resolver.context,
    gate: deepFreeze({
      owner_decision_path: ownerDecisionPath, owner_decision_sha256: decisionSha256,
      reviewer: decision.reviewer, reviewed_at: decision.reviewed_at ?? null,
    }),
  });
}
