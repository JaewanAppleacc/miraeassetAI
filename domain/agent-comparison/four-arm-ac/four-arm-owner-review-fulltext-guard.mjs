import { createHash } from "node:crypto";

export class OwnerReviewFullTextError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "OwnerReviewFullTextError";
    this.code = code;
  }
}

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

function fail(message, code) {
  throw new OwnerReviewFullTextError(message, code);
}

function forbiddenKeyPaths(value, path = "$") {
  const found = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => found.push(...forbiddenKeyPaths(item, `${path}[${index}]`)));
    return found;
  }
  if (!value || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (["arm", "arm_id", "arm_code", "score", "rank", "candidate"].includes(key)) found.push(childPath);
    found.push(...forbiddenKeyPaths(child, childPath));
  }
  return found;
}

function resultKey(questionId, result) {
  return JSON.stringify([questionId, result.doc_id, result.node_index]);
}

/**
 * Verifies that an Owner-review packet set uses the complete, previously
 * hydrated retrieval text. The frozen scorer's 400-character packet export is
 * accepted only as an identity prefix; it is never accepted as review evidence.
 */
export function verifyOwnerReviewFullText({ template, frozenPackets, reviews, hydratedRows }) {
  if (!Array.isArray(template) || !Array.isArray(reviews) || !Array.isArray(hydratedRows)) {
    fail("template, reviews, and hydratedRows must be arrays", "OWNER_REVIEW_INVALID_INPUT");
  }

  const templateIds = template.map((entry) => entry?.[0]);
  const reviewById = new Map(reviews.map((review) => [review?.packet_id, review]));
  if (reviewById.size !== reviews.length) fail("duplicate review packet_id", "OWNER_REVIEW_DUPLICATE_PACKET");
  if (templateIds.length !== reviews.length || templateIds.some((id) => !reviewById.has(id))) {
    fail("review packet ids do not exactly match the frozen template", "OWNER_REVIEW_PACKET_SET_MISMATCH");
  }

  const hydratedByKey = new Map();
  for (const row of hydratedRows) {
    for (const result of row.results ?? []) {
      const key = resultKey(row.question_id, result);
      const values = hydratedByKey.get(key) ?? [];
      values.push(result);
      hydratedByKey.set(key, values);
    }
  }

  let scorerTruncatedCount = 0;
  let fullTextCount = 0;
  const textLengths = [];
  for (const packetId of templateIds) {
    const review = reviewById.get(packetId);
    const frozen = frozenPackets[packetId];
    if (!frozen) fail(`${packetId}: frozen packet missing`, "OWNER_REVIEW_FROZEN_PACKET_MISSING");

    const text = review?.retrieved?.chunk_text;
    if (typeof text !== "string" || text.length === 0) {
      fail(`${packetId}: complete retrieved.chunk_text is required`, "OWNER_REVIEW_FULL_TEXT_MISSING");
    }
    const frozenText = frozen.chunk_text;
    if (typeof frozenText !== "string" || !text.startsWith(frozenText)) {
      fail(`${packetId}: frozen packet text is not a prefix of hydrated text`, "OWNER_REVIEW_PREFIX_MISMATCH");
    }

    const key = JSON.stringify([frozen.question_id, frozen.doc_id, frozen.node_index]);
    const candidates = hydratedByKey.get(key) ?? [];
    const exact = candidates.filter((candidate) => candidate.text === text);
    const exactIdentities = new Map(exact.map((candidate) => [
      JSON.stringify([candidate.chunk_id, candidate.chunk_text_sha256, candidate.text]),
      candidate,
    ]));
    if (exactIdentities.size !== 1) {
      fail(`${packetId}: expected exactly one unique exact hydrated result, got ${exactIdentities.size}`, "OWNER_REVIEW_HYDRATED_MATCH_MISMATCH");
    }
    const [exactResult] = exactIdentities.values();
    if (sha256(text) !== exactResult.chunk_text_sha256) {
      fail(`${packetId}: hydrated text SHA-256 mismatch`, "OWNER_REVIEW_TEXT_SHA_MISMATCH");
    }

    if (frozenText.length === 400 && text.length > frozenText.length) scorerTruncatedCount += 1;
    if (text.length > frozenText.length) fullTextCount += 1;
    textLengths.push(text.length);
  }

  const forbidden = forbiddenKeyPaths(reviews);
  if (forbidden.length) {
    fail(`arm-blind review contains forbidden fields: ${forbidden.join(", ")}`, "OWNER_REVIEW_NOT_ARM_BLIND");
  }
  if (fullTextCount !== reviews.length) {
    fail(`not every review replaced the scorer export with longer complete text (${fullTextCount}/${reviews.length})`, "OWNER_REVIEW_PARTIAL_HYDRATION");
  }

  return Object.freeze({
    ok: true,
    packet_count: reviews.length,
    full_text_verified_count: fullTextCount,
    scorer_400_char_truncation_confirmed_count: scorerTruncatedCount,
    min_full_text_length: Math.min(...textLengths),
    max_full_text_length: Math.max(...textLengths),
    review_content_sha256: sha256(JSON.stringify(reviews)),
  });
}
