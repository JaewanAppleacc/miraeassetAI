// Turn P6 section C.4: Fact Coverage Scorer. Checks the fraction of
// REQUIRED expected Facts (expectedFact.required=true) that the Agent
// actually grounded (present as a `fact_id` entry in
// final_response.retrieved_context, the same field every variant's own
// groundedFacts projection already populates -- see e.g.
// flows/structured-first-agent.mjs's own `retrieved_context` construction),
// and separately flags any grounded fact_id that is NOT in the
// DatasetRecord's expected set at all (an "unauthorized Fact addition" --
// informational + counted against the score, never silently ignored).
//
// This Turn's DatasetRecord contract (section A) deliberately allows an
// expectedFact to carry only a semantic_slot (no real fact_id yet, since
// the real Gold's fact_id catalog is not fixed by this Turn -- see
// dataset-record.schema.json's own header). When EVERY required expected
// Fact is semantic-slot-only (no fact_id), this scorer honestly reports
// NOT_APPLICABLE rather than inventing a semantic-slot matcher this Turn
// has no real Fact catalog to validate against.
import { pass, partial, notApplicable } from "./axis-result.mjs";

export function scoreFactCoverage({ expectedFacts, actualFactIds }) {
  const requiredFacts = (expectedFacts ?? []).filter((fact) => fact.required === true);
  if (requiredFacts.length === 0) return notApplicable();

  const idBearingRequired = requiredFacts.filter((fact) => typeof fact.fact_id === "string" && fact.fact_id !== "");
  if (idBearingRequired.length === 0) {
    return notApplicable({ reason: "all required expected_facts are semantic_slot-only; no fact_id to check against this run's retrieved_context" });
  }

  const actualSet = new Set(actualFactIds ?? []);
  const expectedIdSet = new Set((expectedFacts ?? []).map((fact) => fact.fact_id).filter((id) => typeof id === "string" && id !== ""));
  const coveredCount = idBearingRequired.filter((fact) => actualSet.has(fact.fact_id)).length;
  const unauthorizedFactIds = [...actualSet].filter((id) => !expectedIdSet.has(id)).sort();

  const coverageScore = coveredCount / idBearingRequired.length;
  const errorCodes = [];
  if (coverageScore < 1) errorCodes.push("MISSING_REQUIRED_FACT");
  if (unauthorizedFactIds.length > 0) errorCodes.push("UNAUTHORIZED_FACT_ADDED");

  const details = { covered_count: coveredCount, required_count: idBearingRequired.length, unauthorized_fact_ids: unauthorizedFactIds };
  if (errorCodes.length === 0) return pass(details);
  // An unauthorized addition with otherwise full coverage still FAILs this
  // axis (raw_score capped just under 1) -- "승인되지 않은 Fact 추가" is a
  // real defect, not merely a footnote on an otherwise-perfect score.
  const rawScore = unauthorizedFactIds.length > 0 ? Math.min(coverageScore, 0.99) : coverageScore;
  return partial(rawScore, errorCodes, details);
}
