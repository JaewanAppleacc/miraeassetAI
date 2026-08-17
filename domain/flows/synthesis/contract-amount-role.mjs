// Turn M2 item 6A: a Flow-local semantic role registry (never a Plan
// slot-name/question_id lookup) recognizing two real, corpus-wide metric
// ontology roles that can describe the SAME underlying contract for the
// SAME company: the amount stated in a termination disclosure
// (TERMINATION_AMOUNT), and the contract amount that was effective/
// current at that time (CONTRACT_AMOUNT, or its corrected-value form
// LATEST_CONTRACT_AMOUNT). Both metric_code tokens are real values
// observed directly in the VERIFIED Fact corpus (never invented), so this
// registry generalizes to ANY company/event chain carrying both roles,
// never one tied to a specific company or question.
export const TERMINATION_AMOUNT_METRIC_CODE = "TERMINATION_AMOUNT";
export const EFFECTIVE_CONTRACT_AMOUNT_METRIC_CODES = Object.freeze(["CONTRACT_AMOUNT", "LATEST_CONTRACT_AMOUNT"]);

export function isEffectiveContractAmountMetric(metricCode) {
  return EFFECTIVE_CONTRACT_AMOUNT_METRIC_CODES.includes(metricCode);
}

// Order-invariant: true when the two metric_codes are exactly one
// TERMINATION_AMOUNT and one effective-contract-amount role.
export function isTerminationVsContractAmountPair(metricCodes) {
  if (!Array.isArray(metricCodes) || metricCodes.length !== 2) return false;
  const hasTermination = metricCodes.includes(TERMINATION_AMOUNT_METRIC_CODE);
  const hasContract = metricCodes.some((code) => isEffectiveContractAmountMetric(code));
  return hasTermination && hasContract;
}
