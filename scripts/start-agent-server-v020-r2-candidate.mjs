#!/usr/bin/env node
// Turn M8 Section 12: analogous to scripts/start-agent-server-v020-candidate.mjs
// (that one targets the Turn L2 v0.20 bundle -- Fact v0.7/Coverage v0.6/
// Plan v0.6/Company Directory v0.2, structured-artifacts v0.6, v0.19
// manifest) but injects THIS Turn's v0.20-r2.candidate bundle config
// instead -- Fact v0.8/Coverage v0.7/Evidence v0.9/merged Owner decision
// v0.10/clean Plan v0.12 (Plan v0.6 lineage, no sub_request_authority),
// structured-artifacts v0.7, seed-release.v0.20-r2.candidate.manifest.json.
//
// NOT domain/runtime/configured-seed-runtime.mjs -- that singleton still
// points at v0.19 and is not touched by this Turn. Used exclusively by
// tests/seed-release-v020-r2-candidate-isolated-deployment.test.mjs.
import path from "node:path";
import { createNodeAgentServer } from "../domain/runtime/node-agent-server.mjs";
import { createManagedSeedThinRuntime } from "../domain/runtime/seed-thin-runner.mjs";

const root = path.resolve(process.cwd(), process.env.SEED_RUNTIME_ROOT ?? ".");
const CANDIDATE_REVISION = process.env.SEED_V020_CANDIDATE_REVISION === "r2" ? "r2" : "r3";
const PLAN_REVISION = CANDIDATE_REVISION === "r3" ? "v0.13" : "v0.12";
const EXPECTED_RELEASE_ID = `seed-release-v0.20-${CANDIDATE_REVISION}-candidate`;
const EXPECTED_APPROVED_REVISION = "seed-structured-artifacts-v0.7";

const runtime = createManagedSeedThinRuntime({
  root,
  structuredManifestPath: path.resolve(root, "work/domain-seed/seed-structured-artifacts.v0.7.manifest.json"),
  canonicalReleaseManifestPath: path.resolve(root, `domain/releases/seed-release.v0.20-${CANDIDATE_REVISION}.candidate.manifest.json`),
  planPath: path.resolve(root, `work/domain-seed/seed-thin-flow-plans.${PLAN_REVISION}.clean.candidate.jsonl`),
  planManifestPath: path.resolve(root, `work/domain-seed/seed-thin-flow-plans.${PLAN_REVISION}.clean.candidate.manifest.json`),
  expectedReleaseId: EXPECTED_RELEASE_ID,
  expectedApprovedRevision: EXPECTED_APPROVED_REVISION,
  requireOwnerBatchDecision: true,
  requireCompanyDirectory: true,
  companyDirectoryArtifactPath: path.resolve(root, "work/domain-seed/seed-company-directory.v0.2.approved.jsonl"),
  companyDirectoryManifestPath: path.resolve(root, "work/domain-seed/seed-company-directory.v0.2.approved.manifest.json"),
  companyDirectoryOwnerDecisionPath: path.resolve(root, "work/domain-seed/seed-company-directory-owner-decision.v0.2.approved.json"),
});

const host = process.env.AGENT_HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new TypeError("PORT must be an integer from 1 to 65535");
}

const server = createNodeAgentServer({ runtime });
server.listen(port, host, () => {
  console.log(`Agent API (v0.20-${CANDIDATE_REVISION} CANDIDATE config injection -- see this file's header) listening on http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
