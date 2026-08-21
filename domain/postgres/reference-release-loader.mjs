import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertNoSymlink } from "../adapters/seed-company-resolver.mjs";
import { resolveWithinBase } from "../adapters/bundle-manifest-path-safety.mjs";
import { assertBundleManifestBinding } from "../adapters/seed-release-bundle-manifest-binding.mjs";
import { verifyReleaseBundleDirectoryMatchesManifest } from "../adapters/seed-release-bundle-builder.mjs";
import { unpackReleaseBundle } from "../adapters/seed-release-bundle-unpack.mjs";
import { canonicalManifestBindingHash } from "../adapters/seed-runtime-service-adapters.mjs";
import { collectReferenceReleaseRecords, MULTI_RECORD_ROLES } from "./reference-release-contract.mjs";

// Local Set built fresh from the frozen array -- never a shared mutable
// Set (see MULTI_RECORD_ROLES's own header comment).
const multiRecordRoles = new Set(MULTI_RECORD_ROLES);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function decodeJson(bytes, label) {
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (error) { throw new Error(`${label}: invalid UTF-8: ${error.message}`); }
  try { return JSON.parse(text); }
  catch (error) { throw new Error(`${label}: invalid JSON: ${error.message}`); }
}

async function readPinnedControlFiles({ root, finalManifestPath, finalDecisionPath, expectedReleaseId, expectedApprovedRevision }) {
  // Turn N1.1: finalManifestPath/finalDecisionPath must actually resolve
  // inside root -- an absolute path or a ".."-escaping path pointing
  // anywhere else on disk was previously accepted as long as it happened
  // to exist and wasn't itself a symlink. Reuses the SAME shared
  // root-containment helper the bundle-manifest path safety layer
  // already uses, rather than a second, possibly-divergent check.
  const finalManifestAbs = resolveWithinBase(root, finalManifestPath, "reference final manifest");
  const finalDecisionAbs = resolveWithinBase(root, finalDecisionPath, "reference final decision");
  await Promise.all([
    assertNoSymlink(finalManifestAbs, "reference final manifest"),
    assertNoSymlink(finalDecisionAbs, "reference final decision"),
  ]);
  const [manifestBytes, decisionBytes] = await Promise.all([readFile(finalManifestAbs), readFile(finalDecisionAbs)]);
  const finalManifest = decodeJson(manifestBytes, "reference final manifest");
  const finalDecision = decodeJson(decisionBytes, "reference final decision");
  const finalManifestSha256 = sha256(manifestBytes);
  const finalDecisionSha256 = sha256(decisionBytes);
  if (finalManifest.release_authorization?.decision_artifact_sha256 !== finalDecisionSha256) {
    throw new Error("reference release: final decision SHA does not match the final manifest authorization pin");
  }
  // Turn N1.1: the manifest's OWN declared decision_artifact_path must
  // resolve to the SAME file this process actually read as
  // finalDecisionPath -- otherwise a byte-identical decision file copied
  // to (or symlink-aliased from -- already blocked above -- to) a
  // DIFFERENT path than the one the manifest itself declares would still
  // pass the hash-only check above.
  if (typeof finalManifest.release_authorization?.decision_artifact_path !== "string") {
    throw new Error("reference release: final manifest is missing release_authorization.decision_artifact_path");
  }
  if (path.resolve(root, finalManifest.release_authorization.decision_artifact_path) !== finalDecisionAbs) {
    throw new Error("reference release: finalDecisionPath does not match the final manifest's declared decision_artifact_path");
  }
  // The manifest contains the decision hash, so binding the decision back to
  // the manifest's raw bytes would be circular. The release authorization
  // contract therefore pins the canonical content with that authorization
  // stamp removed; use the same shared algorithm as production Runtime.
  if (finalDecision.canonical_release_manifest?.sha256 !== canonicalManifestBindingHash(finalManifest)) {
    throw new Error("reference release: final manifest SHA does not match the final decision pin");
  }
  // Turn N1.1: symmetric check on the decision side -- its OWN declared
  // canonical_release_manifest.path must resolve to the SAME file this
  // process actually read as finalManifestPath.
  if (typeof finalDecision.canonical_release_manifest?.path !== "string") {
    throw new Error("reference release: final decision is missing canonical_release_manifest.path");
  }
  if (path.resolve(root, finalDecision.canonical_release_manifest.path) !== finalManifestAbs) {
    throw new Error("reference release: finalManifestPath does not match the final decision's declared canonical_release_manifest.path");
  }
  if (finalManifest.release_id !== expectedReleaseId || finalDecision.release_id !== expectedReleaseId) {
    throw new Error("reference release: control files do not identify the expected release");
  }
  // Mirrors seed-runtime-service-adapters.mjs's assertExpectedReleaseIdentity:
  // undefined means "caller did not pin a revision" (no-op), never a
  // silent skip of a revision the caller DID supply.
  if (expectedApprovedRevision !== undefined) {
    if (finalManifest.approved_revision !== expectedApprovedRevision || finalDecision.approved_revision !== expectedApprovedRevision) {
      throw new Error(
        `reference release: approved_revision ("${finalDecision.approved_revision}") does not match the required expectedApprovedRevision ("${expectedApprovedRevision}")`,
      );
    }
  }
  if (finalManifest.release_status !== "APPROVED" || finalDecision.status !== "APPROVED") {
    throw new Error("reference release: only an APPROVED release may be imported");
  }
  if (finalManifest.corpus_snapshot_id !== finalDecision.corpus_snapshot_id) {
    throw new Error("reference release: corpus snapshot mismatch between final controls");
  }
  return Object.freeze({ finalManifest, finalDecision, finalManifestSha256, finalDecisionSha256 });
}

