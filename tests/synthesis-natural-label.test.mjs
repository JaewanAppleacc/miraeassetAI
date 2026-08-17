// Turn M capability B: internal enum/raw-field-numbering translation,
// tested against real (but generic, corpus-wide) enum tokens and
// synthetic unknown tokens. Never a per-question fixture.
import assert from "node:assert/strict";
import test from "node:test";
import {
  looksLikeInternalEnum, looksLikeSnakeCaseToken, naturalizeFactEnum, naturalizeEventType, naturalizeEventStatus, naturalizeFieldLabel,
} from "../domain/flows/synthesis/natural-label.mjs";

test("looksLikeInternalEnum: multi-segment SCREAMING_SNAKE_CASE is detected", () => {
  assert.equal(looksLikeInternalEnum("SOME_INTERNAL_TOKEN"), true);
  assert.equal(looksLikeInternalEnum("TERMINATED"), false); // single word, no underscore
  assert.equal(looksLikeInternalEnum("일반 텍스트"), false);
  assert.equal(looksLikeInternalEnum(123), false);
});

test("looksLikeSnakeCaseToken: lower_snake_case is detected generically", () => {
  assert.equal(looksLikeSnakeCaseToken("some_internal_field"), true);
  assert.equal(looksLikeSnakeCaseToken("일반 텍스트"), false);
});

test("naturalizeFactEnum: a known corpus-wide enum token maps to natural Korean, never the raw token", () => {
  const result = naturalizeFactEnum("TERMINATED");
  assert.notEqual(result.label, "TERMINATED");
  assert.equal(result.confident, true);
  assert.equal(/^[A-Z_]+$/.test(result.label), false);
});

test("naturalizeEventType/naturalizeEventStatus: known corpus-wide Event enums map to natural Korean", () => {
  const typeResult = naturalizeEventType("SUPPLY_CONTRACT_TERMINATION");
  assert.notEqual(typeResult.label, "SUPPLY_CONTRACT_TERMINATION");
  assert.equal(typeResult.confident, true);
  const statusResult = naturalizeEventStatus("TERMINATED");
  assert.notEqual(statusResult.label, "TERMINATED");
});

test("an UNKNOWN enum-shaped token never renders as the raw token, not even transliterated, and is flagged not confident", () => {
  const result = naturalizeFactEnum("TOTALLY_NEW_UNSEEN_ENUM_TOKEN");
  // Turn M2 item 3: a lowercased/underscore-stripped transliteration of the
  // raw token (e.g. "totally new unseen enum token") is STILL the internal
  // representation, just reformatted -- it must never appear either. Only
  // a fixed, token-independent safe phrase may be shown.
  assert.equal(result.label, "상태를 자연어로 변환할 수 없어 추가 확인이 필요합니다");
  assert.equal(result.confident, false);
  assert.equal(/^[A-Z_]+$/.test(result.label), false);
  assert.equal(result.label.toLowerCase().includes("totally"), false);
  assert.equal(result.label.toLowerCase().includes("unseen"), false);
});

test("two DIFFERENT unknown enum-shaped tokens render the SAME safe phrase (never derived from the raw token's own content)", () => {
  const a = naturalizeFactEnum("ALPHA_UNKNOWN_TOKEN_ONE");
  const b = naturalizeFactEnum("COMPLETELY_DIFFERENT_TOKEN_TWO");
  assert.equal(a.label, b.label);
  assert.equal(a.confident, false);
  assert.equal(b.confident, false);
});

test("a non-enum-shaped string (a legitimate proper noun, e.g. a single all-caps identity token) passes through unchanged", () => {
  const result = naturalizeFactEnum("ACMECORP");
  assert.equal(result.label, "ACMECORP");
  assert.equal(result.confident, true);
});

test("naturalizeFieldLabel: strips a leading raw disclosure-form numbering prefix generically", () => {
  assert.equal(naturalizeFieldLabel("3. 처분예정금액·보통주식"), "처분예정금액·보통주식");
  assert.equal(naturalizeFieldLabel("9. 기타 투자판단과 관련한 중요사항"), "기타 투자판단과 관련한 중요사항");
  assert.equal(naturalizeFieldLabel("투자금액(원)"), "투자금액(원)"); // no leading numbering -- unchanged
});

test("naturalizeFieldLabel: strips a leading raw disclosure-form bullet prefix generically", () => {
  assert.equal(naturalizeFieldLabel("- 투자대상"), "투자대상");
  assert.equal(naturalizeFieldLabel("-투자대상"), "-투자대상"); // no space after dash -- not a bullet, left unchanged
  assert.equal(naturalizeFieldLabel("해지금액(원)-정정후"), "해지금액(원)-정정후"); // mid-string dash unaffected
});

test("naturalizeFieldLabel never throws on non-string input", () => {
  assert.doesNotThrow(() => naturalizeFieldLabel(null));
  assert.doesNotThrow(() => naturalizeFieldLabel(undefined));
});
