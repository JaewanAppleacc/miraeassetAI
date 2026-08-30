// Turn P6 section C.3: Date Claim Scorer. A date VALUE and its ROLE
// (DECISION_DATE/CORRECTION_DATE/COMPLETION_DATE/AS_OF_DATE/...) are
// checked together -- a correct date attached to the wrong role (e.g. the
// correction filing date reported back as the decision date) is its own
// DATE_ROLE_MISMATCH error, never silently accepted just because the date
// value itself is present somewhere in the answer.
//
// Role detection is a fixed, small keyword-window match (never a general
// NLP pass -- same "no semantic analysis" discipline
// flows/hard-claim-grounding.mjs's own header comment documents): each
// occurrence of an expected date's digits in the answer text is checked for
// a role-label keyword within ROLE_WINDOW characters on either side. If the
// correct role's own label is present in that window, the date counts as
// PASS; if a DIFFERENT role's label is present instead (and the correct
// one is not), it is DATE_ROLE_MISMATCH; if no role label is nearby at all,
// the date value still counts as PASS (role is simply unverifiable from
// free text alone, which is not itself an error).
import { extractHardClaims } from "../../flows/hard-claim-grounding.mjs";
import { pass, partial, notApplicable } from "./axis-result.mjs";

const ROLE_LABELS_KO = Object.freeze({
  DECISION_DATE: ["결정일", "이사회결의일"],
  CORRECTION_DATE: ["정정일"],
  COMPLETION_DATE: ["완료일", "종료일"],
  AS_OF_DATE: ["기준일"],
});

const ROLE_WINDOW = 15;

function normalizeDigits(text) {
  return text.replace(/[^0-9]/g, "");
}

// ISO/dot-separated dates AND Korean "YYYY년 MM월 DD일" dates both appear
// literally in the source text; extractHardClaims already normalizes both
// to digit-only form for MEMBERSHIP checks, but this scorer additionally
// needs each occurrence's TEXT POSITION for the role-window check, which
// extractHardClaims (a membership-set extractor) does not expose -- so
// this file finds raw occurrences itself, using the exact same patterns.
const ISO_DATE_PATTERN = /[0-9]{4}[-.][0-9]{2}[-.][0-9]{2}/g;
const KOREAN_DATE_PATTERN = /[0-9]{4}\s*년(?:\s*[0-9]{1,2}\s*월(?:\s*[0-9]{1,2}\s*일)?)?/g;

function findOccurrences(text, expectedDigits) {
  const positions = [];
  for (const pattern of [ISO_DATE_PATTERN, KOREAN_DATE_PATTERN]) {
    for (const match of text.matchAll(pattern)) {
      if (normalizeDigits(match[0]) === expectedDigits) {
        positions.push({ start: match.index, end: match.index + match[0].length });
      }
    }
  }
  return positions;
}

function roleAtWindow(text, start, end) {
  const window = text.slice(Math.max(0, start - ROLE_WINDOW), Math.min(text.length, end + ROLE_WINDOW));
  const rolesPresent = Object.entries(ROLE_LABELS_KO)
    .filter(([, labels]) => labels.some((label) => window.includes(label)))
    .map(([role]) => role);
  return rolesPresent;
}

export function scoreDateClaim({ expectedDateClaims, answerText }) {
  if (!Array.isArray(expectedDateClaims) || expectedDateClaims.length === 0) return notApplicable();

  // Sanity: the digit-membership set (same normalization extractHardClaims
  // uses) gates whether a claim's value is present at all, before this
  // module's own positional occurrence search runs.
  const presentDigits = new Set(extractHardClaims(answerText).dates);

  let matched = 0;
  const errorCodes = [];
  const mismatches = [];
  for (const claim of expectedDateClaims) {
    const expectedDigits = normalizeDigits(claim.date);
    if (!presentDigits.has(expectedDigits)) {
      errorCodes.push("MISSING_DATE_CLAIM");
      mismatches.push({ date_role: claim.date_role, expected_date: claim.date, reason: "MISSING_DATE_CLAIM" });
      continue;
    }
    const occurrences = findOccurrences(answerText, expectedDigits);
    const rolesSeen = new Set(occurrences.flatMap((occurrence) => roleAtWindow(answerText, occurrence.start, occurrence.end)));
    if (rolesSeen.size === 0 || rolesSeen.has(claim.date_role)) {
      matched += 1;
      continue;
    }
    errorCodes.push("DATE_ROLE_MISMATCH");
    mismatches.push({ date_role: claim.date_role, expected_date: claim.date, roles_found: [...rolesSeen], reason: "DATE_ROLE_MISMATCH" });
  }

  const rawScore = matched / expectedDateClaims.length;
  if (rawScore >= 1) return pass({ matched_count: matched, expected_count: expectedDateClaims.length });
  return partial(rawScore, errorCodes, { matched_count: matched, expected_count: expectedDateClaims.length, mismatches });
}
