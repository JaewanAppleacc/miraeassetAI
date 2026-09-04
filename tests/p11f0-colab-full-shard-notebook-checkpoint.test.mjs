// Turn AC-COLAB-FULL-SHARDS-V1, remaining item 4: scoped tests for the
// checkpoint/resume logic in
// domain/agent-comparison/four-arm-ac/gpu-full-shard-colab-cuda-runner-v1.ipynb
// (Cell 2's sha256/NPY helpers and Cell 4's block_ranges/block_paths/
// block_is_valid resume-scan logic). This Turn never executes the
// notebook itself (no Colab/GPU access) -- these tests instead extract
// the REAL cell source text from the .ipynb at test time and run it in a
// python3 subprocess against small synthetic (4-dim, non-corpus) vectors,
// so the suite exercises the actual notebook code rather than a
// reimplementation that could silently drift from it.
//
// Requires python3 + numpy locally (both already used elsewhere in this
// repo's benchmark tooling docs). If python3 is unavailable, the suite
// reports that explicitly rather than silently skipping.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const NOTEBOOK_PATH = new URL("../domain/agent-comparison/four-arm-ac/gpu-full-shard-colab-cuda-runner-v1.ipynb", import.meta.url);

async function extractCellSource(cellIndex, expectedFirstWords) {
  const notebook = JSON.parse(await readFile(NOTEBOOK_PATH, "utf8"));
  const cell = notebook.cells[cellIndex];
  const source = cell.source.join("");
  if (!source.trimStart().startsWith(expectedFirstWords)) {
    throw new Error(`notebook cell ${cellIndex} no longer starts with ${JSON.stringify(expectedFirstWords)} -- update this test's cell index/marker if the notebook was restructured`);
  }
  return source;
}

const PY_PRELUDE = `
import json, os, hashlib, struct, sys
import numpy as np

DIMENSION = 4
MODEL_REVISION = "test-revision-fixture"
SHARD_ID = 0
BLOCK_SIZE = 5

ns = {"np": np, "os": os, "json": json, "hashlib": hashlib, "struct": struct}
exec(CELL2_SOURCE, ns)
exec(CELL4_SOURCE, {
  **ns, "DIMENSION": DIMENSION, "MODEL_REVISION": MODEL_REVISION,
  "rows": [], "BLOCK_SIZE": BLOCK_SIZE, "SHARD_OUT_DIR": "/nonexistent-unused-in-first-pass",
})

def make_rows(n):
    return [
        {"global_eligible_index": i, "embedding_input_id": f"embin_{i:04d}", "embed_text_sha256": hashlib.sha256(f"text-{i}".encode()).hexdigest(), "text": f"synthetic text {i}"}
        for i in range(n)
    ]

def make_unit_vector(dim):
    v = np.ones(dim, dtype=np.float32)
    return (v / np.linalg.norm(v)).astype(np.float32)

def run_block_plan_ns(rows, block_size, shard_out_dir, model_revision=MODEL_REVISION, dimension=DIMENSION):
    call_ns = {
      **ns, "DIMENSION": dimension, "MODEL_REVISION": model_revision,
      "rows": rows, "BLOCK_SIZE": block_size, "SHARD_OUT_DIR": shard_out_dir,
      "os": os, "json": json, "np": np,
    }
    exec(CELL4_SOURCE, call_ns)
    return call_ns

def write_valid_block(call_ns, block_idx, local_start, local_end, model_revision=MODEL_REVISION, dimension=DIMENSION):
    rows = call_ns["rows"]
    block_rows = rows[local_start:local_end]
    paths = call_ns["block_paths"](block_idx)
    n = len(block_rows)
    arr = np.stack([make_unit_vector(dimension) for _ in range(n)]).astype(np.float32)
    call_ns["write_npy_float32_matrix"](paths["vectors"], arr)
    with open(paths["mapping"], "w") as f:
        for r in block_rows:
            f.write(json.dumps({"global_eligible_index": r["global_eligible_index"], "embedding_input_id": r["embedding_input_id"], "embed_text_sha256": r["embed_text_sha256"]}) + "\\n")
    manifest = {
        "schema_version": "p11f0-colab-full-shard-block-manifest.v1",
        "shard_id": SHARD_ID, "block_idx": block_idx,
        "global_start_index": block_rows[0]["global_eligible_index"],
        "global_end_index": block_rows[-1]["global_eligible_index"],
        "row_count": n,
        "model": {"repository": "nlpai-lab/KURE-v1", "revision": model_revision},
        "dimension": dimension, "dtype": "float32",
        "batch_size": 8, "elapsed_ms": 1.0, "device": "cpu-test", "runtime_versions": {},
        "vectors_sha256": call_ns["sha256_file"](paths["vectors"]),
        "mapping_sha256": call_ns["sha256_file"](paths["mapping"]),
        "generated_at": "2026-01-01T00:00:00Z",
    }
    with open(paths["manifest"], "w") as f:
        json.dump(manifest, f)
    tmp_marker = paths["marker"] + ".partial"
    with open(tmp_marker, "w") as f:
        f.write("complete\\n")
    os.replace(tmp_marker, paths["marker"])
    return paths, manifest

results = {}
failures = []

def scenario(name, fn):
    try:
        fn()
        results[name] = "OK"
        print(f"SCENARIO_OK:{name}")
    except AssertionError as e:
        failures.append(name)
        print(f"SCENARIO_FAIL:{name}: {e}")
`;

