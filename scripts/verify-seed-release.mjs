// Turn M11: this validator's schema (a flat manifest.artifacts[] array
// with CORPUS_SNAPSHOT/RELATION_GOLD roles and expected_invariants) is
// the LEGACY pre-v0.19 release-manifest shape. It cannot validate the
// current v0.19+/v0.20 manifest+decision split shape (canonical_artifacts/
// structured_artifacts declared separately in a *.decision.json) -- an
// independent review confirmed that pointing it at
// domain/releases/seed-release.v0.20.manifest.json throws
// "expected exactly one CORPUS_SNAPSHOT artifact, found 0", never a false
// PASS. For CURRENT v0.20 verification, use
// tests/seed-release-v020-final.test.mjs,
// tests/seed-runtime-production-anti-rollback.test.mjs, or
// domain/adapters/seed-release-bundle-closure.mjs's
// computeReleaseBundleClosure (which independently re-derives and
// re-hashes the full v0.20 artifact set from the real release decision).
//
// This script previously defaulted to silently verifying the ancient
// v0.11 manifest when run with no arguments -- producing output that
// looked like a real "release verified" result (a JSON object with
// ok:true and a release_id) without the caller ever having asked for
// v0.11 specifically. manifestPath is now REQUIRED: running this with no
// argument fails closed with a usage message instead.
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function parseJsonLines(buffer, artifactPath) {
  const text = buffer.toString("utf8");
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${artifactPath}:${index + 1} invalid JSON: ${error.message}`);
    }
  });
}

function oneByRole(loaded, role) {
  const matches = loaded.filter((entry) => entry.spec.role === role);
  if (matches.length !== 1) throw new Error(`expected exactly one ${role} artifact, found ${matches.length}`);
  return matches[0];
}

function setDifference(left, right) {
  return [...left].filter((value) => !right.has(value));
}

export async function verifySeedRelease({ manifestPath, root = repositoryRoot } = {}) {
  if (typeof manifestPath !== "string" || manifestPath === "") {
    throw new Error(
      "verifySeedRelease: manifestPath is required (this validator never silently defaults to any specific release -- "
      + "pass the exact legacy-shaped manifest you intend to check, e.g. domain/releases/seed-release.v0.11.manifest.json)",
    );
  }
  let manifestText;
  try {
    manifestText = await readFile(manifestPath, "utf8");
  } catch (error) {
    throw new Error(`verifySeedRelease: could not read manifest at ${manifestPath}: ${error.message}`);
  }
  const manifest = JSON.parse(manifestText);
  if (manifest.schema_version !== "0.1.0") throw new Error(`unsupported release manifest ${manifest.schema_version}`);
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) throw new Error("release has no artifacts");

  const paths = new Set();
  const roles = new Set();
  const loaded = [];
  for (const spec of manifest.artifacts) {
    if (paths.has(spec.path)) throw new Error(`duplicate artifact path: ${spec.path}`);
    if (roles.has(spec.role)) throw new Error(`duplicate artifact role: ${spec.role}`);
    paths.add(spec.path);
    roles.add(spec.role);

    const absolutePath = path.resolve(root, spec.path);
    if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
      throw new Error(`artifact escapes repository root: ${spec.path}`);
    }
    const [buffer, metadata] = await Promise.all([readFile(absolutePath), stat(absolutePath)]);
    if (metadata.size !== spec.bytes) throw new Error(`${spec.path} byte size ${metadata.size} != ${spec.bytes}`);
    const actualHash = sha256(buffer);
    if (actualHash !== spec.sha256) throw new Error(`${spec.path} sha256 ${actualHash} != ${spec.sha256}`);

    const records = spec.record_count === null ? null : parseJsonLines(buffer, spec.path);
    if (records && records.length !== spec.record_count) {
      throw new Error(`${spec.path} record count ${records.length} != ${spec.record_count}`);
    }
    loaded.push({ spec, buffer, records });
  }

  const corpusSnapshot = JSON.parse(oneByRole(loaded, "CORPUS_SNAPSHOT").buffer.toString("utf8"));
  if (corpusSnapshot.corpus_snapshot_id !== manifest.corpus_snapshot_id) throw new Error("corpus snapshot id mismatch");
  if (corpusSnapshot.manifest_sha256 !== manifest.manifest_sha256) throw new Error("source manifest hash mismatch");

  const gold = oneByRole(loaded, "SEED_GOLD").records;
  const evidence = oneByRole(loaded, "VERIFIED_EVIDENCE").records;
  const relations = oneByRole(loaded, "RELATION_GOLD").records;
  const chains = oneByRole(loaded, "CHAIN_MANIFEST").records;
  const expected = manifest.expected_invariants;
  if (gold.length !== expected.gold_records) throw new Error("gold invariant mismatch");
  if (evidence.length !== expected.evidence_records) throw new Error("evidence invariant mismatch");
  if (relations.length !== expected.relation_records) throw new Error("relation invariant mismatch");
  if (chains.length !== expected.chain_records) throw new Error("chain invariant mismatch");

  const evidenceIds = new Set(evidence.map((item) => item.evidence_id));
  if (evidenceIds.size !== evidence.length) throw new Error("duplicate evidence_id in verified Evidence artifact");
  const goldEvidenceLinks = gold.flatMap((item) =>
    (item.extensions?.evidence_verification ?? []).map((link) => ({
      key: JSON.stringify([item.question_id, link.slot_name, link.evidence_id]),
      evidence_id: link.evidence_id,
    })),
  );
  const goldEvidenceLinkKeys = new Set(goldEvidenceLinks.map((link) => link.key));
  const duplicateLinkOccurrences = goldEvidenceLinks.length - goldEvidenceLinkKeys.size;
  if (duplicateLinkOccurrences !== expected.duplicate_gold_evidence_link_occurrences) {
    throw new Error(
      `duplicate Gold Evidence-link occurrences ${duplicateLinkOccurrences} != ${expected.duplicate_gold_evidence_link_occurrences}`,
    );
  }
  const goldEvidenceIds = new Set(goldEvidenceLinks.map((link) => link.evidence_id));
  const missingEvidence = setDifference(goldEvidenceIds, evidenceIds);
  const unreferencedEvidence = setDifference(evidenceIds, goldEvidenceIds);
  if (missingEvidence.length || unreferencedEvidence.length) {
    throw new Error(`gold/evidence set mismatch: missing=${missingEvidence.length} unreferenced=${unreferencedEvidence.length}`);
  }

  const chainIds = new Set(chains.map((item) => item.chain_id));
  if (chainIds.size !== chains.length) throw new Error("duplicate chain_id in chain manifest");
  const missingGoldChains = setDifference(new Set(gold.flatMap((item) => item.gold_chain_ids ?? [])), chainIds);
  if (missingGoldChains.length) throw new Error(`gold references unknown chains: ${missingGoldChains.join(",")}`);
  const missingRelationChains = setDifference(new Set(relations.map((item) => item.chain_id)), chainIds);
  if (missingRelationChains.length) throw new Error(`relations reference unknown chains: ${missingRelationChains.join(",")}`);

  const lockCounts = gold.reduce((result, item) => {
    const status = item.extensions?.split_lock_status;
    result[status] = (result[status] ?? 0) + 1;
    return result;
  }, {});
  if ((lockCounts.LOCKED_BY_CHAIN ?? 0) !== expected.locked_by_chain) throw new Error("LOCKED_BY_CHAIN count mismatch");
  if ((lockCounts.LOCKED_BY_COVERAGE ?? 0) !== expected.locked_by_coverage) throw new Error("LOCKED_BY_COVERAGE count mismatch");
  if ((lockCounts.PROVISIONAL_UNTIL_CHAIN_CLOSURE ?? 0) !== expected.provisional) throw new Error("PROVISIONAL count mismatch");

  return Object.freeze({
    release_id: manifest.release_id,
    release_status: manifest.release_status,
    artifact_count: loaded.length,
    total_bytes: loaded.reduce((sum, entry) => sum + entry.spec.bytes, 0),
    counts: Object.freeze({ gold: gold.length, evidence: evidence.length, relations: relations.length, chains: chains.length }),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) {
    console.error(
      "usage: node scripts/verify-seed-release.mjs <path-to-legacy-shaped-release-manifest.json>\n"
      + "This validator only understands the legacy (pre-v0.19) flat manifest.artifacts[] shape.\n"
      + "It does NOT verify the current v0.20 release -- see this file's header comment for where that lives.",
    );
    process.exitCode = 1;
  } else {
    const manifestPath = path.resolve(process.argv[2]);
    verifySeedRelease({ manifestPath })
      .then((result) => console.log(JSON.stringify({ ok: true, manifest_path: manifestPath, ...result }, null, 2)))
      .catch((error) => {
        console.error(JSON.stringify({ ok: false, manifest_path: manifestPath, error: error.message }, null, 2));
        process.exitCode = 1;
      });
  }
}
