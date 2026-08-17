import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PATHS = Object.freeze({
  structuredManifest: "work/domain-seed/seed-structured-artifacts.v0.2.manifest.json",
  plan: "work/domain-seed/seed-thin-flow-plans.v0.2.jsonl",
  planManifest: "work/domain-seed/seed-thin-flow-plans.v0.2.manifest.json",
  harnessResults: "work/domain-seed/seed-thin-flow-harness-v02.v0.8.jsonl",
  harnessSummary: "work/domain-seed/seed-thin-flow-harness-v02.v0.8.summary.json",
  reportJson: "work/domain-seed/seed-runtime-v02-release-audit.json",
  reportMarkdown: "work/domain-seed/seed-runtime-v02-release-audit.md",
});
const EXPECTED_EARLY_EXIT = new Set(["question_seed_v07_03", "question_seed_v07_22"]);
const NON_RUNTIME_UNTRACKED = new Set([
  "domain/interfaces/parse-recovery-overlay.schema.json",
  "domain/releases/seed-release.v0.12.draft.manifest.json",
  "domain/releases/seed-release.v0.13.draft.manifest.json",
  "domain/recovery/",
  "scripts/build-parse-recovery-overlay.mjs",
  "scripts/build-seed-review-bundle.mjs",
  "scripts/select-seed-gold-candidates.mjs",
  "scripts/validate-parse-recovery-overlay.mjs",
  "tests/parse-recovery-overlay.test.mjs",
]);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const parseJsonl = (text) => text.split(/\r?\n/).filter(Boolean).map(JSON.parse);

export function evaluateSeedRuntimeV02Release({
  structuredManifest,
  planManifest,
  planText,
  harnessSummary,
  harnessResults,
  currentCommit,
  sourceTreeClean,
}) {
  const wiringBlockers = [];
  const qualityBlockers = [];
  if (structuredManifest.artifact_set_id !== "seed-structured-artifacts-v0.2") wiringBlockers.push("STRUCTURED_ARTIFACT_SET_MISMATCH");
  if (structuredManifest.fact_coverage_snapshot_id !== planManifest.fact_coverage_snapshot_id) wiringBlockers.push("PLAN_COVERAGE_SNAPSHOT_MISMATCH");
  if (structuredManifest.corpus_snapshot_id !== planManifest.corpus_snapshot_id) wiringBlockers.push("PLAN_CORPUS_SNAPSHOT_MISMATCH");
  if (sha256(planText) !== planManifest.artifact_sha256) wiringBlockers.push("PLAN_HASH_MISMATCH");
  if (parseJsonl(planText).length !== planManifest.record_count || planManifest.record_count !== 23) wiringBlockers.push("PLAN_COUNT_MISMATCH");
  for (const forbidden of planManifest.forbidden_runtime_fields ?? []) {
    if (planText.includes(forbidden)) wiringBlockers.push(`PLAN_FORBIDDEN_FIELD:${forbidden}`);
  }
  if (harnessSummary.git_commit !== currentCommit) wiringBlockers.push("HARNESS_GIT_COMMIT_MISMATCH");
  if (!sourceTreeClean) wiringBlockers.push("SOURCE_TREE_NOT_CLEAN");
  for (const [field, expected] of Object.entries({
    total: 25,
    api_success: 25,
    contract_success: 25,
    response_usable: 25,
    metric_eligible: 23,
    metric_excluded: 2,
    timeouts: 0,
    http_errors: 0,
    contract_errors: 0,
    reservation_failures: 0,
    question_echo_mismatches: 0,
  })) if (harnessSummary[field] !== expected) wiringBlockers.push(`HARNESS_${field.toUpperCase()}_MISMATCH`);
  if (harnessResults.length !== 25) wiringBlockers.push("HARNESS_RESULT_COUNT_MISMATCH");
  const resultIds = new Set();
  for (const result of harnessResults) {
    if (resultIds.has(result.question_id)) wiringBlockers.push(`HARNESS_DUPLICATE_QUESTION:${result.question_id}`);
    resultIds.add(result.question_id);
    const expectedMode = EXPECTED_EARLY_EXIT.has(result.question_id) ? "EARLY_EXIT" : "STRUCTURED";
    if (result.execution_mode_actual !== expectedMode) wiringBlockers.push(`HARNESS_MODE_MISMATCH:${result.question_id}`);
    if (!result.response_usable) wiringBlockers.push(`HARNESS_RESPONSE_UNUSABLE:${result.question_id}`);
  }
  if ([...EXPECTED_EARLY_EXIT].some((id) => !resultIds.has(id))) wiringBlockers.push("EXPECTED_EARLY_EXIT_MISSING");
  if (harnessSummary.metric_fail > 0) qualityBlockers.push(`METRIC_FAIL:${harnessSummary.metric_fail}`);
  if (harnessSummary.not_scored > 0) qualityBlockers.push(`NOT_SCORED:${harnessSummary.not_scored}`);
  if (harnessSummary.review_required > 0) qualityBlockers.push(`REVIEW_REQUIRED:${harnessSummary.review_required}`);
  return Object.freeze({
    schema_version: "0.1.0",
    runtime_wiring_gate: wiringBlockers.length ? "BLOCKED" : "PASS",
    answer_quality_gate: qualityBlockers.length ? "BLOCKED" : "PASS",
    release_gate: wiringBlockers.length || qualityBlockers.length ? "BLOCKED" : "PASS",
    wiring_blockers: Object.freeze(wiringBlockers),
    quality_blockers: Object.freeze(qualityBlockers),
    evidence: Object.freeze({
      artifact_set_id: structuredManifest.artifact_set_id,
      corpus_snapshot_id: structuredManifest.corpus_snapshot_id,
      fact_coverage_snapshot_id: structuredManifest.fact_coverage_snapshot_id,
      plan_sha256: sha256(planText),
      harness_run_id: harnessSummary.run_id,
      harness_git_commit: harnessSummary.git_commit,
      current_git_commit: currentCommit,
      source_tree_clean: sourceTreeClean,
    }),
  });
}

