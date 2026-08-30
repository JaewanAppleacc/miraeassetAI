// Turn P6 section C: runs all 8 Grading Scorers as independent modules and
// assembles their outputs into the `scoring` object benchmark-item-result.schema.json
// expects. The 8 axes never combine into a single number here UNLESS an
// explicit ScoringPolicy (scoring-policy.schema.json) is supplied -- the
// default is axis-only output, per this Turn's own "가중 종합 점수는 별도의
// 명시적 scoring policy가 제공될 때만 계산" rule.
//
// scoringEligible=false (a fallback/failure row) SKIPs every axis instead
// of scoring a substituted or absent answer -- this is the ONE place that
// enforces "scoring_eligible=false는 정확도 평균에 포함하지 않는다": a SKIPPED
// axisResult's raw_score is always null, so report.mjs's mean/median never
// includes it, while the row itself still appears in item_count/
// outcome_category_counts (never dropped from failure-rate accounting).
import { scoreAnswerability } from "./answerability.mjs";
import { scoreNumericClaim } from "./numeric-claim.mjs";
import { scoreDateClaim } from "./date-claim.mjs";
import { scoreFactCoverage } from "./fact-coverage.mjs";
import { scoreEventRelation } from "./event-relation.mjs";
import { scoreCitation } from "./citation.mjs";
import { scoreStyle } from "./style.mjs";
import { scoreOperational } from "./operational.mjs";
import { skipped } from "./axis-result.mjs";
import { SCORING_AXES } from "../contracts.mjs";

function skippedAxes() {
  return Object.fromEntries(SCORING_AXES.map((axis) => [axis, skipped()]));
}

// Derived, best-effort, from final_response.retrieved_context -- the same
// field every variant's own groundedFacts/eventContext/relationContext
// projection already populates (see e.g. flows/structured-first-agent.mjs's
// own `retrieved_context` array construction). Never invented beyond what
// that array actually contains.
export function deriveActualFromRetrievedContext(retrievedContext) {
  const entries = Array.isArray(retrievedContext) ? retrievedContext : [];
  return {
    actualFactIds: entries.filter((entry) => typeof entry?.fact_id === "string").map((entry) => entry.fact_id),
    actualEventIds: entries.filter((entry) => typeof entry?.event_id === "string").map((entry) => entry.event_id),
  };
}

export function scoreItem({
  datasetRecord,
  scoringEligible,
  answerText,
  retrievedContext,
  selectedEvidenceIds,
  citationBindingStatus,
  unsupportedClaimCount,
  evidenceValidationSuccessRate,
  validationStatus,
  operationalTelemetry,
  actualRelations,
  scoringPolicy = null,
}) {
  const scoringPolicyVersion = scoringPolicy?.scoring_policy_version ?? null;

  if (!scoringEligible) {
    return Object.freeze({ schema_version: "0.1.0", scoring_policy_version: scoringPolicyVersion, axes: Object.freeze(skippedAxes()), composite_score: null });
  }

  const { actualFactIds, actualEventIds } = deriveActualFromRetrievedContext(retrievedContext);
  const allowedCorpCodes = (datasetRecord.hints?.corp_codes ?? []);

  const axes = {
    answerability: scoreAnswerability({ expectedAnswerability: datasetRecord.expected_answerability, actualValidationStatus: validationStatus }),
    numeric_claim: scoreNumericClaim({
      expectedNumericClaims: datasetRecord.expected_numeric_claims, answerText,
      numericUnitConversions: scoringPolicy?.numeric_unit_conversions ?? [],
    }),
    date_claim: scoreDateClaim({ expectedDateClaims: datasetRecord.expected_date_claims, answerText }),
    fact_coverage: scoreFactCoverage({ expectedFacts: datasetRecord.expected_facts, actualFactIds }),
    event_relation: scoreEventRelation({
      expectedEvents: datasetRecord.expected_events, expectedRelations: datasetRecord.expected_relations,
      actualEventIds, actualRelations,
    }),
    citation: scoreCitation({
      allowedEvidenceIds: datasetRecord.allowed_evidence_ids, selectedEvidenceIds, citationBindingStatus,
      unsupportedClaimCount, evidenceValidationSuccessRate,
    }),
    style: scoreStyle({ answerText, allowedCorpCodes }),
    operational: scoreOperational(operationalTelemetry ?? {}),
  };

  let compositeScore = null;
  if (scoringPolicy) {
    const weights = scoringPolicy.axis_weights;
    const totalWeight = SCORING_AXES.reduce((sum, axis) => sum + (weights[axis] ?? 0), 0);
    if (totalWeight > 0) {
      const weightedSum = SCORING_AXES.reduce((sum, axis) => {
        const result = axes[axis];
        if (typeof result.raw_score !== "number") return sum;
        return sum + result.raw_score * (weights[axis] ?? 0);
      }, 0);
      const consideredWeight = SCORING_AXES.reduce((sum, axis) => (typeof axes[axis].raw_score === "number" ? sum + (weights[axis] ?? 0) : sum), 0);
      compositeScore = consideredWeight > 0 ? weightedSum / consideredWeight : null;
    }
  }

  return Object.freeze({ schema_version: "0.1.0", scoring_policy_version: scoringPolicyVersion, axes: Object.freeze(axes), composite_score: compositeScore });
}
