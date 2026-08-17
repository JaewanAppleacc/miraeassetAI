// Turn M10: the real VERIFIED Fact corpus is not consistent about whether
// a Fact's `unit` field holds the enum token ("KRW") or the raw Korean
// label ("원") -- calculateFactPair's eligibility check (thin-structured-
// flow.mjs) used a raw string comparison, so a genuinely-matching pair
// spelled with different unit forms was silently treated as ineligible
// for calculation (no calculationRegistry entry ever created), which is
// the root cause behind a company-vs-company amount MATCH conclusion
// never being generated even when the two values are exactly equal.
// Synthetic fixtures only -- no real Seed company/fact/document literal.
import assert from "node:assert/strict";
import test from "node:test";
import { unitsAreEquivalent } from "../domain/flows/thin-structured-flow.mjs";

test("Turn M10: unitsAreEquivalent recognizes the KRW enum token and its raw Korean label as the SAME unit", () => {
  assert.equal(unitsAreEquivalent("KRW", "원"), true);
  assert.equal(unitsAreEquivalent("원", "KRW"), true);
});

test("Turn M10: unitsAreEquivalent still treats identical raw strings as equivalent (no regression)", () => {
  assert.equal(unitsAreEquivalent("KRW", "KRW"), true);
  assert.equal(unitsAreEquivalent("원", "원"), true);
  assert.equal(unitsAreEquivalent("PERCENT", "PERCENT"), true);
  assert.equal(unitsAreEquivalent(null, null), true);
  assert.equal(unitsAreEquivalent(undefined, null), true);
});

test("Turn M10 counterexample: unitsAreEquivalent never treats genuinely DIFFERENT units as equivalent", () => {
  assert.equal(unitsAreEquivalent("KRW", "PERCENT"), false);
  assert.equal(unitsAreEquivalent("원", "%"), false);
  assert.equal(unitsAreEquivalent("SHARES", "KRW"), false);
  assert.equal(unitsAreEquivalent("KRW", null), false);
});
