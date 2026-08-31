#!/usr/bin/env node
// Turn N4.20.1: marks the N4.20 (v0.1) Gold-300 Owner review UI as
// superseded -- it conflated "the 300-candidate plan is approved" with
// "every row may be written", a single gold_authoring_authorized boolean
// covering both. This script NEVER deletes or overwrites any v0.1 file;
// it writes one new state file (gate-status.v0.2.json) inside the SAME
// v0.1 directory, and first fails closed if a real (not template) v0.1
// Owner decision was ever actually downloaded and exists on disk.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
function writeJson(p, obj) { writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, "utf8"); }

const V02_DIR = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2");
const AUTHORING_V01_DIR = resolve(V02_DIR, "gold-authoring-300-v0.1");
const OWNER_REVIEW_V01_DIR = resolve(AUTHORING_V01_DIR, "owner-review-v0.1");

// A real downloaded decision would be named exactly this (no "-template"
// suffix); the template file (gold-300-authoring-owner-decision-template
// .v0.1.json) is expected to exist and is NOT what this checks for.
const REAL_V01_DECISION_PATH = resolve(OWNER_REVIEW_V01_DIR, "gold-300-authoring-owner-decision.v0.1.json");

export function buildGold300V01UiSupersede({ generatedAt, replacementUiPath } = {}) {
  const now = generatedAt ?? new Date().toISOString();

  if (existsSync(REAL_V01_DECISION_PATH)) {
    const content = readFileSync(REAL_V01_DECISION_PATH, "utf8");
    throw new Error(
      `buildGold300V01UiSupersede: a real v0.1 Owner decision file exists at ${REAL_V01_DECISION_PATH} -- `
      + `refusing to auto-accept or auto-supersede it. STOP and report; do not proceed. `
      + `First 200 chars: ${content.slice(0, 200)}`,
    );
  }

  const gateStatusV02 = {
    schema_version: "0.1.0", turn: "N4.20.1", generated_at: now,
    previous_ui_status: "SUPERSEDED_DO_NOT_USE_FOR_OWNER_DECISION",
    superseded_reason: "PLAN_APPROVAL_AND_ROW_AUTHORING_AUTHORIZATION_WERE_CONFLATED",
    previous_ui_path: "work/handoff/anchor-dev-tune-v0.2/gold-authoring-300-v0.1/owner-review-v0.1/ui/v0.1/gold-300-authoring-owner-review.html",
    replacement_ui_path: replacementUiPath ?? "work/handoff/anchor-dev-tune-v0.2/gold-authoring-300-v0.2/owner-review-v0.2/ui/v0.2/gold-300-authoring-owner-review.html",
    previous_decision_accepted: false,
    real_v01_decision_file_found: false,
    note: "The v0.1 UI, packet, and selection files are left completely unmodified -- this state file only records that the v0.1 UI must not be used for a real Owner decision going forward. Use the replacement_ui_path instead.",
  };
  writeJson(resolve(AUTHORING_V01_DIR, "gate-status.v0.2.json"), gateStatusV02);

  return Object.freeze({ path: resolve(AUTHORING_V01_DIR, "gate-status.v0.2.json"), gateStatusV02 });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = buildGold300V01UiSupersede();
  console.log(JSON.stringify({ status: "V01_UI_MARKED_SUPERSEDED", path: result.path, real_v01_decision_file_found: result.gateStatusV02.real_v01_decision_file_found }, null, 2));
}
