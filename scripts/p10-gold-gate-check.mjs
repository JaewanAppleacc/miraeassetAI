#!/usr/bin/env node
// Turn P10 / F: read-only Gold-gate check. NEVER opens Gold question/answer
// content -- this script only checks for the EXISTENCE of the specific
// artifacts this Turn's brief names as gate conditions (a file-existence /
// npm-script-membership check), never their contents. If any condition is
// unmet, the correct, honest outcome is CHUNKING_COMPARISON_READY_PENDING_
// VALIDATED_DEV_GOLD -- DEV/DEV_CHECK/HOLDOUT are never touched by this
// script or any other P10 script.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

function fileExists(relPath) {
  return existsSync(path.join(ROOT, relPath));
}

function testListedInDomainSuite(testFileName) {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const testDomainCmd = pkg.scripts?.["test:domain"] ?? "";
  return testDomainCmd.includes(testFileName);
}

const checks = [
  {
    id: "gold_300_owner_review_test_exists",
    description: "tests/gold-300-owner-review-v0.2-v04201.test.mjs exists",
    pass: fileExists("tests/gold-300-owner-review-v0.2-v04201.test.mjs"),
  },
  {
    id: "author_a_gold_v02_120_of_120",
    description: "A named, dedicated AUTHOR_A Gold v0.2 validator (120/120) artifact exists",
    // No file/script in this repo is named or scoped as an AUTHOR_A Gold
    // v0.2 120-item validator. AUTHOR_A/AUTHOR_B appear ONLY as anchor-
    // allocation author-assignment roles (domain/evaluation/anchor-
    // allocation-builder.mjs), not a pass/fail Gold validator.
    pass: false,
  },
  {
    id: "author_b_87_of_87",
    description: "A named, dedicated AUTHOR_B validator (87/87) artifact exists",
    pass: false,
  },
  {
    id: "gold_207_integration_validator",
    description: "A 'Gold 207' integration validator (real-data 207/207) exists",
    pass: false,
  },
  {
    id: "canonical_owner_decision_sha_pinned",
    description: "A canonical Owner decision SHA is pinned as the active selection-rule pin for THIS Turn's Flow/chunking selection",
    pass: false,
  },
  {
    id: "n4_24_not_blocked_author_a_schema_incompatible",
    description: "An N4.24 milestone status exists and is not BLOCKED_AUTHOR_A_SCHEMA_INCOMPATIBLE",
    // No file, test, or status record in this repo is named/labelled
    // N4.24 or BLOCKED_AUTHOR_A_SCHEMA_INCOMPATIBLE -- the milestone this
    // condition refers to does not exist in this repo's current state, so
    // it cannot be confirmed "no longer blocked" and is treated as unmet.
    pass: false,
  },
];

const allPass = checks.every((c) => c.pass);

const result = {
  schema_version: "0.1.0",
  checked_at: new Date().toISOString(),
  checks,
  gate_status: allPass ? "GREEN" : "RED",
  outcome: allPass ? "PROCEED_TO_DEV_EVALUATION" : "CHUNKING_COMPARISON_READY_PENDING_VALIDATED_DEV_GOLD",
  note: "This check reads ONLY file-existence and package.json script membership -- it never opens any Gold question/answer/citation file. Current repo state (CLAUDE.md section 14, 'Current implementation status') independently confirms Seed Gold and the 300-item DEV/DEV_CHECK/HOLDOUT split are not yet finalized in this repo.",
};

console.log(JSON.stringify(result, null, 2));
if (!allPass) process.exitCode = 0; // RED is an expected, correctly-detected outcome, not a script failure