const PY_SCENARIOS = `
def s_fresh_dir_all_pending():
    d = os.path.join(WORKDIR, "s1")
    os.makedirs(d, exist_ok=True)
    rows = make_rows(23)
    call_ns = run_block_plan_ns(rows, 5, d)
    assert call_ns["blocks"] == [(0, 5), (5, 10), (10, 15), (15, 20), (20, 23)], call_ns["blocks"]
    assert call_ns["blocks_to_run"] == [0, 1, 2, 3, 4], call_ns["blocks_to_run"]
    assert all(r["reason"] == "NO_COMPLETION_MARKER" for r in call_ns["resume_report"]), call_ns["resume_report"]
    # full coverage, no gap/overlap: every original row index appears in exactly one block
    covered = []
    for (a, b) in call_ns["blocks"]:
        covered.extend(range(a, b))
    assert covered == list(range(23)), covered
scenario("fresh_dir_all_pending", s_fresh_dir_all_pending)

def s_valid_block_reused():
    d = os.path.join(WORKDIR, "s2")
    os.makedirs(d, exist_ok=True)
    rows = make_rows(10)
    call_ns = run_block_plan_ns(rows, 5, d)
    write_valid_block(call_ns, 0, 0, 5)
    call_ns2 = run_block_plan_ns(rows, 5, d)
    assert call_ns2["resume_report"][0]["valid_reused"] is True, call_ns2["resume_report"]
    assert call_ns2["resume_report"][0]["reason"] == "OK", call_ns2["resume_report"]
    assert 0 not in call_ns2["blocks_to_run"], call_ns2["blocks_to_run"]
    assert 1 in call_ns2["blocks_to_run"], call_ns2["blocks_to_run"]
scenario("valid_block_reused", s_valid_block_reused)

def s_missing_marker_forces_rerun():
    d = os.path.join(WORKDIR, "s3")
    os.makedirs(d, exist_ok=True)
    rows = make_rows(10)
    call_ns = run_block_plan_ns(rows, 5, d)
    paths, _ = write_valid_block(call_ns, 0, 0, 5)
    os.remove(paths["marker"])
    call_ns2 = run_block_plan_ns(rows, 5, d)
    assert call_ns2["resume_report"][0]["reason"] == "NO_COMPLETION_MARKER", call_ns2["resume_report"]
    assert 0 in call_ns2["blocks_to_run"]
scenario("missing_marker_forces_rerun", s_missing_marker_forces_rerun)

def s_tampered_vectors_sha_forces_rerun():
    d = os.path.join(WORKDIR, "s4")
    os.makedirs(d, exist_ok=True)
    rows = make_rows(10)
    call_ns = run_block_plan_ns(rows, 5, d)
    paths, _ = write_valid_block(call_ns, 0, 0, 5)
    with open(paths["vectors"], "r+b") as f:
        f.seek(-1, os.SEEK_END)
        b = f.read(1)
        f.seek(-1, os.SEEK_END)
        f.write(bytes([b[0] ^ 0xFF]))
    call_ns2 = run_block_plan_ns(rows, 5, d)
    assert call_ns2["resume_report"][0]["reason"] == "VECTORS_SHA_MISMATCH", call_ns2["resume_report"]
    assert 0 in call_ns2["blocks_to_run"]
scenario("tampered_vectors_sha_forces_rerun", s_tampered_vectors_sha_forces_rerun)

def s_row_count_mismatch_forces_rerun():
    d = os.path.join(WORKDIR, "s5")
    os.makedirs(d, exist_ok=True)
    rows = make_rows(10)
    call_ns = run_block_plan_ns(rows, 5, d)
    paths, manifest = write_valid_block(call_ns, 0, 0, 5)
    manifest["row_count"] = 999
    with open(paths["manifest"], "w") as f:
        json.dump(manifest, f)
    call_ns2 = run_block_plan_ns(rows, 5, d)
    assert call_ns2["resume_report"][0]["reason"] == "ROW_COUNT_MISMATCH", call_ns2["resume_report"]
scenario("row_count_mismatch_forces_rerun", s_row_count_mismatch_forces_rerun)

def s_model_revision_mismatch_forces_rerun():
    d = os.path.join(WORKDIR, "s6")
    os.makedirs(d, exist_ok=True)
    rows = make_rows(10)
    call_ns = run_block_plan_ns(rows, 5, d)
    write_valid_block(call_ns, 0, 0, 5, model_revision="a-different-revision")
    call_ns2 = run_block_plan_ns(rows, 5, d)
    assert call_ns2["resume_report"][0]["reason"] == "MODEL_REVISION_MISMATCH", call_ns2["resume_report"]
scenario("model_revision_mismatch_forces_rerun", s_model_revision_mismatch_forces_rerun)

def s_non_finite_forces_rerun():
    d = os.path.join(WORKDIR, "s7")
    os.makedirs(d, exist_ok=True)
    rows = make_rows(10)
    call_ns = run_block_plan_ns(rows, 5, d)
    paths, manifest = write_valid_block(call_ns, 0, 0, 5)
    arr = call_ns["read_npy_float32_matrix"](paths["vectors"]).copy()
    arr[0][0] = np.float32("nan")
    call_ns["write_npy_float32_matrix"](paths["vectors"], arr)
    manifest["vectors_sha256"] = call_ns["sha256_file"](paths["vectors"])
    with open(paths["manifest"], "w") as f:
        json.dump(manifest, f)
    call_ns2 = run_block_plan_ns(rows, 5, d)
    assert call_ns2["resume_report"][0]["reason"] == "NON_FINITE_VALUES", call_ns2["resume_report"]
scenario("non_finite_forces_rerun", s_non_finite_forces_rerun)

def s_denormalized_forces_rerun():
    d = os.path.join(WORKDIR, "s8")
    os.makedirs(d, exist_ok=True)
    rows = make_rows(10)
    call_ns = run_block_plan_ns(rows, 5, d)
    paths, manifest = write_valid_block(call_ns, 0, 0, 5)
    arr = call_ns["read_npy_float32_matrix"](paths["vectors"]).copy()
    arr[0] = arr[0] * 5.0
    call_ns["write_npy_float32_matrix"](paths["vectors"], arr)
    manifest["vectors_sha256"] = call_ns["sha256_file"](paths["vectors"])
    with open(paths["manifest"], "w") as f:
        json.dump(manifest, f)
    call_ns2 = run_block_plan_ns(rows, 5, d)
    assert call_ns2["resume_report"][0]["reason"] == "NORMALIZATION_MISMATCH", call_ns2["resume_report"]
scenario("denormalized_forces_rerun", s_denormalized_forces_rerun)

def s_global_range_mismatch_forces_rerun():
    d = os.path.join(WORKDIR, "s9")
    os.makedirs(d, exist_ok=True)
    rows = make_rows(10)
    call_ns = run_block_plan_ns(rows, 5, d)
    paths, manifest = write_valid_block(call_ns, 0, 0, 5)
    manifest["global_start_index"] = 42
    with open(paths["manifest"], "w") as f:
        json.dump(manifest, f)
    call_ns2 = run_block_plan_ns(rows, 5, d)
    assert call_ns2["resume_report"][0]["reason"] == "GLOBAL_RANGE_MISMATCH", call_ns2["resume_report"]
scenario("global_range_mismatch_forces_rerun", s_global_range_mismatch_forces_rerun)

def s_uneven_total_still_covers_exactly():
    d = os.path.join(WORKDIR, "s10")
    os.makedirs(d, exist_ok=True)
    rows = make_rows(17)
    call_ns = run_block_plan_ns(rows, 5, d)
    covered = []
    for (a, b) in call_ns["blocks"]:
        covered.extend(range(a, b))
    assert covered == list(range(17)), covered
    assert call_ns["blocks"][-1] == (15, 17), call_ns["blocks"]
scenario("uneven_total_still_covers_exactly", s_uneven_total_still_covers_exactly)

if failures:
    print("SOME_SCENARIOS_FAILED:" + ",".join(failures))
    sys.exit(1)
else:
    print("ALL_SCENARIOS_PASSED")
`;

