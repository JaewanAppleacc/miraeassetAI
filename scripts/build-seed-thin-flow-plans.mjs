import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULTS = Object.freeze({
  gold: "work/domain-seed/seed-gold-promotion-candidates.v0.13.jsonl",
  coverage: "work/domain-seed/seed-fact-coverage-verified.v0.1.json",
  plans: "work/domain-seed/seed-thin-flow-plans.v0.1.jsonl",
  manifest: "work/domain-seed/seed-thin-flow-plans.v0.1.manifest.json",
});
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const parseJsonl = (text) => text.split(/\r?\n/).filter(Boolean).map(JSON.parse);

export async function buildSeedThinFlowPlans({
  root = rootDefault,
  paths = DEFAULTS,
  writeOutputs = true,
  expectedPlanCount = 23,
  excludedQuestionIds = ["question_seed_v07_03", "question_seed_v07_22"],
} = {}) {
  const resolve = (value) => path.resolve(root, value);
  const [goldText, coverageText] = await Promise.all([readFile(resolve(paths.gold), "utf8"), readFile(resolve(paths.coverage), "utf8")]);
  const gold = parseJsonl(goldText);
  const coverage = JSON.parse(coverageText);
  const slotsByQuestion = new Map();
  for (const slot of coverage.slots) {
    if (slot.verification_status !== "VERIFIED") throw new Error(`${slot.slot_key}: plan source Coverage is not VERIFIED`);
    const separator = slot.slot_key.indexOf("::");
    if (separator < 1) throw new Error(`${slot.slot_key}: invalid slot_key`);
    const questionId = slot.slot_key.slice(0, separator);
    const slotName = slot.slot_key.slice(separator + 2);
    const list = slotsByQuestion.get(questionId) ?? [];
    list.push({ slot_name: slotName, fact_ids: [...slot.fact_ids], evidence_ids: [...slot.evidence_ids] });
    slotsByQuestion.set(questionId, list);
  }

  const plans = gold
    .filter((record) => record.extensions?.e2e_usage_status === "E2E_READY")
    .map((record) => {
      const slots = slotsByQuestion.get(record.question_id);
      if (!slots?.length) throw new Error(`${record.question_id}: no VERIFIED Coverage slots`);
      return {
        schema_version: "0.1.0",
        question_id: record.question_id,
        question_sha256: sha256(record.question),
        as_of_date: record.as_of_date,
        corp_codes: [...record.corp_codes],
        // These are identities of already-VERIFIED grounding records, not
        // expected values. Including all question-linked Evidence keeps a
        // direct lookup from silently dropping dates/text that do not have
        // their own numeric Fact slot (for example, a contract end date).
        evidence_ids: [...new Set(record.extensions?.evidence_ids ?? [])].sort(),
        slots: slots.sort((a, b) => a.slot_name.localeCompare(b.slot_name)),
      };
    })
    .sort((a, b) => a.question_id.localeCompare(b.question_id));
  if (plans.length !== expectedPlanCount) throw new Error(`expected ${expectedPlanCount} E2E-ready plans, got ${plans.length}`);
  if (plans.some((plan) => excludedQuestionIds.includes(plan.question_id))) throw new Error("excluded question leaked into plans");
  const planText = `${plans.map((plan) => JSON.stringify(plan)).join("\n")}\n`;
  const manifest = {
    schema_version: "0.1.0",
    artifact: paths.plans,
    artifact_sha256: sha256(planText),
    record_count: plans.length,
    corpus_snapshot_id: coverage.corpus_snapshot_id,
    fact_coverage_snapshot_id: coverage.fact_coverage_snapshot_id,
    source_gold: paths.gold,
    source_coverage: paths.coverage,
    forbidden_runtime_fields: ["expected_answer", "scoring_spec", "required_evidence_slots"],
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  if (writeOutputs) {
    await mkdir(path.dirname(resolve(paths.plans)), { recursive: true });
    await Promise.all([writeFile(resolve(paths.plans), planText), writeFile(resolve(paths.manifest), manifestText)]);
  }
  return { plans, manifest, planText, manifestText };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildSeedThinFlowPlans();
  process.stdout.write(`${JSON.stringify({ plan_count: result.plans.length, artifact_sha256: result.manifest.artifact_sha256 }, null, 2)}\n`);
}
