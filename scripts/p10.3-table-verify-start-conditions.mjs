#!/usr/bin/env node
// Turn P10.3-TABLE: fail-closed verification of this Turn's START CONDITIONS
// (base = P10.2's final push SHA; P10.2 6/6 combinations complete; DEV_TUNE
// gold pin matches; P10.1/P10.1.1/P10.2 result SHAs recorded as input pins).
//
// This script performs NO table classification, NO chunk/locator analysis,
// and NO retrieval re-scoring -- it only verifies that this Turn is allowed
// to START. It must be run and pass (gate_status: "GREEN") BEFORE any
// Stage 1-5 diagnostic code runs. On any failed check it throws and writes
// nothing but a FAILED status -- never a partial/degraded pass.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { validateDevTuneInputGate, buildInputPinManifest } from "../domain/agent-comparison/chunking-comparison/dev-tune-input-gate.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "work", "p10.3-table-diagnostic");
const GOLD_JSONL_PATH = path.join(ROOT, "domain/evaluation/releases/gold-phase1-207-v0.1/dev-tune-gold.v0.1.jsonl");
const MANIFEST_PATH = path.join(ROOT, "domain/evaluation/releases/gold-phase1-207-v0.1/dev-tune-release-manifest.v0.1.json");

// Recorded input pins for this Turn (final commit SHA of each prior Turn,
// all verified below to be real ancestors of this worktree's HEAD -- never
// trusted as bare strings).
const INPUT_PINS = Object.freeze({
  p10_1_final_sha: "35fd52e", // feat: select chunking strategy with authorized DEV_TUNE
  p10_1_1_final_sha: "7288055", // fix: evaluate hierarchical chunking with parent-aware retrieval (HIERARCHICAL_ELIMINATED_AFTER_PARENT_AWARE_RETEST)
  p10_2_final_push_sha: "14adb49", // fix: correct P10.2 interaction verdict -- tie artifact is not a material interaction (this Turn's base)
});

class StartConditionError extends Error {
  constructor(message) {
    super(message);
    this.name = "StartConditionError";
  }
}

function gitIsAncestor(sha) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function gitHeadSha() {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
}

