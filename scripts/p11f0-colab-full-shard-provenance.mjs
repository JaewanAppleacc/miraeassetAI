#!/usr/bin/env node
// Turn AC-COLAB-FULL-SHARDS-V1, remaining item 3: execution/provenance
// manifest. Ties together (a) a local shard-set verification report
// (scripts/p11f0-colab-full-shard-verify.mjs), (b) an optional logical
// merge manifest (scripts/p11f0-colab-full-shard-merge-manifest.mjs), and
// (c) the exact source tree this run executed from (reusing the existing
// domain/evaluation-harness/source-tree-guard.mjs git_commit/
// source_tree_hash pair rather than re-deriving git state by hand), into
// ONE audit record for the Codex handoff. Read-only: never uploads,
// never calls an embedding model, never writes to the database.
import { readFile, writeFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { assertReproducibleSourceTree } from "../domain/evaluation-harness/source-tree-guard.mjs";
import { verifyLocalShardSet } from "./p11f0-colab-full-shard-verify.mjs";

export const PROVENANCE_MANIFEST_SCHEMA = "p11f0-colab-full-shard-provenance.v1";
export const TURN_ID = "AC-COLAB-FULL-SHARDS-V1";

export async function writeJsonAtomic(finalPath, value) {
  const partialPath = `${finalPath}.partial`;
  await writeFile(partialPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "w" });
  await rename(partialPath, finalPath);
}

export async function sha256HexOfFile(filePath) {
  const buf = await readFile(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

// Pure assembly function, no I/O of its own -- callers gather each input
// independently (verifyLocalShardSet's report, buildLogicalMergeManifest's
// output or null, assertReproducibleSourceTree's result, and a
// {relativePath: sha256Hex} map of the scripts that produced this record)
// so this stays trivially unit-testable with synthetic inputs.
export function buildExecutionProvenanceManifest({
  localShardVerification, logicalMergeManifest = null, sourceTree, scriptHashes, nodeVersion = process.version,
}) {
  const errors = [];
  if (!localShardVerification) errors.push("MISSING_LOCAL_SHARD_VERIFICATION");
  else if (!localShardVerification.ok) errors.push(`LOCAL_SHARD_VERIFICATION_FAILED: ${localShardVerification.errors.length} error(s)`);
  if (logicalMergeManifest && !logicalMergeManifest.ok) errors.push(`LOGICAL_MERGE_MANIFEST_FAILED: ${logicalMergeManifest.errors.length} error(s)`);
  if (!sourceTree) errors.push("MISSING_SOURCE_TREE");

  return {
    schema_version: PROVENANCE_MANIFEST_SCHEMA,
    turn_id: TURN_ID,
    generated_at: new Date().toISOString(),
    node_version: nodeVersion,
    source_tree: sourceTree ? {
      git_commit: sourceTree.git_commit,
      source_tree_hash: sourceTree.source_tree_hash,
      clean: sourceTree.clean,
      release_eligible: sourceTree.release_eligible,
      dirty_entry_count: sourceTree.status_summary?.length ?? null,
    } : null,
    script_hashes: scriptHashes,
    local_shard_verification: localShardVerification ? {
      ok: localShardVerification.ok,
      error_count: localShardVerification.errors.length,
      errors: localShardVerification.errors,
      total_rows_verified: localShardVerification.total_rows_verified,
      membership_sha256: localShardVerification.membership_sha256,
      ordering_sha256: localShardVerification.ordering_sha256,
      overlap_count: localShardVerification.overlap_count,
      missing_global_index_count: localShardVerification.missing_global_index_count,
      shards_ok: localShardVerification.shards.map((s) => ({ shard_id: s.shard_id, ok: s.ok })),
    } : null,
    logical_merge_manifest: logicalMergeManifest ? {
      ok: logicalMergeManifest.ok,
      is_complete: logicalMergeManifest.is_complete,
      shards_present: logicalMergeManifest.shards_present,
      shards_missing: logicalMergeManifest.shards_missing,
      total_rows_covered_so_far: logicalMergeManifest.total_rows_covered_so_far,
      error_count: logicalMergeManifest.errors.length,
    } : null,
    ok: errors.length === 0,
    errors,
    // Explicit negative-confirmation fields -- this Turn's own constraints
    // (CLAUDE.md section 0 "금지" list), restated here so a downstream
    // reader (Codex) never has to re-derive them from the absence of a
    // field.
    external_upload_performed: false,
    real_embedding_calls_performed: 0,
    database_write_performed: false,
    restricted_evaluation_splits_accessed: false,
  };
}

async function main() {
  const [exportManifestPath, shardsDir, outPath, logicalMergeManifestPath] = process.argv.slice(2);
  if (!exportManifestPath || !shardsDir || !outPath) {
    console.error("usage: node p11f0-colab-full-shard-provenance.mjs <full-shard-export-manifest.json> <shardsDir> <out-provenance-manifest.json> [logical-merge-manifest.json]");
    process.exitCode = 1;
    return;
  }

  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const [localShardVerification, sourceTree] = await Promise.all([
    verifyLocalShardSet({ exportManifestPath, shardsDir }),
    assertReproducibleSourceTree({ cwd: repoRoot, allowDirty: true }),
  ]);
  const logicalMergeManifest = logicalMergeManifestPath ? JSON.parse(await readFile(logicalMergeManifestPath, "utf8")) : null;

  const scriptFiles = [
    "scripts/p11f0-colab-full-shard-export.mjs",
    "scripts/p11f0-colab-full-shard-verify.mjs",
    "scripts/p11f0-colab-full-shard-merge-manifest.mjs",
    "scripts/p11f0-colab-full-shard-provenance.mjs",
  ];
  const scriptHashes = {};
  for (const rel of scriptFiles) scriptHashes[rel] = await sha256HexOfFile(path.join(repoRoot, rel));

  const provenance = buildExecutionProvenanceManifest({ localShardVerification, logicalMergeManifest, sourceTree, scriptHashes });
  await writeJsonAtomic(outPath, provenance);
  console.log(JSON.stringify(provenance, null, 2));
  process.exitCode = provenance.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[full-shard-provenance] FAILED: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
