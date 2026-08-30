// Turn P6 section C.1: Answerability Scorer. Compares
// DatasetRecord.expected_answerability against the actual validation_status
// telemetry.mjs's buildTelemetryEvent already derived (never re-derived
// here -- see deriveValidationStatus in telemetry.mjs, ANSWERABILITY_TO_VALIDATION_STATUS).
// A DatasetRecord marked UNANSWERABLE/WITHHELD/NOT_APPLICABLE (a question
// this codebase's own data genuinely cannot or should not answer) where the
// Agent nonetheless produced a SUPPORTED (specific, asserted) answer is a
// hallucination -- FAIL, never a partial credit.
import { pass, fail } from "./axis-result.mjs";

export function scoreAnswerability({ expectedAnswerability, actualValidationStatus }) {
  if (actualValidationStatus === expectedAnswerability) {
    return pass({ expected: expectedAnswerability, actual: actualValidationStatus });
  }
  if (expectedAnswerability !== "SUPPORTED" && actualValidationStatus === "SUPPORTED") {
    return fail(["HALLUCINATED_ANSWER_ON_UNANSWERABLE_ITEM"], { expected: expectedAnswerability, actual: actualValidationStatus });
  }
  return fail(["ANSWERABILITY_MISMATCH"], { expected: expectedAnswerability, actual: actualValidationStatus });
}