function gitState(root) {
  const currentCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  // Only tracked/untracked implementation files matter here. Ignored work/
  // artifacts are separately hash-pinned by their manifests.
  const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
  const relevant = status.split(/\r?\n/).filter(Boolean).filter((line) => {
    const file = line.slice(3).split(" -> ").at(-1);
    return ![...NON_RUNTIME_UNTRACKED].some((entry) => entry.endsWith("/") ? file.startsWith(entry) : file === entry);
  });
  return { currentCommit, sourceTreeClean: relevant.length === 0 };
}

export async function auditSeedRuntimeV02Release({ root = rootDefault, paths = PATHS, writeOutputs = true, git = null } = {}) {
  const resolved = Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, path.resolve(root, value)]));
  const [structuredManifestText, planText, planManifestText, harnessResultsText, harnessSummaryText] = await Promise.all([
    readFile(resolved.structuredManifest, "utf8"), readFile(resolved.plan, "utf8"), readFile(resolved.planManifest, "utf8"),
    readFile(resolved.harnessResults, "utf8"), readFile(resolved.harnessSummary, "utf8"),
  ]);
  const state = git ?? gitState(root);
  const report = evaluateSeedRuntimeV02Release({
    structuredManifest: JSON.parse(structuredManifestText), planManifest: JSON.parse(planManifestText), planText,
    harnessSummary: JSON.parse(harnessSummaryText), harnessResults: parseJsonl(harnessResultsText), ...state,
  });
  const markdown = `# Seed Runtime v0.2 release audit\n\n- Runtime wiring gate: **${report.runtime_wiring_gate}**\n- Answer quality gate: **${report.answer_quality_gate}**\n- Overall release gate: **${report.release_gate}**\n\n## Wiring blockers\n${report.wiring_blockers.length ? report.wiring_blockers.map((item) => `- ${item}`).join("\n") : "- None"}\n\n## Quality blockers\n${report.quality_blockers.length ? report.quality_blockers.map((item) => `- ${item}`).join("\n") : "- None"}\n\nA passing wiring gate proves pinned artifacts and API execution only. It does not override the answer-quality gate.\n`;
  if (writeOutputs) {
    await mkdir(path.dirname(resolved.reportJson), { recursive: true });
    await Promise.all([writeFile(resolved.reportJson, `${JSON.stringify(report, null, 2)}\n`), writeFile(resolved.reportMarkdown, markdown)]);
  }
  return Object.freeze({ report, markdown });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { report } = await auditSeedRuntimeV02Release();
  console.log(JSON.stringify(report, null, 2));
  if (report.release_gate !== "PASS") process.exitCode = 2;
}
