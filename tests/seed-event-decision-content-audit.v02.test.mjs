// Turn I §7: `event_decision_content` (metric_code EVENT_DECISION_CONTENT)
// is audited, not migrated. This test reads the 4 REAL VERIFIED records
// (a factual audit, not a synthetic fixture) and confirms the renderer
// never over-claims a stronger DATE/STATUS meaning than `value_type`
// actually supports for them -- current behavior (NARRATIVE default,
// derived from metric_code naming, not value_type) is the safe/
// under-claiming side and stays UNCHANGED this turn. See
// work/domain-seed/seed-event-decision-content-fact-audit.v0.1.md for the
// full narrative audit; this is its automated regression guard.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { planSynthesisSignals } from "../domain/flows/synthesis/synthesis-signal-planner.mjs";
import { extractNarrativeFields } from "../domain/flows/synthesis/narrative-field-extractor.mjs";
import { composeResponse } from "../domain/flows/synthesis/response-composer.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const AUDITED_FACT_IDS = [
  "fact_1152c0d605118ea9eef3de0f", // normalized_value bare DATE string, value_type TEXT
  "fact_ae59c05c37847e6d6cdbf143", // normalized_value bare DATE string, value_type TEXT
  "fact_4597ff14b5448794ef892877", // normalized_value STATUS-enum-like string, value_type TEXT
  "fact_9ecd8857c3ad5257599612f0", // normalized_value bare DATE string, value_type DATE (the one record with a non-TEXT value_type)
];

test("all 4 real EVENT_DECISION_CONTENT records exist as audited (fails loudly if the artifact ever changes underneath this audit)", async () => {
  const rows = (await readFile(path.join(ROOT, "work/domain-seed/seed-facts-verified.v0.7.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const found = rows.filter((r) => AUDITED_FACT_IDS.includes(r.fact_id));
  assert.equal(found.length, 4);
  for (const fact of found) assert.equal(fact.metric_code, "EVENT_DECISION_CONTENT");
});

test("the renderer never invents a DATE or STATUS claim for any of the 4 real EVENT_DECISION_CONTENT records -- the current NARRATIVE default is preserved (under-claiming, never over-claiming)", async () => {
  const rows = (await readFile(path.join(ROOT, "work/domain-seed/seed-facts-verified.v0.7.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const facts = rows.filter((r) => AUDITED_FACT_IDS.includes(r.fact_id));
  assert.equal(facts.length, 4);
  const signals = planSynthesisSignals({ question: "q", facts, events: [], evidence: [], calculationValue: {} });
  const narrativeFields = extractNarrativeFields({ facts, evidence: [], slots: [], signals });
  const composed = composeResponse({ facts, events: [], evidence: [], calculationValue: {}, signals, narrativeFields });
  for (const fact of facts) {
    const claim = composed.numeric_claims.find((c) => c.source?.kind === "fact" && c.source.id === fact.fact_id);
    assert.ok(claim, `expected a claim for ${fact.fact_id}`);
    assert.equal(claim.type, "NARRATIVE", `${fact.fact_id} (value_type=${fact.value_type}) must stay NARRATIVE, not over-claim DATE/STATUS`);
  }
});
