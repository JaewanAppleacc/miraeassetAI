import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  OwnerReviewFullTextError,
  verifyOwnerReviewFullText,
} from "../domain/agent-comparison/four-arm-ac/four-arm-owner-review-fulltext-guard.mjs";

const hash = (text) => createHash("sha256").update(text).digest("hex");

function fixture() {
  const fullText = "x".repeat(500);
  return {
    template: [["u-aaaaaaaaaaaa", { classification: "UNKNOWN" }]],
    frozenPackets: {
      "u-aaaaaaaaaaaa": {
        question_id: "q1", doc_id: "d1", node_index: 7, chunk_text: fullText.slice(0, 400),
      },
    },
    reviews: [{
      packet_id: "u-aaaaaaaaaaaa",
      retrieved: { document_id: "d1", node_index: 7, chunk_text: fullText },
    }],
    hydratedRows: [{
      question_id: "q1",
      results: [{ chunk_id: "chunk-1", doc_id: "d1", node_index: 7, text: fullText, chunk_text_sha256: hash(fullText) }],
    }],
  };
}

test("accepts only a complete exact SHA-verified hydrated text", () => {
  const result = verifyOwnerReviewFullText(fixture());
  assert.equal(result.ok, true);
  assert.equal(result.packet_count, 1);
  assert.equal(result.full_text_verified_count, 1);
  assert.equal(result.scorer_400_char_truncation_confirmed_count, 1);
});

test("rejects the frozen scorer's 400-character export as review evidence", () => {
  const input = fixture();
  input.reviews[0].retrieved.chunk_text = input.frozenPackets["u-aaaaaaaaaaaa"].chunk_text;
  assert.throws(
    () => verifyOwnerReviewFullText(input),
    (error) => error instanceof OwnerReviewFullTextError && error.code === "OWNER_REVIEW_HYDRATED_MATCH_MISMATCH",
  );
});

test("fails closed on a hydrated-text SHA mismatch", () => {
  const input = fixture();
  input.hydratedRows[0].results[0].chunk_text_sha256 = "0".repeat(64);
  assert.throws(
    () => verifyOwnerReviewFullText(input),
    (error) => error instanceof OwnerReviewFullTextError && error.code === "OWNER_REVIEW_TEXT_SHA_MISMATCH",
  );
});

test("deduplicates the same hydrated chunk returned by more than one arm", () => {
  const input = fixture();
  input.hydratedRows.push(structuredClone(input.hydratedRows[0]));
  const result = verifyOwnerReviewFullText(input);
  assert.equal(result.full_text_verified_count, 1);
});

test("rejects two distinct chunk identities even when their text is identical", () => {
  const input = fixture();
  const duplicate = structuredClone(input.hydratedRows[0]);
  duplicate.results[0].chunk_id = "chunk-2";
  input.hydratedRows.push(duplicate);
  assert.throws(
    () => verifyOwnerReviewFullText(input),
    (error) => error instanceof OwnerReviewFullTextError && error.code === "OWNER_REVIEW_HYDRATED_MATCH_MISMATCH",
  );
});

test("fails closed when the packet prefix and hydrated result differ", () => {
  const input = fixture();
  input.frozenPackets["u-aaaaaaaaaaaa"].chunk_text = "y".repeat(400);
  assert.throws(
    () => verifyOwnerReviewFullText(input),
    (error) => error instanceof OwnerReviewFullTextError && error.code === "OWNER_REVIEW_PREFIX_MISMATCH",
  );
});

test("rejects arm, score, rank, and candidate fields from the review surface", () => {
  for (const key of ["arm", "score", "rank", "candidate"]) {
    const input = fixture();
    input.reviews[0][key] = "forbidden";
    assert.throws(
      () => verifyOwnerReviewFullText(input),
      (error) => error instanceof OwnerReviewFullTextError && error.code === "OWNER_REVIEW_NOT_ARM_BLIND",
    );
  }
});

test("requires exact equality with one hydrated result, not merely a matching prefix", () => {
  const input = fixture();
  const altered = `${input.reviews[0].retrieved.chunk_text}extra`;
  input.reviews[0].retrieved.chunk_text = altered;
  assert.throws(
    () => verifyOwnerReviewFullText(input),
    (error) => error instanceof OwnerReviewFullTextError && error.code === "OWNER_REVIEW_HYDRATED_MATCH_MISMATCH",
  );
});
