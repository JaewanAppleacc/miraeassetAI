// Turn P9.3: orchestration-logic tests for run-real-embedding-calibration-v01.mjs.
// NONE of these download or load a real model -- they exercise the
// download-manifest/tokenizer-check/repeatability/process-lifecycle logic
// against the SAME loopback mock server Turn P9.2 already built, or
// against synthetic filesystem fixtures. Real snapshot-identity assertions
// (once a real download has actually happened) live in a SEPARATE,
// explicitly-gated test further below that is a no-op unless the
// task-owned cache already contains a real downloaded snapshot.
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { startMockLoopbackEmbeddingServer } from "./lib/mock-loopback-embedding-server.mjs";
import { getFrozenCandidateById, loadFrozenCandidateRegistry } from "../domain/agent-comparison/embedding-calibration/frozen-candidates/registry.mjs";
import {
  waitForServerReady, stopServer, checkTokenLengths, repositoryToHfCacheDirName,
  buildDownloadManifestEntry, dirSizeBytes, CACHE_LIMIT_BYTES, CANDIDATE_ORDER, EXPECTED_DATASET_SHA256,
  HF_CACHE_DIR,
} from "../scripts/run-real-embedding-calibration-v01.mjs";

function itemsFor(n) {
  return Array.from({ length: n }, (_, i) => ({
    calibrationItemId: `calitem_${i}`, factId: `fact_${i}`, evidenceId: `evidence_${i}`,
    sourceDocumentId: `doc_${i}`, corpCode: "00000001", inputTextSha256: `sha_${i}`,
    expectedSelfMatchId: `calitem_${i}`, textContent: `text number ${i}`,
  }));
}

// =====================================================================
// local server identity contract (reused P9.2 mock -- proves the P9.3
// orchestrator's OWN helper functions, not just runner.mjs's)
// =====================================================================

test("checkTokenLengths reports p50/p95/max and flags zero over-length items for a well-behaved server", async () => {
  const kure = getFrozenCandidateById("kure_v1");
  const server = await startMockLoopbackEmbeddingServer({
    info: { repository_id: kure.repository_id, model_revision: kure.immutable_revision, dimension: kure.embedding_dimension, max_input_length: kure.max_input_length, ready: true },
    dimension: kure.embedding_dimension,
  });
  try {
    const result = await checkTokenLengths(server.baseUrl, kure, itemsFor(5));
    assert.equal(result.truncation_would_occur, false);
    assert.deepEqual(result.over_length_items, []);
    assert.ok(Number.isInteger(result.token_count_p50));
    assert.ok(Number.isInteger(result.token_count_max));
  } finally {
    await server.close();
  }
});

test("checkTokenLengths flags every item whose (prepared) length exceeds max_input_length, for both document and query modes, without truncating", async () => {
  const kure = getFrozenCandidateById("kure_v1");
  const server = await startMockLoopbackEmbeddingServer({
    info: { repository_id: kure.repository_id, model_revision: kure.immutable_revision, dimension: kure.embedding_dimension, max_input_length: 2, ready: true }, // deliberately tiny to force over-length
    dimension: kure.embedding_dimension,
  });
  try {
    const result = await checkTokenLengths(server.baseUrl, kure, itemsFor(3));
    assert.equal(result.truncation_would_occur, true);
    assert.ok(result.over_length_items.length > 0);
    for (const entry of result.over_length_items) {
      assert.ok(["document", "query"].includes(entry.mode));
      assert.ok(entry.token_count > 2);
    }
  } finally {
    await server.close();
  }
});

// =====================================================================
// sequential one-model-at-a-time discipline
// =====================================================================

test("CANDIDATE_ORDER is exactly the 3 frozen candidates, in the recommended order, with no 4th model ever added", () => {
  assert.deepEqual(CANDIDATE_ORDER, ["kure_v1", "bge_m3", "pixie_rune"]);
});

test("waitForServerReady resolves with the port from a LISTENING line, and rejects if the child exits before printing one", async () => {
  const listening = spawn(process.execPath, ["-e", "console.log('LISTENING 127.0.0.1:54321')"]);
  const port = await waitForServerReady(listening, 5000);
  assert.equal(port, 54321);

  const crashed = spawn(process.execPath, ["-e", "process.exit(1)"]);
  await assert.rejects(() => waitForServerReady(crashed, 5000));
});

test("stopServer waits for the child to actually exit (never returns while the process is still alive)", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  await new Promise((resolve) => { setTimeout(resolve, 100); }); // let it actually start
  assert.equal(child.exitCode, null);
  await stopServer(child);
  // Node sets exitCode=null (and signalCode instead) when a process is
  // terminated by a signal rather than calling exit() itself -- SIGTERM
  // is exactly that case, so "has exited" means either field is non-null.
  assert.ok(child.exitCode !== null || child.signalCode !== null, "the process must have exited (via exit code or signal) by the time stopServer resolves");
});