export async function withVerifiedReferenceBundle(options, consume) {
  const { root, bundleDir, bundleManifestPath, finalManifestPath, finalDecisionPath, expectedReleaseId, expectedApprovedRevision } = options ?? {};
  for (const [name, value] of Object.entries({ root, bundleDir, bundleManifestPath, finalManifestPath, finalDecisionPath, expectedReleaseId })) {
    if (typeof value !== "string" || value === "") throw new TypeError(`${name} is required`);
  }
  if (expectedApprovedRevision !== undefined && (typeof expectedApprovedRevision !== "string" || expectedApprovedRevision === "")) {
    throw new TypeError("expectedApprovedRevision must be a non-empty string when provided");
  }
  if (typeof consume !== "function") throw new TypeError("consume callback is required");

  const controls = await readPinnedControlFiles({ root, finalManifestPath, finalDecisionPath, expectedReleaseId, expectedApprovedRevision });
  const binding = await assertBundleManifestBinding(controls.finalDecision, bundleManifestPath, root);
  // Turn N1.1: assertBundleManifestBinding only proves bundleManifestPath
  // itself is the decision-pinned file. Nothing above ties that VERIFIED
  // path to the SEPARATE bundleDir parameter that verifyReleaseBundleDirectoryMatchesManifest
  // and unpackReleaseBundle are about to trust -- an independent review
  // reproduced this exact gap: a bundleDir pointing at a completely
  // different, merely internally-self-consistent bundle (its OWN
  // bundle-manifest.json matches ITS OWN entries, just not the approved
  // one) was silently accepted as long as bundleManifestPath separately
  // happened to be the real, approved file. bundleDir must contain
  // EXACTLY the same bundle-manifest.json file that was just verified,
  // checked by resolved absolute path (never a raw string compare, which
  // a differently-spelled-but-equivalent path could evade).
  const bundleDirManifestPath = path.resolve(bundleDir, "bundle-manifest.json");
  if (bundleDirManifestPath !== binding.bundleManifestPath) {
    throw new Error(
      `reference release: bundleDir (${bundleDir}) does not contain the same bundle-manifest.json that was verified as bundleManifestPath `
      + `(expected ${binding.bundleManifestPath}, bundleDir resolves to ${bundleDirManifestPath}) -- refusing to unpack an unverified bundle directory`,
    );
  }
  await verifyReleaseBundleDirectoryMatchesManifest({ bundleDir });

  const tempBase = await realpath(os.tmpdir());
  const materializedRoot = await mkdtemp(path.join(tempBase, "disclosure-reference-v020-"));
  try {
    await unpackReleaseBundle({ bundleDir, destRoot: materializedRoot });
    return await consume(Object.freeze({ materializedRoot, ...controls, ...binding }));
  } finally {
    await rm(materializedRoot, { recursive: true, force: true }).catch(() => {});
  }
}

function sameLoadedRelease(row, metadata) {
  return row.status === "READY"
    && row.bundle_manifest_sha256 === metadata.bundleManifestSha256
    && row.final_manifest_sha256 === metadata.finalManifestSha256
    && row.final_decision_sha256 === metadata.finalDecisionSha256;
}

