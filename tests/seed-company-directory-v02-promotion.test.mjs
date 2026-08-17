// Turn K item F: the v0.2 "approved revision" Company Directory promotion
// must be byte-equivalent to the v0.1 candidate in every semantic field
// (corp_code/corp_name/listed_name), and must never touch the v0.1 files.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promoteSeedCompanyDirectoryV02 } from "../scripts/promote-seed-company-directory-v02.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

const V01_ARTIFACT_SHA256 = "6d91c4a8dcef9f7953d9e2797ab3e346dec748882161108b52677ed1fec16b3a";
const V01_MANIFEST_SHA256 = "64e6d49e26325fc99396a28f465ff6e4da2bb9054b56bff94550f3b8855c36e0";
const V01_DECISION_SHA256 = "2d8766ba4c5c1da42758b7823feca96cbbab58e844dac6e68c580709f5c22a20";

test("promotion never writes to the v0.1 candidate artifact/manifest/decision -- their real bytes are unchanged", async () => {
  await promoteSeedCompanyDirectoryV02({ writeOutputs: false }); // dry run to validate the source is still intact
  const [artifact, manifest, decision] = await Promise.all([
    readFile(path.join(REPO, "work/domain-seed/seed-company-directory.v0.1.candidate.jsonl")),
    readFile(path.join(REPO, "work/domain-seed/seed-company-directory.v0.1.candidate.manifest.json")),
    readFile(path.join(REPO, "work/domain-seed/seed-company-directory-owner-decision.v0.1.approved.json")),
  ]);
  assert.equal(sha256(artifact), V01_ARTIFACT_SHA256);
  assert.equal(sha256(manifest), V01_MANIFEST_SHA256);
  assert.equal(sha256(decision), V01_DECISION_SHA256);
});

test("promoted v0.2 artifact bytes are byte-identical to the v0.1 candidate (verbatim copy, not a re-derivation)", async () => {
  const result = await promoteSeedCompanyDirectoryV02({ writeOutputs: false });
  assert.equal(result.artifact_sha256, V01_ARTIFACT_SHA256);
});

test("every v0.2 record's corp_code/corp_name/listed_name matches the corresponding v0.1 record exactly, field by field", async () => {
  const [v01Text] = await Promise.all([
    readFile(path.join(REPO, "work/domain-seed/seed-company-directory.v0.1.candidate.jsonl"), "utf8"),
  ]);
  const result = await promoteSeedCompanyDirectoryV02({ writeOutputs: false });
  const v02Text = result.generated.artifact_bytes.toString("utf8");
  const v01Records = v01Text.trim().split("\n").map((l) => JSON.parse(l));
  const v02Records = v02Text.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(v02Records.length, v01Records.length);
  for (let i = 0; i < v01Records.length; i++) {
    assert.deepEqual(
      { corp_code: v02Records[i].corp_code, corp_name: v02Records[i].corp_name, listed_name: v02Records[i].listed_name },
      { corp_code: v01Records[i].corp_code, corp_name: v01Records[i].corp_name, listed_name: v01Records[i].listed_name },
    );
  }
});

test("v0.2 manifest declares status APPROVED_REVISION (never CANDIDATE) and pins promoted_from back to the real v0.1 artifact/manifest hashes", async () => {
  const result = await promoteSeedCompanyDirectoryV02({ writeOutputs: false });
  const manifest = result.generated.manifest;
  assert.equal(manifest.status, "APPROVED_REVISION");
  assert.equal(manifest.promoted_from.artifact_sha256, V01_ARTIFACT_SHA256);
  assert.equal(manifest.promoted_from.manifest_sha256, V01_MANIFEST_SHA256);
});

test("v0.2 decision is APPROVED, reuses the v0.1 independent verification report unchanged, and pins promoted_from_decision back to the real v0.1 decision hash", async () => {
  const result = await promoteSeedCompanyDirectoryV02({ writeOutputs: false });
  const decision = result.generated.decision;
  const v01Decision = JSON.parse(await readFile(path.join(REPO, "work/domain-seed/seed-company-directory-owner-decision.v0.1.approved.json"), "utf8"));
  assert.equal(decision.owner_disposition, "APPROVED");
  assert.equal(decision.reviewer, "최재완");
  assert.equal(decision.independent_verification_report_path, v01Decision.independent_verification_report_path);
  assert.equal(decision.independent_verification_report_sha256, v01Decision.independent_verification_report_sha256);
  assert.equal(decision.promoted_from_decision.sha256, V01_DECISION_SHA256);
  assert.equal(decision.artifact_sha256, sha256(result.generated.artifact_bytes));
  assert.equal(decision.manifest_sha256, sha256(result.generated.manifest_bytes));
});

test("v0.2 decision's declared record_count matches the actual promoted record count (70)", async () => {
  const result = await promoteSeedCompanyDirectoryV02({ writeOutputs: false });
  const decision = result.generated.decision;
  assert.equal(decision.record_count, 70);
  assert.equal(result.record_count, 70);
});