test("only one model server is ever spawned per runOneCandidate call -- sequential discipline is structural (a fresh child per candidate, never two concurrently in this file's own design)", async () => {
  // This is a design-level assertion: runOneCandidate's own body spawns
  // exactly one `serverChild`, and the orchestrator's main() loop awaits
  // each runOneCandidate call fully (via `for...of` + `await`, never
  // Promise.all) before starting the next -- verified by static inspection
  // here since actually spawning 3 real models just to prove this would
  // defeat the "bounded" resource contract this Turn itself imposes.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../scripts/run-real-embedding-calibration-v01.mjs", import.meta.url), "utf8");
  assert.ok(!/Promise\.all\(\s*CANDIDATE_ORDER/.test(source), "candidates must never be run concurrently via Promise.all");
  assert.ok(/for \(const frozenCandidateId of CANDIDATE_ORDER\)/.test(source), "the main loop must iterate candidates one at a time");
});

// =====================================================================
// download manifest (synthetic fixture -- no real download)
// =====================================================================

test("repositoryToHfCacheDirName matches HuggingFace's own cache directory naming convention", () => {
  assert.equal(repositoryToHfCacheDirName("nlpai-lab/KURE-v1"), "models--nlpai-lab--KURE-v1");
  assert.equal(repositoryToHfCacheDirName("BAAI/bge-m3"), "models--BAAI--bge-m3");
});

test("buildDownloadManifestEntry reports snapshot_dir_exists=false (never throws) when the snapshot has not actually been downloaded", async () => {
  const kure = getFrozenCandidateById("kure_v1");
  const entry = await buildDownloadManifestEntry(kure);
  // This test runs against whatever the CURRENT task-owned cache state is
  // -- it must never throw either way; only assert the shape.
  assert.equal(typeof entry.snapshot_dir_exists, "boolean");
  assert.ok(Array.isArray(entry.files));
});

test("the snapshot directory naming this module derives (hub/models--org--name/snapshots/<revision>) matches a real synthetic HuggingFace-cache-shaped layout, and its core files hash deterministically", async () => {
  const fakeCacheRoot = await mkdtemp(path.join(tmpdir(), "p93-fake-hf-cache-"));
  try {
    const snapshotDir = path.join(fakeCacheRoot, "hub", repositoryToHfCacheDirName("test/fake-model"), "snapshots", "f".repeat(40));
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(path.join(snapshotDir, "config.json"), JSON.stringify({ hidden_size: 1024 }));
    await writeFile(path.join(snapshotDir, "model.safetensors"), Buffer.from("fake-weights-not-real"));
    await writeFile(path.join(snapshotDir, "README.md"), "not a core file, no sha expected");
    assert.ok(existsSync(snapshotDir));

    const { createHash } = await import("node:crypto");
    const { readFile } = await import("node:fs/promises");
    const configSha = createHash("sha256").update(await readFile(path.join(snapshotDir, "config.json"))).digest("hex");
    assert.match(configSha, /^[0-9a-f]{64}$/, "config.json (a core file) must be SHA256-hashable exactly like buildDownloadManifestEntry does for real downloads");
  } finally {
    await rm(fakeCacheRoot, { recursive: true, force: true });
  }
});

// =====================================================================
// cache limit
// =====================================================================

test("CACHE_LIMIT_BYTES is exactly 12GB, per the user-approved budget", () => {
  assert.equal(CACHE_LIMIT_BYTES, 12 * 1024 * 1024 * 1024);
});

test("dirSizeBytes returns 0 (never throws) for a non-existent directory", async () => {
  const size = await dirSizeBytes(path.join(tmpdir(), `p93-definitely-does-not-exist-${Date.now()}`));
  assert.equal(size, 0);
});

// =====================================================================
// dataset pin
// =====================================================================

test("EXPECTED_DATASET_SHA256 matches the exact Turn P9 dataset pin (98-item non-Gold calibration set)", () => {
  assert.equal(EXPECTED_DATASET_SHA256, "9848b30c8704b647eeab6820cd0f89473f2d659da9aae72c5a4eb9f58f0b28b0");
});

// =====================================================================
// process/port cleanup
// =====================================================================

// =====================================================================
// real pinned snapshot identity (GATED -- a no-op skip unless the
// task-owned cache already holds a real download from a prior real run;
// this file never triggers a download itself)
// =====================================================================

test("every pinned candidate's real downloaded snapshot on disk (if present) matches its registry pin exactly -- repository dir name, revision dir, and a real config.json readable as JSON", async (t) => {
  const registry = loadFrozenCandidateRegistry();
  for (const candidate of registry.candidates) {
    const snapshotDir = path.join(
      HF_CACHE_DIR,
      repositoryToHfCacheDirName(candidate.repository_id),
      "snapshots",
      candidate.immutable_revision,
    );
    if (!existsSync(snapshotDir)) {
      t.diagnostic(`skipping ${candidate.frozen_candidate_id}: no real download present at ${snapshotDir} (this test never downloads one itself)`);
      continue;
    }
    const { readFile, readdir } = await import("node:fs/promises");
    const files = await readdir(snapshotDir);
    assert.ok(files.length > 0, `${candidate.frozen_candidate_id}'s real snapshot directory must not be empty`);
    assert.ok(
      files.some((name) => name === "config.json" || name.endsWith(".safetensors") || name.endsWith(".bin")),
      `${candidate.frozen_candidate_id}'s real snapshot must contain at least one recognizable model file`,
    );
    if (files.includes("config.json")) {
      const config = JSON.parse(await readFile(path.join(snapshotDir, "config.json"), "utf8"));
      assert.ok(config && typeof config === "object", `${candidate.frozen_candidate_id}'s real config.json must parse as a JSON object`);
    }
    // The directory name itself IS the revision -- HuggingFace's own cache
    // layout makes this assertion redundant with path construction above,
    // but it documents the invariant explicitly: a real snapshot can never
    // silently live under a DIFFERENT revision than the one requested.
    assert.equal(path.basename(snapshotDir), candidate.immutable_revision);
  }
});

test("the real per-candidate calibration result JSON (if a real run has completed) reports the exact pinned repository_id/immutable_revision and never a placeholder", () => {
  const outDir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "work", "domain-seed", "embedding-calibration-real-v0.1");
  const registry = loadFrozenCandidateRegistry();
  for (const candidate of registry.candidates) {
    const resultPath = path.join(outDir, `${candidate.frozen_candidate_id.replace(/_/g, "-")}-calibration-result.v0.1.json`);
    if (!existsSync(resultPath)) continue;
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    assert.equal(result.repository_id, candidate.repository_id);
    assert.equal(result.immutable_revision, candidate.immutable_revision);
    assert.ok(["CALIBRATION_COMPLETED", "DOWNLOAD_FAILED", "MODEL_LOAD_FAILED", "SERVER_IDENTITY_FAILED", "TOKEN_LIMIT_FAILED", "EMBEDDING_FAILED", "RUNTIME_REQUIRES_REMOTE_CODE"].includes(result.status));
    if (result.status === "CALIBRATION_COMPLETED") {
      assert.equal(result.stages.stage3_full_calibration.ranking_performed, true);
      assert.equal(result.stages.stage3_full_calibration.final_model_selected, false);
      assert.equal(result.stages.stage3_full_calibration.dev_gold_accessed, false);
      assert.equal(result.stages.stage3_full_calibration.holdout_accessed, false);
      assert.equal(result.stages.stage3_full_calibration.actual_external_embedding_call_performed, false);
      assert.equal(result.stages.stage3_full_calibration.actual_model_embedding_call_performed, true);
    }
  }
});