let stdout = "";
let harnessError = null;
let workDir;

test.before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "p11f0-notebook-checkpoint-"));
  const cell2Source = await extractCellSource(2, '"""Cell 2');
  const cell4Source = await extractCellSource(4, '"""Cell 4');
  const script = [
    `CELL2_SOURCE = ${JSON.stringify(cell2Source)}`,
    `CELL4_SOURCE = ${JSON.stringify(cell4Source)}`,
    `WORKDIR = ${JSON.stringify(workDir)}`,
    PY_PRELUDE,
    PY_SCENARIOS,
  ].join("\n\n");
  const scriptPath = path.join(workDir, "run_scenarios.py");
  await (await import("node:fs/promises")).writeFile(scriptPath, script, "utf8");
  try {
    const result = await execFileAsync("python3", [scriptPath], { timeout: 60_000 });
    stdout = result.stdout;
  } catch (error) {
    harnessError = error;
    stdout = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
  }
});

test.after(async () => { await rm(workDir, { recursive: true, force: true }); });

function assertScenarioOk(name) {
  if (harnessError && !stdout.includes(`SCENARIO_OK:${name}`) && !stdout.includes(`SCENARIO_FAIL:${name}`)) {
    assert.fail(`python3 harness did not run to completion before scenario ${name} -- stderr:\n${stdout}`);
  }
  assert.ok(stdout.includes(`SCENARIO_OK:${name}`), `expected SCENARIO_OK:${name} in python harness output, got:\n${stdout}`);
}

