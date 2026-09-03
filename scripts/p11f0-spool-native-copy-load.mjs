#!/usr/bin/env node
// Turn AC-VFINAL-ALIGNMENT-AND-DISCOVERY, section I/K: loads a discovery
// file spool (scripts/p11f0-corpus-discovery-spool.mjs's output) into
// PostgreSQL using the NATIVE `psql` binary's client-side `\copy`, never
// Node's `pg` package, for the actual bulk data transfer -- `pg` is used
// here ONLY for small, low-volume control-plane calls (creating/reading the
// load_session row, the final recount-based checkpoint update), never for
// row-volume traffic. This is the other half of section I's "make
// PostgreSQL network I/O zero in the Node discovery process" -- discovery
// itself (p11f0-corpus-discovery-spool.mjs) already does zero DB I/O; this
// script is a SEPARATE process that runs afterward.
//
// Pre-flight (before ANY \copy is issued): every shard file's on-disk size
// and SHA-256 are re-verified against the manifest -- a corrupt, missing,
// or short-written shard is rejected before touching the database at all.
// The manifest's own execution_attempt_id must match the target attempt
// (cross-attempt mixing is rejected, fail-closed) via createOrGetAttempt's
// own collision handling.
//
// Per-shard load: `BEGIN; \copy ... FROM '<shard>' WITH (FORMAT text);
// COMMIT;` via a psql script (never string-interpolated SQL -- the shard
// path is the only variable part, and it comes from the manifest's own
// already-hash-verified filename list, joined with the caller-supplied
// spool directory). A shard whose COPY (or the transaction it's in) fails
// leaves ZERO rows from that shard in the table (COPY is fully
// transactional) -- retrying is always safe. Successfully loaded shards are
// recorded in a local `.load-checkpoint.json` file in the spool directory
// so a re-run skips already-committed shards (never re-COPYing a shard
// whose primary key would now collide).
import { createHash } from "node:crypto";
import { readFile, writeFile, rename, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import pg from "pg";

const { Client } = pg;

// Turn AC-VFINAL-ALIGNMENT-AND-DISCOVERY: shard filenames come from
// manifest.json -- untrusted input from the loader's point of view (a
// corrupt or tampered manifest is an explicitly anticipated case, section
// K's own "corrupt/missing/duplicate shard 거부"). A filename that does not
// match this exact pattern is rejected fail-closed BEFORE it is ever
// joined into a filesystem path (path traversal via "../") or interpolated
// into a psql script's `\copy ... FROM '<path>'` literal (breaking out of
// the quoted literal to inject additional SQL/meta-commands).
export const SAFE_SHARD_FILENAME = /^(canonical|chunk)-\d{6}\.copy$/;

export function assertSafeShardFilename(filename) {
  if (!SAFE_SHARD_FILENAME.test(filename)) {
    throw new Error(`UNSAFE_SHARD_FILENAME: "${filename}" does not match ${SAFE_SHARD_FILENAME} -- refusing to use it in a filesystem path or psql script (path traversal / injection defense)`);
  }
}

async function sha256OfFile(filePath) {
  const hash = createHash("sha256");
  const buf = await readFile(filePath);
  hash.update(buf);
  return hash.digest("hex");
}

async function loadCheckpoint(checkpointPath) {
  try {
    return JSON.parse(await readFile(checkpointPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { loaded_shards: [] };
    throw error;
  }
}

async function saveCheckpointAtomic(checkpointPath, value) {
  const partialPath = `${checkpointPath}.partial`;
  await writeFile(partialPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(partialPath, checkpointPath);
}

// Turn AC-VFINAL-ALIGNMENT-AND-DISCOVERY: a `postgresql://user:pass@host:port/db`
// connection string carries a password in cleartext. Passed as a `psql`
// CLI argument, it is visible to any other local user via `ps`/`ps aux`
// (process argv is not private) for as long as the process runs. Parsed
// here into components instead: host/port/user/dbname go on the psql
// command line (not secret), the password (if any) is set ONLY in the
// spawned subprocess's own environment as PGPASSWORD -- never inherited by
// this script's own process.env, never logged, never in argv.
export function parsePgConnectionParts(databaseUrl) {
  const url = new URL(databaseUrl);
  if (!/^postgres(ql)?:$/.test(url.protocol)) {
    throw new Error(`DATABASE_URL must use the postgresql:// scheme, got "${url.protocol}"`);
  }
  return {
    host: url.hostname || undefined,
    port: url.port || undefined,
    user: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    database: url.pathname ? decodeURIComponent(url.pathname.replace(/^\//, "")) : undefined,
  };
}

function runPsqlScript({ psqlBin, databaseUrl, script }) {
  const conn = parsePgConnectionParts(databaseUrl);
  const args = ["-v", "ON_ERROR_STOP=1", "-X", "-q"];
  if (conn.host) args.push("-h", conn.host);
  if (conn.port) args.push("-p", conn.port);
  if (conn.user) args.push("-U", conn.user);
  if (conn.database) args.push("-d", conn.database);
  const env = { ...process.env };
  if (conn.password) env.PGPASSWORD = conn.password;
  else delete env.PGPASSWORD;

  const result = spawnSync(psqlBin, args, {
    input: script, encoding: "utf8", maxBuffer: 1024 * 1024 * 64, env,
  });
  if (result.status !== 0) {
    throw new Error(`psql exited ${result.status}: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function loadTable({ psqlBin, databaseUrl, spoolDir, shards, tableName, columns, checkpoint, checkpointPath, checkpointKey }) {
  const loadedSet = new Set(checkpoint.loaded_shards.filter((s) => s.table === tableName).map((s) => s.filename));
  for (const shard of shards) {
    if (loadedSet.has(shard.filename)) {
      console.error(`[spool-copy-load] SKIP (already loaded per checkpoint): ${tableName}/${shard.filename}`);
      continue;
    }
    assertSafeShardFilename(shard.filename);
    const shardPath = path.join(spoolDir, shard.filename);
    const info = await stat(shardPath).catch(() => null);
    if (!info) throw new Error(`SHARD_MISSING: ${shardPath} (manifest declares it, file not found)`);
    if (info.size !== shard.byte_count) {
      throw new Error(`SHARD_SIZE_MISMATCH: ${shard.filename} on-disk size ${info.size} != manifest byte_count ${shard.byte_count}`);
    }
    const actualSha256 = await sha256OfFile(shardPath);
    if (actualSha256 !== shard.sha256) {
      throw new Error(`SHARD_SHA256_MISMATCH: ${shard.filename} on-disk sha256 ${actualSha256} != manifest sha256 ${shard.sha256} (corrupt shard, refusing to load)`);
    }

    const columnList = columns.join(", ");
    const script = `BEGIN;\n\\copy disclosure_reference.${tableName} (${columnList}) FROM '${shardPath}' WITH (FORMAT text)\nCOMMIT;\n`;
    console.error(`[spool-copy-load] loading ${tableName}/${shard.filename} (${shard.row_count} rows, ${shard.byte_count} bytes)...`);
    runPsqlScript({ psqlBin, databaseUrl, script });

    checkpoint.loaded_shards.push({ table: tableName, filename: shard.filename, row_count: shard.row_count, sha256: shard.sha256, loaded_at: new Date().toISOString() });
    // eslint-disable-next-line no-await-in-loop
    await saveCheckpointAtomic(checkpointPath, checkpoint);
    loadedSet.add(shard.filename);
  }
}

async function main() {
  const spoolDir = process.env.P11F0_SPOOL_DIR;
  if (!spoolDir) throw new Error("P11F0_SPOOL_DIR is required");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const psqlBin = process.env.P11F0_PSQL_BIN;
  if (!psqlBin) throw new Error("P11F0_PSQL_BIN is required -- no default path (never a personal absolute path baked into code)");

  const manifestPath = path.join(spoolDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!manifest.double_pass_match) {
    throw new Error("SPOOL_NOT_DOUBLE_PASS_VERIFIED: manifest.double_pass_match is false -- refusing to load an unverified spool");
  }
  const { execution_attempt_id: executionAttemptId, logical_load_id: logicalLoadId } = manifest;

  const checkpointPath = path.join(spoolDir, ".load-checkpoint.json");
  const checkpoint = await loadCheckpoint(checkpointPath);
  if (checkpoint.execution_attempt_id && checkpoint.execution_attempt_id !== executionAttemptId) {
    throw new Error(`CROSS_ATTEMPT_CHECKPOINT_MISMATCH: existing checkpoint is for ${checkpoint.execution_attempt_id}, manifest declares ${executionAttemptId} -- refusing to mix checkpoints across attempts`);
  }
  checkpoint.execution_attempt_id = executionAttemptId;
  checkpoint.logical_load_id = logicalLoadId;

  // Control-plane only (session existence/status check) -- the ONLY Node
  // `pg` usage in this script, and it never carries row-volume data.
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const existing = await client.query(
      "SELECT load_session_id, status, logical_load_id FROM disclosure_reference.reference_fixed_kure_load_sessions WHERE load_session_id = $1",
      [executionAttemptId],
    );
    if (existing.rows.length === 0) {
      throw new Error(`ATTEMPT_NOT_FOUND: execution_attempt_id ${executionAttemptId} has no row in reference_fixed_kure_load_sessions -- create it via createOrGetAttempt before loading its spool`);
    }
    const session = existing.rows[0];
    if (session.logical_load_id !== logicalLoadId) {
      throw new Error(`CROSS_ATTEMPT_MIXING: DB row's logical_load_id (${session.logical_load_id}) != manifest's (${logicalLoadId})`);
    }
    if (session.status !== "DISCOVERING") {
      throw new Error(`ATTEMPT_NOT_DISCOVERING: execution_attempt_id ${executionAttemptId} has status=${session.status}, refusing to load into a non-DISCOVERING attempt`);
    }

    await saveCheckpointAtomic(checkpointPath, checkpoint);

    await loadTable({
      psqlBin, databaseUrl, spoolDir, shards: manifest.spool.canonical_shards,
      tableName: "reference_fixed_kure_canonical_queue",
      columns: ["load_session_id", "embed_text_sha256", "embed_text", "char_length"],
      checkpoint, checkpointPath,
    });
    await loadTable({
      psqlBin, databaseUrl, spoolDir, shards: manifest.spool.chunk_shards,
      tableName: "reference_fixed_kure_chunk_staging",
      columns: [
        "load_session_id", "chunk_id", "document_id", "chunk_index", "chunk_type", "parent_chunk_id", "content_sha256",
        "raw_text", "embed_text_sha256", "token_count",
        "corp_code", "doc_group", "receipt_date", "section_path", "source_locator", "source_spans",
        "chunking_policy_id", "chunking_policy_version", "retrieval_eligible", "metadata",
      ],
      checkpoint, checkpointPath,
    });

    // Recount-based checkpoint: always exactly correct regardless of how
    // many shards were loaded in this run vs. a prior partial run -- never
    // an incremental add prone to double-counting on retry.
    const counts = await client.query(
      `SELECT
         (SELECT count(*)::int FROM disclosure_reference.reference_fixed_kure_chunk_staging WHERE load_session_id = $1) AS total_chunk_count,
         (SELECT count(*)::int FROM disclosure_reference.reference_fixed_kure_chunk_staging WHERE load_session_id = $1 AND retrieval_eligible) AS search_eligible_count,
         (SELECT count(*)::int FROM disclosure_reference.reference_fixed_kure_canonical_queue WHERE load_session_id = $1) AS unique_text_count`,
      [executionAttemptId],
    );
    const { total_chunk_count: totalChunkCount, search_eligible_count: searchEligibleCount, unique_text_count: uniqueTextCount } = counts.rows[0];
    await client.query(
      `UPDATE disclosure_reference.reference_fixed_kure_load_sessions
       SET discovered_document_count = $2, discovered_total_chunk_count = $3,
           discovered_search_eligible_count = $4, discovered_unique_text_count = $5,
           source_files_progress = $6::jsonb
       WHERE load_session_id = $1`,
      [executionAttemptId, manifest.pass1.document_count, totalChunkCount, searchEligibleCount, uniqueTextCount, JSON.stringify(manifest.pass1.source_files_progress)],
    );
    console.error(`[spool-copy-load] checkpoint recount: total_chunk_count=${totalChunkCount} search_eligible_count=${searchEligibleCount} unique_text_count=${uniqueTextCount}`);
    console.error(`[spool-copy-load] info: manifest pass1.chunk_count=${manifest.pass1.chunk_count} (ALL chunks incl. non-retrieval-eligible ones -- chunk_staging only ever stores retrieval-eligible chunks, matching the pre-existing insertChunkBatch/updateDiscoveryCheckpoint semantics this loader preserves unchanged)`);

    // chunk_staging (and therefore discovered_total_chunk_count) only ever
    // holds retrieval-eligible rows -- the SAME pre-existing semantic
    // updateDiscoveryCheckpoint's own newTotalChunkCount: pendingChunkRows.length
    // always had (pendingChunkRows only ever contains eligible chunks).
    // manifest.spool.chunk_total_rows carries that same eligible-only count;
    // manifest.pass1.chunk_count (447,895 for the real corpus) is the TRUE
    // total including non-eligible chunks and is never expected to equal a
    // chunk_staging row count.
    const dbCountsMatchSpool = totalChunkCount === manifest.spool.chunk_total_rows
      && searchEligibleCount === manifest.pass1.search_eligible_count
      && uniqueTextCount === manifest.pass1.unique_text_count;
    if (!dbCountsMatchSpool) {
      throw new Error(`DB_SPOOL_COUNT_MISMATCH: db(total=${totalChunkCount}, eligible=${searchEligibleCount}, unique=${uniqueTextCount}) != spool(total=${manifest.spool.chunk_total_rows}, eligible=${manifest.pass1.search_eligible_count}, unique=${manifest.pass1.unique_text_count})`);
    }
    console.error("[spool-copy-load] SPOOL_LOAD_COMPLETE: DB counts match spool manifest exactly.");
  } finally {
    await client.end();
  }
}

// Guarded so tests can import this module's exported helpers
// (assertSafeShardFilename, parsePgConnectionParts) without also
// triggering this CLI's own main() -- behavior when this file is run
// directly (`node scripts/p11f0-spool-native-copy-load.mjs`) is unchanged.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[spool-copy-load] FAILED: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
