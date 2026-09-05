import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildAlternateNodePopulation } from "../scripts/p11f0-fourarm-alternate-node-population.mjs";

async function withDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fourarm-alt-node-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function packet(dir, id, body = {}) {
  const value = {
    packet_id: id,
    reason: "duplicate_evidence_different_node",
    question_id: "opaque-question",
    slot_name: "opaque-slot",
    ...body,
  };
  await writeFile(path.join(dir, `${id}.json`), `${JSON.stringify(value)}\n`);
}

test("builds the complete sorted duplicate-node population with neutral decisions", () => withDir(async (dir) => {
  await packet(dir, "u-bbbbbbbbbbbb");
  await packet(dir, "u-aaaaaaaaaaaa");
  await writeFile(path.join(dir, "u-cccccccccccc.json"), JSON.stringify({
    packet_id: "u-cccccccccccc",
    reason: "claim_text_not_in_node",
  }));
  const out = await buildAlternateNodePopulation(dir);
  assert.equal(out.packet_count, 2);
  assert.deepEqual(out.resolutions.map((entry) => entry.packet_id), [
    "u-aaaaaaaaaaaa",
    "u-bbbbbbbbbbbb",
  ]);
  assert.ok(out.resolutions.every((entry) => entry.classification === "UNKNOWN"));
  assert.ok(out.resolutions.every((entry) => entry.sensitivity_outcome === "PENDING_REVIEW"));
  assert.equal(out.owner_confirmed, false);
}));

test("fails closed if packet filename and embedded id differ", () => withDir(async (dir) => {
  await packet(dir, "u-aaaaaaaaaaaa", { packet_id: "u-bbbbbbbbbbbb" });
  await assert.rejects(
    () => buildAlternateNodePopulation(dir),
    /PACKET_ID_MISMATCH/,
  );
}));

test("fails closed on arm, rank, score, winner, or candidate leakage", async () => {
  for (const [key, value] of [
    ["arm", "A"],
    ["rank", 1],
    ["score", 0.9],
    ["winner", "A"],
    ["candidate", true],
  ]) {
    await withDir(async (dir) => {
      await packet(dir, "u-aaaaaaaaaaaa", { nested: { [key]: value } });
      await assert.rejects(
        () => buildAlternateNodePopulation(dir),
        /ARM_BLINDNESS_VIOLATION/,
      );
    });
  }
});

test("fails closed when no duplicate-node packets exist", () => withDir(async (dir) => {
  await writeFile(path.join(dir, "u-aaaaaaaaaaaa.json"), JSON.stringify({
    packet_id: "u-aaaaaaaaaaaa",
    reason: "claim_text_not_in_node",
  }));
  await assert.rejects(
    () => buildAlternateNodePopulation(dir),
    /EMPTY_ALTERNATE_NODE_POPULATION/,
  );
}));