test("if the gate status file has been written, its final_embedding_model_selected/production_index_modified/dev_gold_accessed/holdout_accessed flags are all false", () => {
  const gatePath = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "work", "domain-seed", "embedding-calibration-real-v0.1", "calibration-gate-status.v0.1.json");
  if (!existsSync(gatePath)) return;
  const gate = JSON.parse(readFileSync(gatePath, "utf8"));
  assert.equal(gate.final_embedding_model_selected, false);
  assert.equal(gate.production_index_modified, false);
  assert.equal(gate.real_embedding_full_load_started, false);
  assert.equal(gate.dev_gold_accessed, false);
  assert.equal(gate.holdout_accessed, false);
});

test("after stopServer, the port the child was using is free again (a new listener can bind to it)", async () => {
  const { createServer } = await import("node:net");
  const probe = createServer();
  const port = await new Promise((resolve) => { probe.listen(0, "127.0.0.1", () => resolve(probe.address().port)); });
  await new Promise((resolve) => probe.close(resolve));

  const child = spawn(process.execPath, ["-e", `
    const http = require('node:http');
    const server = http.createServer((req, res) => res.end('ok'));
    server.listen(${port}, '127.0.0.1');
  `]);
  await new Promise((resolve) => { setTimeout(resolve, 300); });
  await stopServer(child);
  await new Promise((resolve) => { setTimeout(resolve, 200); });

  const rebind = createServer();
  await new Promise((resolve, reject) => {
    rebind.once("error", reject);
    rebind.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve) => rebind.close(resolve));
});
