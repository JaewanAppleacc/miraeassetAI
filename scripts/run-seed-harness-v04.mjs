// Runs the real Evaluation Harness (domain/evaluation-harness/harness-runner.mjs)
// against the v0.4-promoted Seed Gold (v0.17) over a REAL running HTTP
// server. This is a SANDBOX_EXPLORATION run (CLAUDE.md: "Seed는 배선·API·
// 계약 검사에만 사용하고 전략 선택에 사용하지 않는다") -- explicitly NOT a
// FLOW_SELECTION/DEV_TUNE milestone execution, so it never touches any
// shared/official usage ledger: lifecycle_path/ledger_path both point at
// freshly-built, throwaway files scoped to this one run, never a real
// evaluation-lifecycle artifact.
import { createHash, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runHarness } from "../domain/evaluation-harness/harness-runner.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN_AT = new Date().toISOString();
const BASE_URL = process.env.SEED_HARNESS_BASE_URL ?? "http://127.0.0.1:8738";

const GOLD_PATH = path.join(REPO, "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl");
const LIFECYCLE_PATH = path.join(REPO, "work/domain-seed/seed-harness-v04-lifecycle.sandbox-only.json");
const LEDGER_PATH = path.join(REPO, "work/domain-seed/seed-harness-v04-usage-ledger.sandbox-only.jsonl");
const RESULT_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-harness-v04.v0.1.jsonl");
const SUMMARY_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-harness-v04.v0.1.summary.json");

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function main() {
  const gold = (await readFile(GOLD_PATH, "utf8")).trim().split("\n").map(JSON.parse);

  // Fresh, throwaway PROVISIONAL split-lifecycle covering exactly these 25
  // Seed question_ids -- makes them SANDBOX-eligible without claiming any
  // real DEV_TUNE/DEV_CHECK/HOLDOUT assignment or lock state.
  const lifecycle = gold.map((g) => ({
    schema_version: "0.1.0",
    assignment_id: g.question_id,
    assigned_split: "DEV_TUNE",
    split_lock_status: "PROVISIONAL_UNTIL_CHAIN_CLOSURE",
    holdout_lifecycle_status: "SEALED",
    updated_at: RUN_AT,
  }));
  await writeFile(LIFECYCLE_PATH, JSON.stringify(lifecycle, null, 2) + "\n", "utf8");
  await writeFile(LEDGER_PATH, "", "utf8"); // empty durable ledger, this run's own throwaway file

  const gitCommit = execSync("git rev-parse HEAD", { cwd: REPO }).toString().trim();

  const config = {
    base_url: BASE_URL,
    answer_path: "/answer",
    question_parameter: "question",
    question_id_parameter: "question_id",
    gold_path: GOLD_PATH,
    result_path: RESULT_PATH,
    summary_path: SUMMARY_PATH,
    lifecycle_path: LIFECYCLE_PATH,
    ledger_path: LEDGER_PATH,
    split: "SANDBOX",
    run_purpose: "SANDBOX_EXPLORATION",
    timeout_ms: 30_000,
    concurrency: 4,
    retries: 2,
    git_commit: gitCommit,
    run_id: `seed-harness-v04-sandbox-${randomUUID()}`,
  };
  config.configuration_sha256 = sha256(JSON.stringify({ ...config, configuration_sha256: undefined }));

  const { summary } = await runHarness(config);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
