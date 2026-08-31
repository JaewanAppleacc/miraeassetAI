// Turn P10.1: read-only input-pin gate for the DEV_TUNE-101 chunking
// comparison. Validates the pinned dev-tune-gold.v0.1.jsonl +
// dev-tune-release-manifest.v0.1.json (fetched from demo-ai-festival's
// codex/gold-phase1-207-evaluation-v01 branch, DEV_TUNE files only) against
// EVERY condition this Turn's brief requires before any question/answer
// content is used. A failed check throws -- callers MUST NOT proceed to
// read question/answer content past a failed gate.
//
// This module NEVER opens a DEV_CHECK or HOLDOUT path -- it only reads the
// two files this Turn's brief explicitly names.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const EXPECTED_OWNER_DECISION_SHA256 = "00dc07913a3674102fbb341b5bf61c10ad3ea3d6e0bf52206f366157f88a6c8d";
export const EXPECTED_DEV_TUNE_ROW_COUNT = 101;

export class DevTuneGateError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "DevTuneGateError";
    this.code = code ?? "DEV_TUNE_GATE_ERROR";
  }
}

function sha256HexOfBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// Returns { manifest, goldItems, checks } on success, throws DevTuneGateError
// on ANY failed check (fail-closed -- never returns a partial/degraded pass).
export async function validateDevTuneInputGate({ goldJsonlPath, manifestPath }) {
  const checks = [];
  const record = (id, pass, detail) => { checks.push({ id, pass, detail }); return pass; };

  const manifestRaw = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestRaw);
  const goldBuffer = await readFile(goldJsonlPath);
  const goldRaw = goldBuffer.toString("utf8");

  const ownerShaOk = record(
    "owner_decision_sha256_pinned",
    manifest.owner_decision_sha256 === EXPECTED_OWNER_DECISION_SHA256,
    `expected ${EXPECTED_OWNER_DECISION_SHA256}, got ${manifest.owner_decision_sha256}`,
  );

  const scope = manifest.authorized_scope ?? {};
  const devTuneAuthorized = record("dev_tune_agent_use_authorized", scope.dev_tune_agent_use_authorized === true, String(scope.dev_tune_agent_use_authorized));
  const devCheckNotAuthorized = record("dev_check_agent_use_authorized_is_false", scope.dev_check_agent_use_authorized === false, String(scope.dev_check_agent_use_authorized));
  const holdoutNotAuthorized = record("holdout_agent_access_authorized_is_false", scope.holdout_agent_access_authorized === false, String(scope.holdout_agent_access_authorized));

  const goldFileSha256 = sha256HexOfBuffer(goldBuffer);
  const goldFileIntegrityOk = record(
    "dev_tune_gold_sha256_matches_manifest",
    goldFileSha256 === manifest.dev_tune_gold_sha256,
    `computed ${goldFileSha256}, manifest declares ${manifest.dev_tune_gold_sha256}`,
  );

  const lines = goldRaw.split("\n").filter((line) => line.trim() !== "");
  const rowCountOk = record("row_count_exactly_101", lines.length === EXPECTED_DEV_TUNE_ROW_COUNT, `got ${lines.length}`);

  let goldItems = [];
  let parseOk = true;
  try {
    goldItems = lines.map((line) => JSON.parse(line));
  } catch (error) {
    parseOk = false;
    record("all_rows_valid_json", false, error.message);
  }
  if (parseOk) record("all_rows_valid_json", true, "");

  const nonDevTuneRows = parseOk ? goldItems.filter((item) => item.split !== "DEV_TUNE") : [];
  const allDevTuneOk = record("all_rows_split_dev_tune", parseOk && nonDevTuneRows.length === 0, `${nonDevTuneRows.length} row(s) with split != DEV_TUNE`);

  const allPassed = ownerShaOk && devTuneAuthorized && devCheckNotAuthorized && holdoutNotAuthorized && goldFileIntegrityOk && rowCountOk && parseOk && allDevTuneOk;

  if (!allPassed) {
    const failed = checks.filter((c) => !c.pass);
    throw new DevTuneGateError(`DEV_TUNE input gate FAILED (fail-closed, refusing to proceed): ${JSON.stringify(failed)}`, "INPUT_GATE_FAILED");
  }

  return { manifest, goldItems, checks };
}

export function buildInputPinManifest({ manifest, goldItems, checks, goldJsonlPath, manifestPath }) {
  return Object.freeze({
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    source_branch: "demo-ai-festival/codex/gold-phase1-207-evaluation-v01",
    dev_tune_gold_path: goldJsonlPath,
    dev_tune_manifest_path: manifestPath,
    owner_decision_id: manifest.owner_decision_id,
    owner_decision_sha256: manifest.owner_decision_sha256,
    dev_tune_gold_sha256: manifest.dev_tune_gold_sha256,
    row_count: goldItems.length,
    all_checks: checks,
    gate_status: "GREEN",
    authorized_scope: manifest.authorized_scope,
  });
}
