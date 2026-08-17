import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateEvaluationGoldV02 } from "../domain/contracts.mjs";

const rootDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED_AT = "2026-08-13T02:00:00.000Z";
const PATHS = Object.freeze({
  sourceGold: "work/domain-seed/seed-gold-promotion-candidates.v0.13.jsonl",
  coverage: "work/domain-seed/seed-fact-coverage-verified.v0.1.json",
  outputGold: "work/domain-seed/seed-gold-promotion-candidates.v0.14.jsonl",
  mapping: "work/domain-seed/seed-v13-to-v14-route-policy-mapping.jsonl",
  report: "work/domain-seed/seed-gold-promotion-candidates.v0.14.route-policy-review.md",
});

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const jsonl = (records) => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
function parseJsonl(text) { return text.split(/\r?\n/).filter(Boolean).map(JSON.parse); }

export async function buildSeedGoldV014RoutePolicy({ root = rootDefault, paths = PATHS, writeOutputs = true, generatedAt = GENERATED_AT } = {}) {
  const resolved = Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, path.resolve(root, value)]));
  const [sourceText, coverageText] = await Promise.all([readFile(resolved.sourceGold, "utf8"), readFile(resolved.coverage, "utf8")]);
  const source = parseJsonl(sourceText);
  const coverage = JSON.parse(coverageText);
  const coverageByQuestion = new Map();
  for (const slot of coverage.slots ?? []) {
    if (slot.verification_status !== "VERIFIED") throw new Error(`${slot.slot_key}: Coverage is not VERIFIED`);
    const questionId = slot.slot_key.split("::", 1)[0];
    const states = coverageByQuestion.get(questionId) ?? new Set();
    states.add(slot.coverage_state);
    coverageByQuestion.set(questionId, states);
  }

  const mapping = [];
  const output = source.map((record) => {
    const ready = record.extensions?.e2e_usage_status === "E2E_READY";
    if (!ready) {
      mapping.push({ question_id: record.question_id, action: "CARRY_FORWARD_EXCLUDED", route_policy_changed: false });
      return structuredClone(record);
    }
    const states = [...(coverageByQuestion.get(record.question_id) ?? [])].sort();
    if (states.length === 0) throw new Error(`${record.question_id}: no VERIFIED Coverage`);
    const requiredOperations = ["query_verified_facts", "query_verified_evidence", "validate_provenance"];
    const updated = structuredClone(record);
    updated.expected_execution.applicable_fact_coverage_states = states;
    updated.expected_execution.route_policy = states.map((state) => ({
      when: state,
      preferred_route: "STRUCTURED",
      allowed_routes: ["STRUCTURED"],
      required_operations: requiredOperations,
      forbidden_operations: ["recommend_investment", "predict_future_value", "infer_missing_value"],
      expected_answerability: record.expected_answerability,
    }));
    updated.authored_against.gold_revision = "gold-seed-v0.14-verified-coverage-route-policy-draft";
    updated.created_at = generatedAt;
    updated.extensions.artifact_status = "DRAFT";
    updated.extensions.route_policy_status = "DRAFT_RUNTIME_ALIGNED_PENDING_OWNER_REVIEW";
    mapping.push({
      question_id: record.question_id,
      action: "ROUTE_POLICY_DRAFT_UPDATED",
      route_policy_changed: true,
      coverage_states: states,
      old_route_sha256: sha256(JSON.stringify(record.expected_execution.route_policy)),
      new_route_sha256: sha256(JSON.stringify(updated.expected_execution.route_policy)),
    });
    return updated;
  });

  if (output.length !== 25 || mapping.filter((item) => item.route_policy_changed).length !== 23) throw new Error("expected 23 route updates and 2 exclusions");
  for (let index = 0; index < output.length; index++) {
    const errors = validateEvaluationGoldV02(output[index]);
    if (errors.length) throw new Error(`${output[index].question_id}: ${errors.join("; ")}`);
    const before = source[index];
    const after = output[index];
    for (const protectedField of ["question", "expected_answer", "required_evidence_slots", "scoring_spec", "gold_document_ids", "gold_chain_ids"]) {
      if (JSON.stringify(before[protectedField]) !== JSON.stringify(after[protectedField])) throw new Error(`${after.question_id}: protected field changed: ${protectedField}`);
    }
  }

  const outputText = jsonl(output);
  const mappingText = jsonl(mapping);
  const report = `# Seed Gold v0.14 route-policy DRAFT\n\n- Source: v0.13 (immutable)\n- Records: 25\n- VERIFIED Coverage → STRUCTURED draft: 23\n- Excluded/carry-forward: Q3, Q22\n- Answer/Evidence/scoring changes: 0\n- Status: PENDING_OWNER_REVIEW\n- Output SHA-256: ${sha256(outputText)}\n\nThis revision only removes the stale NO_STRUCTURED_FACT_COVERAGE/RETRIEVAL assumption. It does not claim that final-answer metrics pass.\n`;
  if (writeOutputs) {
    await mkdir(path.dirname(resolved.outputGold), { recursive: true });
    await Promise.all([writeFile(resolved.outputGold, outputText), writeFile(resolved.mapping, mappingText), writeFile(resolved.report, report)]);
  }
  return Object.freeze({ output, mapping, outputText, mappingText, report });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildSeedGoldV014RoutePolicy();
  console.log(JSON.stringify({ records: result.output.length, route_updates: result.mapping.filter((item) => item.route_policy_changed).length }));
}