export async function importReferenceRelease({ client, ...options }) {
  if (!client || typeof client.query !== "function") throw new TypeError("client.query is required");
  return withVerifiedReferenceBundle(options, async (verified) => {
    const metadata = Object.freeze({
      releaseId: verified.finalDecision.release_id,
      approvedRevision: verified.finalDecision.approved_revision,
      corpusSnapshotId: verified.finalDecision.corpus_snapshot_id,
      factCoverageSnapshotId: verified.finalDecision.fact_coverage_snapshot_id ?? null,
      bundleManifestSha256: verified.bundleManifestSha256,
      finalManifestSha256: verified.finalManifestSha256,
      finalDecisionSha256: verified.finalDecisionSha256,
    });

    await client.query("BEGIN");
    try {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`disclosure-reference:${metadata.releaseId}`]);
      const existing = await client.query(
        "SELECT status, bundle_manifest_sha256, final_manifest_sha256, final_decision_sha256 FROM disclosure_reference.releases WHERE release_id = $1",
        [metadata.releaseId],
      );
      if (existing.rows.length > 0) {
        if (!sameLoadedRelease(existing.rows[0], metadata)) {
          throw new Error(`reference release ${metadata.releaseId} already exists with different identity or hashes`);
        }
        await client.query("COMMIT");
        return Object.freeze({ status: "ALREADY_LOADED", release_id: metadata.releaseId });
      }

      await client.query(
        `INSERT INTO disclosure_reference.releases
          (release_id, status, approved_revision, corpus_snapshot_id, fact_coverage_snapshot_id,
           bundle_manifest_sha256, final_manifest_sha256, final_decision_sha256,
           bundle_entry_count, bundle_manifest, final_manifest, final_decision)
         VALUES ($1, 'LOADING', $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb)`,
        [
          metadata.releaseId, metadata.approvedRevision, metadata.corpusSnapshotId, metadata.factCoverageSnapshotId,
          metadata.bundleManifestSha256, metadata.finalManifestSha256, metadata.finalDecisionSha256,
          verified.bundleManifest.entries.length, JSON.stringify(verified.bundleManifest),
          JSON.stringify(verified.finalManifest), JSON.stringify(verified.finalDecision),
        ],
      );

      // Artifact parents are inserted before streaming records so the
      // non-deferrable (release_id, role) FK is satisfied at every statement.
      // loaded_record_count starts at zero and is finalized after that role's
      // bytes have been fully decoded and counted, all inside this transaction.
      for (const entry of verified.bundleManifest.entries) {
        // Turn N1.2: entry.record_count is only meaningful as a DB
        // row-count contract for roles collectReferenceReleaseRecords
        // actually parses into multiple records (JSONL/array roles). For
        // a single-control-object role, a non-null record_count (e.g.
        // COMPANY_DIRECTORY_OWNER_DECISION's real 70, meaning "70 Company
        // Directory records approved", not "70 DB rows for THIS
        // artifact") describes something else entirely -- storing it as
        // declared_record_count would make the READY-transition trigger's
        // declared-vs-loaded check reject a perfectly valid import. See
        // MULTI_RECORD_ROLES's own header comment.
        const declaredRecordCount = multiRecordRoles.has(entry.role) ? (entry.record_count ?? null) : null;
        await client.query(
          `INSERT INTO disclosure_reference.artifacts
            (release_id, role, bundle_path, source_path, compression, encoded_sha256, decoded_sha256,
             encoded_bytes, decoded_bytes, declared_record_count, loaded_record_count)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0)`,
          [metadata.releaseId, entry.role, entry.bundle_path, entry.source_path, entry.compression,
            entry.encoded_sha256 ?? null, entry.decoded_sha256, entry.encoded_bytes ?? null,
            entry.decoded_bytes, declaredRecordCount],
        );
      }

      const inventory = await collectReferenceReleaseRecords({
        materializedRoot: verified.materializedRoot,
        bundleManifest: verified.bundleManifest,
        async onRecord(record) {
          await client.query(
            `INSERT INTO disclosure_reference.records
              (release_id, role, ordinal, record_key, corp_code, document_id, question_id, metric_code, payload)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
            [metadata.releaseId, record.role, record.ordinal, record.recordKey, record.corpCode,
              record.documentId, record.questionId, record.metricCode, JSON.stringify(record.payload)],
          );
        },
        async onArtifact({ entry, loadedRecordCount }) {
          await client.query(
            `UPDATE disclosure_reference.artifacts
             SET loaded_record_count = $3
             WHERE release_id = $1 AND role = $2`,
            [metadata.releaseId, entry.role, loadedRecordCount],
          );
        },
      });

      await client.query(
        `UPDATE disclosure_reference.releases
         SET status = 'READY', record_counts = $2::jsonb, imported_at = now()
         WHERE release_id = $1`,
        [metadata.releaseId, JSON.stringify(inventory.roleCounts)],
      );
      await client.query("COMMIT");
      return Object.freeze({ status: "LOADED", release_id: metadata.releaseId, role_counts: inventory.roleCounts });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  });
}

export async function applyReferenceReleaseMigration({ client, root }) {
  if (!client || typeof client.query !== "function") throw new TypeError("client.query is required");
  if (typeof root !== "string" || root === "") throw new TypeError("root is required");
  const versionResult = await client.query("SHOW server_version_num");
  const versionNumber = Number(versionResult.rows?.[0]?.server_version_num);
  if (!Number.isInteger(versionNumber) || versionNumber < 160000 || versionNumber >= 170000) {
    throw new Error(`PostgreSQL 16 is required (server_version_num=${versionResult.rows?.[0]?.server_version_num ?? "missing"})`);
  }
  const sql = await readFile(path.join(root, "domain/postgres/002_reference_release.sql"), "utf8");
  await client.query(sql);
}