async function main() {
  const checks = [];
  const record = (id, pass, detail) => { checks.push({ id, pass, detail }); return pass; };

  const headSha = gitHeadSha();
  record("worktree_head_resolved", typeof headSha === "string" && headSha.length === 40, headSha);

  for (const [key, sha] of Object.entries(INPUT_PINS)) {
    record(`${key}_is_ancestor_of_head`, gitIsAncestor(sha), `${sha} -> HEAD ${headSha}`);
  }
  record(
    "base_is_p10_2_final_push_sha",
    headSha.startsWith(INPUT_PINS.p10_2_final_push_sha) || gitIsAncestor(INPUT_PINS.p10_2_final_push_sha),
    `expected base ${INPUT_PINS.p10_2_final_push_sha}`,
  );

  // --- P10.2 6/6 combination completeness (this Turn must not start on a
  // partial or fail-closed P10.2 result) ---
  let stage2 = null;
  let stage2ReadOk = true;
  try {
    stage2 = JSON.parse(await readFile(path.join(ROOT, "work/p10.2-chunking-embedding-grid/stage2-grid-results.v0.1.json"), "utf8"));
  } catch (error) {
    stage2ReadOk = false;
    record("p10_2_stage2_results_readable", false, error.message);
  }
  if (stage2ReadOk) record("p10_2_stage2_results_readable", true, "");
  const combosComplete = stage2ReadOk && stage2.combinations_completed === 6 && Array.isArray(stage2.combinations) && stage2.combinations.length === 6;
  record("p10_2_six_combinations_complete", combosComplete, stage2ReadOk ? `combinations_completed=${stage2.combinations_completed}` : "unreadable");

  let finalSelection = null;
  let selectionReadOk = true;
  try {
    finalSelection = JSON.parse(await readFile(path.join(ROOT, "work/p10.2-chunking-embedding-grid/final-selection.v0.1.json"), "utf8"));
  } catch (error) {
    selectionReadOk = false;
    record("p10_2_final_selection_readable", false, error.message);
  }
  if (selectionReadOk) record("p10_2_final_selection_readable", true, "");
  const selectionResolved = selectionReadOk && finalSelection.status === "FINAL_CHUNKING_AND_EMBEDDING_SELECTED";
  record("p10_2_selection_status_resolved", selectionResolved, selectionReadOk ? finalSelection.status : "unreadable");

  // Hierarchical must remain excluded: P10.2's 6 combinations must be
  // exactly {kure_v1,bge_m3,pixie_rune} x {fixed,section-flat}, never a
  // hierarchical chunking_config_id, and this script must never read a
  // hierarchical-named result path.
  const hierarchicalAbsent = stage2ReadOk && stage2.combinations.every((c) => !/hierarchical/i.test(c.chunking_config_id));
  record("hierarchical_absent_from_p10_2_combinations", hierarchicalAbsent, "");

  // --- DEV_TUNE gold input gate (reused unmodified from Turn P10.1) ---
  let gateResult = null;
  let gateOk = true;
  try {
    gateResult = await validateDevTuneInputGate({ goldJsonlPath: GOLD_JSONL_PATH, manifestPath: MANIFEST_PATH });
  } catch (error) {
    gateOk = false;
    record("dev_tune_input_gate", false, error.message);
  }
  if (gateOk) record("dev_tune_input_gate", true, "");

  const allPassed = checks.every((c) => c.pass);

  await mkdir(OUT_DIR, { recursive: true });

  if (!allPassed) {
    const failReport = {
      schema_version: "0.1.0",
      generated_at: new Date().toISOString(),
      gate_status: "FAILED_FAIL_CLOSED",
      checks,
    };
    await writeFile(path.join(OUT_DIR, "start-condition-verification.v0.1.json"), `${JSON.stringify(failReport, null, 2)}\n`);
    throw new StartConditionError(`P10.3-TABLE start conditions FAILED (fail-closed, refusing to proceed to Stage 1): ${JSON.stringify(checks.filter((c) => !c.pass))}`);
  }

  const pinManifest = buildInputPinManifest({
    manifest: gateResult.manifest,
    goldItems: gateResult.goldItems,
    checks: gateResult.checks,
    goldJsonlPath: "domain/evaluation/releases/gold-phase1-207-v0.1/dev-tune-gold.v0.1.jsonl",
    manifestPath: "domain/evaluation/releases/gold-phase1-207-v0.1/dev-tune-release-manifest.v0.1.json",
  });

  const startConditionReport = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    gate_status: "GREEN",
    worktree_head_sha: headSha,
    input_pins: INPUT_PINS,
    p10_2_combinations_completed: stage2.combinations_completed,
    p10_2_final_selection_status: finalSelection.status,
    p10_2_final_chunking_strategy: finalSelection.final_chunking_strategy,
    p10_2_final_embedding_repository: finalSelection.final_embedding_repository,
    p10_2_table_diagnostic_status: finalSelection.table_diagnostic_status,
    dev_tune_gold_sha256_pinned: pinManifest.dev_tune_gold_sha256,
    dev_tune_gold_row_count: pinManifest.row_count,
    checks,
  };
  await writeFile(path.join(OUT_DIR, "start-condition-verification.v0.1.json"), `${JSON.stringify(startConditionReport, null, 2)}\n`);
  await writeFile(path.join(OUT_DIR, "input-pin-manifest.v0.1.json"), `${JSON.stringify(pinManifest, null, 2)}\n`);

  console.log(JSON.stringify({ gate_status: "GREEN", input_pins: INPUT_PINS, p10_2_combinations_completed: stage2.combinations_completed }, null, 2));
}

main().catch((error) => {
  console.error("[p10.3-table-verify-start-conditions] FAILED:", error.message);
  process.exitCode = 1;
});
