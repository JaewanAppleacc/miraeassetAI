// Turn N4.10: synthetic-fixture unit tests for
// domain/evaluation/relation-closure-priority-wave-selection.mjs. These
// fixtures deliberately produce a UNION SIZE DIFFERENT from the real
// corpus's 13, proving the module computes from input, never a hardcoded
// constant.
import test from "node:test";
import assert from "node:assert/strict";
import { selectPriorityWave1 } from "../domain/evaluation/relation-closure-priority-wave-selection.mjs";

function row(id, { split = false, author = false, decisive = false } = {}) {
  return { relation_candidate_id: id, direct_cross_split_edge: split, direct_cross_author_edge: author, individually_decisive: decisive };
}

test("selectPriorityWave1: a row satisfying NONE of the three conditions is excluded", () => {
  const result = selectPriorityWave1({ classifications: [row("r1")] });
  assert.equal(result.unionCount, 0);
  assert.deepEqual(result.relationCandidateIds, []);
});

test("selectPriorityWave1: each condition alone includes its row exactly once", () => {
  const classifications = [row("split-only", { split: true }), row("author-only", { author: true }), row("decisive-only", { decisive: true }), row("none")];
  const result = selectPriorityWave1({ classifications });
  assert.equal(result.unionCount, 3);
  assert.deepEqual(result.relationCandidateIds, ["author-only", "decisive-only", "split-only"]);
  assert.deepEqual(result.distribution, { DIRECT_CROSS_SPLIT_EDGE: 1, DIRECT_CROSS_AUTHOR_EDGE: 1, INDIVIDUALLY_DECISIVE: 1 });
  assert.equal(result.multiConditionCount, 0);
});

test("selectPriorityWave1: a row satisfying 2 or 3 conditions still appears exactly ONCE in the union, and is counted as multi-condition", () => {
  const classifications = [row("multi", { split: true, decisive: true }), row("triple", { split: true, author: true, decisive: true }), row("single", { split: true })];
  const result = selectPriorityWave1({ classifications });
  assert.equal(result.unionCount, 3);
  assert.deepEqual(new Set(result.relationCandidateIds), new Set(["multi", "triple", "single"]));
  assert.equal(result.multiConditionCount, 2);
  assert.deepEqual(new Set(result.multiConditionRelationCandidateIds), new Set(["multi", "triple"]));
  assert.deepEqual(result.reasonsById.get("triple"), ["DIRECT_CROSS_SPLIT_EDGE", "DIRECT_CROSS_AUTHOR_EDGE", "INDIVIDUALLY_DECISIVE"]);
});

test("selectPriorityWave1: reproduces the REAL corpus's known contract shape (4/0/12, 3 multi-condition, union 13) when fed an equivalent synthetic distribution", () => {
  // 12 individually-decisive rows; 3 of them are ALSO direct-cross-split
  // (multi-condition overlap), plus 1 more split-only row not otherwise in
  // the decisive set -- distribution: split=4 (3 shared + 1 own), decisive=12,
  // author=0, union = 12 + 1 (the non-overlapping split row) = 13.
  const classifications = Array.from({ length: 12 }, (_, i) => row(`decisive${i}`, { decisive: true }));
  classifications[0].direct_cross_split_edge = true;
  classifications[1].direct_cross_split_edge = true;
  classifications[2].direct_cross_split_edge = true;
  classifications.push(row("split-only", { split: true }));
  const result = selectPriorityWave1({ classifications });
  assert.equal(result.distribution.DIRECT_CROSS_SPLIT_EDGE, 4);
  assert.equal(result.distribution.INDIVIDUALLY_DECISIVE, 12);
  assert.equal(result.unionCount, 13);
  assert.equal(result.multiConditionCount, 3);
});

test("selectPriorityWave1: never mutates or hardcodes -- a completely different-sized synthetic input produces a completely different union size (no hidden 13)", () => {
  const classifications = Array.from({ length: 50 }, (_, i) => row(`r${i}`, { split: i % 5 === 0 }));
  const result = selectPriorityWave1({ classifications });
  assert.equal(result.unionCount, 10); // every 5th row out of 50 = 10
  assert.notEqual(result.unionCount, 13);
});

test("selectPriorityWave1: order independence -- shuffling classification input order produces the identical sorted union and distribution", () => {
  const classifications = [row("a", { split: true }), row("b", { decisive: true }), row("c", { author: true }), row("d")];
  const shuffled = [classifications[3], classifications[1], classifications[2], classifications[0]];
  const r1 = selectPriorityWave1({ classifications });
  const r2 = selectPriorityWave1({ classifications: shuffled });
  assert.deepEqual(r1.relationCandidateIds, r2.relationCandidateIds);
  assert.deepEqual(r1.distribution, r2.distribution);
});
