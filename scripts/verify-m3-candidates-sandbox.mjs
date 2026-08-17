// Turn M3: a SANDBOX-only, direct synthesis-pipeline check for the new
// CANDIDATE Facts (never routed through the production Runtime's
// authorization/verification gate, which correctly refuses non-VERIFIED
// records -- this script exists purely to preview how the Composer would
// render them once/if an Owner promotes them, matching the same
// generic-capability code path VERIFIED data already uses). Never
// writes to any protected artifact.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planSynthesisSignals } from "../domain/flows/synthesis/synthesis-signal-planner.mjs";
import { extractNarrativeFields } from "../domain/flows/synthesis/narrative-field-extractor.mjs";
import { composeResponse } from "../domain/flows/synthesis/response-composer.mjs";
import { validateSynthesis } from "../domain/flows/synthesis/final-synthesis-validator.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jsonl = (text) => text.trim().split("\n").map((l) => JSON.parse(l));

const allFacts = jsonl(await readFile(path.join(REPO, "work/domain-seed/seed-facts-verified.v0.7.jsonl"), "utf8"));
const allEvidence = jsonl(await readFile(path.join(REPO, "work/domain-seed/seed-evidence-verified.v0.9.jsonl"), "utf8"));
const allEvents = jsonl(await readFile(path.join(REPO, "work/domain-seed/seed-events-verified.v0.1.jsonl"), "utf8"));
const newFacts = jsonl(await readFile(path.join(REPO, "work/domain-seed/seed-facts-candidates.v0.8.delta.jsonl"), "utf8"));
const plan = jsonl(await readFile(path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.10.candidate.jsonl"), "utf8"));

const factsById = new Map(allFacts.map((f) => [f.fact_id, f]));
for (const f of newFacts) factsById.set(f.fact_id, f);
const evidenceById = new Map(allEvidence.map((e) => [e.evidence_id, e]));

function runFor(questionId, question) {
  const p = plan.find((x) => x.question_id === questionId);
  const factIds = [...new Set(p.slots.flatMap((s) => s.fact_ids))];
  const evidenceIds = [...new Set([...(p.evidence_ids ?? []), ...p.slots.flatMap((s) => s.evidence_ids)])];
  const facts = factIds.map((id) => factsById.get(id)).filter(Boolean);
  const evidence = evidenceIds.map((id) => evidenceById.get(id)).filter(Boolean);
  const events = allEvents.filter((e) => e.evidence_ids.some((id) => evidenceIds.includes(id)));

  const calculationValue = {};
  const signals = planSynthesisSignals({ question, facts, events, evidence, calculationValue });
  const narrativeFields = extractNarrativeFields({ facts, evidence, slots: p.slots, signals });
  const composed = composeResponse({ facts, events, evidence, calculationValue, signals, narrativeFields, calculationRegistry: [], companyLabels: null, slots: p.slots });
  const validation = validateSynthesis({
    composerOutput: composed, signals, calculationValue, facts, evidence, events,
    authorizedFactIds: facts.map((f) => f.fact_id), authorizedEventIds: events.map((e) => e.event_id), authorizedEvidenceIds: evidence.map((e) => e.evidence_id),
  });
  console.log(`=== ${questionId} ===`);
  console.log(composed.answer.split("근거 공시:")[0]);
  console.log("synthesis:", validation.status, JSON.stringify(validation.reasons));
  console.log();
}

runFor("question_seed_v07_09", "회사의 자기주식 신탁계약 취득부터 소각까지의 과정을 정리하고, 계약 상대방과 계약금액을 설명해줘.");
runFor("question_seed_v07_25", "계약의 유보기한 변경 이력을 정리해줘.");

// -- Q17: simulate what thin-structured-flow.mjs's generic contract-
// amount-match loop (Turn M2 item 6A) would compute once these new
// LATEST_CONTRACT_AMOUNT facts are promoted -- confirms the RENDERING
// side (already implemented) correctly recognizes the shape.
{
  const samsungHeavyLatest = factsById.get([...factsById.values()].find((f) => f.metric_code === "LATEST_CONTRACT_AMOUNT" && f.corp_code === "00126478").fact_id);
  const samsungHeavyTermination = allFacts.find((f) => f.metric_code === "TERMINATION_AMOUNT" && f.corp_code === "00126478");
  const hyosungLatest = [...factsById.values()].find((f) => f.metric_code === "LATEST_CONTRACT_AMOUNT" && f.corp_code === "01316245");
  const hyosungTermination = allFacts.find((f) => f.metric_code === "TERMINATION_AMOUNT" && f.corp_code === "01316245");

  function makeMatchEntry(terminationFact, contractFact, key) {
    return {
      key, formula: "DIFF", output_kind: "VALUE",
      result: terminationFact.normalized_value - contractFact.normalized_value,
      input_fact_ids: [terminationFact.fact_id, contractFact.fact_id],
      input_labels: [terminationFact.raw_label, contractFact.raw_label],
      input_units: [terminationFact.unit, contractFact.unit],
      input_corp_codes: [terminationFact.corp_code, contractFact.corp_code],
      input_periods: [terminationFact.as_of_date, contractFact.as_of_date],
      input_metric_codes: [terminationFact.metric_code, contractFact.metric_code],
    };
  }
  const registry = [
    makeMatchEntry(samsungHeavyTermination, samsungHeavyLatest, "contract_amount_match_diff_krw__samsung_heavy"),
    makeMatchEntry(hyosungTermination, hyosungLatest, "contract_amount_match_diff_krw__hyosung"),
  ];
  // Matches thin-structured-flow.mjs's calculateFactPair, which always
  // writes calculationValue[outputKey] = result alongside the registry
  // entry -- both must agree for the validator's exact-match re-derivation.
  const calculationValue = Object.fromEntries(registry.map((r) => [r.key, r.result]));
  const facts = [samsungHeavyTermination, samsungHeavyLatest, hyosungTermination, hyosungLatest];
  const question = "회사별 해지금액이 해지 시점 유효 계약금액과 일치하는지 판정해줘.";
  const signals = planSynthesisSignals({ question, facts, events: [], evidence: [], calculationValue });
  const narrativeFields = extractNarrativeFields({ facts, evidence: [], slots: [], signals });
  const companyLabels = { "00126478": { corp_name: "삼성중공업" }, "01316245": { corp_name: "효성중공업" } };
  const composed = composeResponse({ facts, events: [], evidence: [], calculationValue, signals, narrativeFields, calculationRegistry: registry, companyLabels, slots: [] });
  const validation = validateSynthesis({
    composerOutput: composed, signals, calculationValue, facts, evidence: [], events: [],
    authorizedFactIds: facts.map((f) => f.fact_id), authorizedEventIds: [], authorizedEvidenceIds: [],
  });
  console.log("=== Q17 contract-amount match simulation ===");
  console.log(composed.answer.split("근거 공시:")[0]);
  console.log("synthesis:", validation.status, JSON.stringify(validation.reasons));
}