test("block_ranges: fresh output directory -- every block pending, exact coverage, deterministic partition", () => assertScenarioOk("fresh_dir_all_pending"));
test("block_is_valid: a correctly written, untampered block is reused (valid_reused=true, reason=OK)", () => assertScenarioOk("valid_block_reused"));
test("block_is_valid: missing completion marker alone forces a re-run even if vectors/mapping/manifest are intact", () => assertScenarioOk("missing_marker_forces_rerun"));
test("block_is_valid: a single tampered byte in vectors.npy is caught via VECTORS_SHA_MISMATCH", () => assertScenarioOk("tampered_vectors_sha_forces_rerun"));
test("block_is_valid: a manifest row_count that disagrees with the expected block size is caught", () => assertScenarioOk("row_count_mismatch_forces_rerun"));
test("block_is_valid: a block written under a different model revision is never silently reused", () => assertScenarioOk("model_revision_mismatch_forces_rerun"));
test("block_is_valid: NaN in a vector component is caught even when the file's own recorded sha256 matches its (corrupted) bytes", () => assertScenarioOk("non_finite_forces_rerun"));
test("block_is_valid: a non-unit-L2-norm vector is caught even when the file's own recorded sha256 matches its bytes", () => assertScenarioOk("denormalized_forces_rerun"));
test("block_is_valid: a tampered global_start_index in the block manifest is caught", () => assertScenarioOk("global_range_mismatch_forces_rerun"));
test("block_ranges: a total not evenly divisible by block_size still covers every row exactly once, last block short", () => assertScenarioOk("uneven_total_still_covers_exactly"));

test("python harness completed with exit code 0 (all scenarios passed, none silently skipped)", () => {
  if (harnessError) assert.fail(`python3 harness failed (see stdout/stderr):\n${stdout}\n${harnessError.message}`);
  assert.ok(stdout.includes("ALL_SCENARIOS_PASSED"), stdout);
});
