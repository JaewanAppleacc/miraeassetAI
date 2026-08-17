// Turn M capability C: generic Korean particle selection, tested against
// synthetic words only (no Seed company names/question content).
import assert from "node:assert/strict";
import test from "node:test";
import {
  topicParticle, subjectParticle, objectParticle, conjunctionParticle, directionParticle,
  withTopic, withConjunction, withDirection,
} from "../domain/flows/synthesis/korean-particles.mjs";

test("directionParticle: 으로/로 selected by batchim presence, generically for any word", () => {
  assert.equal(directionParticle("매출액"), "으로"); // 액 has batchim (ㄱ)
  assert.equal(directionParticle("영업이익"), "으로"); // 익 has batchim (ㄱ)
  assert.equal(directionParticle("차이"), "로"); // 이 has no batchim
  assert.equal(directionParticle("가나"), "로");
});

test("conjunctionParticle: 와/과 selected by batchim presence", () => {
  assert.equal(conjunctionParticle("사과"), "와"); // 과 has no batchim
  assert.equal(conjunctionParticle("매출액"), "과"); // 액 has batchim
});

test("topicParticle/subjectParticle/objectParticle: 은/는, 이/가, 을/를", () => {
  assert.equal(topicParticle("매출액"), "은");
  assert.equal(topicParticle("차이"), "는");
  assert.equal(subjectParticle("매출액"), "이");
  assert.equal(subjectParticle("차이"), "가");
  assert.equal(objectParticle("매출액"), "을");
  assert.equal(objectParticle("차이"), "를");
});

test("withDirection/withConjunction/withTopic: convenience helpers append the correct particle to the word itself", () => {
  assert.equal(withDirection("매출액"), "매출액으로");
  assert.equal(withDirection("차이"), "차이로");
  assert.equal(withConjunction("매출액"), "매출액과");
  assert.equal(withTopic("차이"), "차이는");
});

test("non-Hangul-ending words (numbers, Latin) fall back to the no-batchim form without throwing", () => {
  assert.equal(directionParticle("100"), "로");
  assert.equal(directionParticle("ABC"), "로");
  assert.doesNotThrow(() => directionParticle(""));
  assert.doesNotThrow(() => directionParticle(null));
  assert.doesNotThrow(() => directionParticle(undefined));
});

test("trailing whitespace in the word does not break batchim detection", () => {
  assert.equal(directionParticle("매출액 "), "으로");
});

test("parenthesized units and trailing punctuation use the last pronounceable Hangul syllable", () => {
  assert.equal(topicParticle("해지금액(원)"), "은");
  assert.equal(topicParticle("매출액대비(%)"), "는");
  assert.equal(subjectParticle("계약금액(원):"), "이");
});
