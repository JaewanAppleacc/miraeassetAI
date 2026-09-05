import test from "node:test";
import assert from "node:assert/strict";
import {
  validatePopulationTemplate,
  PopulationGuardError,
  EXPECTED_POPULATION_PACKET_COUNT,
} from "../domain/agent-comparison/four-arm-ac/alternate-node-sensitivity-population-guard.mjs";
import { buildSyntheticPopulationTemplate } from "../domain/agent-comparison/four-arm-ac/alternate-node-sensitivity-fixture.mjs";

test("accepts a well-formed full-batch population template and derives packet ids from it", () => {
  const population = buildSyntheticPopulationTemplate(EXPECTED_POPULATION_PACKET_COUNT);
  const result = validatePopulationTemplate(population.bytes);
  assert.equal(result.packet_count, EXPECTED_POPULATION_PACKET_COUNT);
  assert.equal(result.population_scope, "ALL_A_B_C_D_FULL_BATCH");
  assert.equal(result.packet_ids.length, EXPECTED_POPULATION_PACKET_COUNT);
  assert.equal(new Set(result.packet_ids).size, EXPECTED_POPULATION_PACKET_COUNT);
});

test("rejects a population template scoped to less than the full A/B/C/D batch", () => {
  const population = buildSyntheticPopulationTemplate(EXPECTED_POPULATION_PACKET_COUNT, { scope: "SINGLE_ARM_ONLY" });
  assert.throws(
    () => validatePopulationTemplate(population.bytes),
    (error) => error instanceof PopulationGuardError && error.code === "POPULATION_GUARD_PARTIAL_POPULATION_REJECTED",
  );
});

test("rejects a population template restricted to the motivating packets only", () => {
  const population = buildSyntheticPopulationTemplate(6, { scope: "MOTIVATING_PACKETS_ONLY" });
  assert.throws(
    () => validatePopulationTemplate(population.bytes),
    (error) => error instanceof PopulationGuardError && error.code === "POPULATION_GUARD_PARTIAL_POPULATION_REJECTED",
  );
});

test("rejects a population template with a packet count other than the frozen full-batch count", () => {
  const population = buildSyntheticPopulationTemplate(6);
  assert.throws(
    () => validatePopulationTemplate(population.bytes),
    (error) => error instanceof PopulationGuardError && error.code === "POPULATION_GUARD_PACKET_COUNT_MISMATCH",
  );
});

test("rejects a wrong reason value", () => {
  const population = buildSyntheticPopulationTemplate(EXPECTED_POPULATION_PACKET_COUNT, { reason: "claim_text_not_in_node" });
  assert.throws(
    () => validatePopulationTemplate(population.bytes),
    (error) => error instanceof PopulationGuardError && error.code === "POPULATION_GUARD_REASON_MISMATCH",
  );
});

test("rejects duplicate packet ids within the template", () => {
  const population = buildSyntheticPopulationTemplate(EXPECTED_POPULATION_PACKET_COUNT);
  const tampered = JSON.parse(population.bytes.toString("utf8"));
  tampered.resolutions[1] = { ...tampered.resolutions[1], packet_id: tampered.resolutions[0].packet_id };
  const bytes = Buffer.from(JSON.stringify(tampered), "utf8");
  assert.throws(
    () => validatePopulationTemplate(bytes),
    (error) => error instanceof PopulationGuardError && error.code === "POPULATION_GUARD_DUPLICATE_PACKET_ID",
  );
});

test("rejects arm/rank/score/winner/candidate leakage anywhere in the template", () => {
  const population = buildSyntheticPopulationTemplate(EXPECTED_POPULATION_PACKET_COUNT);
  const tampered = JSON.parse(population.bytes.toString("utf8"));
  tampered.resolutions[0].nested = { winner: "A" };
  const bytes = Buffer.from(JSON.stringify(tampered), "utf8");
  assert.throws(
    () => validatePopulationTemplate(bytes),
    (error) => error instanceof PopulationGuardError && error.code === "POPULATION_GUARD_FORBIDDEN_FIELD",
  );
});

test("rejects owner_confirmed=true on a population template", () => {
  const population = buildSyntheticPopulationTemplate(EXPECTED_POPULATION_PACKET_COUNT);
  const tampered = JSON.parse(population.bytes.toString("utf8"));
  tampered.owner_confirmed = true;
  const bytes = Buffer.from(JSON.stringify(tampered), "utf8");
  assert.throws(
    () => validatePopulationTemplate(bytes),
    (error) => error instanceof PopulationGuardError && error.code === "POPULATION_GUARD_OWNER_CONFIRMED_FORBIDDEN",
  );
});

test("rejects malformed JSON and non-object payloads", () => {
  assert.throws(
    () => validatePopulationTemplate(Buffer.from("not json", "utf8")),
    (error) => error instanceof PopulationGuardError && error.code === "POPULATION_GUARD_NOT_JSON",
  );
  assert.throws(
    () => validatePopulationTemplate(Buffer.from("[]", "utf8")),
    (error) => error instanceof PopulationGuardError && error.code === "POPULATION_GUARD_NOT_OBJECT",
  );
});
