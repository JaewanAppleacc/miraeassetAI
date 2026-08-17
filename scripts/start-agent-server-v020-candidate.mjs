#!/usr/bin/env node
// Turn L2 item 5: NOT domain/runtime/configured-seed-runtime.mjs. That
// singleton intentionally still hardcodes seed-company-directory.v0.1.* --
// Turn K/L2 forbid repointing the live production Runtime at v0.20 this
// Turn. This script exists purely so the v0.20 CANDIDATE bundle (which
// ships ONLY seed-company-directory.v0.2.approved.*, per Turn K item F's
// byte-equivalent promotion) can be verified end-to-end: it constructs
// the SAME unmodified Runtime code path (createSeedThinRunner via
// createManagedSeedThinRuntime, createNodeAgentServer) with explicit v0.2
// config injected here rather than in the production singleton.
//
// Used exclusively by
// tests/seed-release-isolated-deployment-candidate.test.mjs. Never
// imported by app/answer/route.ts or any other production entry point.
import path from "node:path";
import { createNodeAgentServer } from "../domain/runtime/node-agent-server.mjs";
import { createManagedSeedThinRuntime } from "../domain/runtime/seed-thin-runner.mjs";

const root = path.resolve(process.cwd(), process.env.SEED_RUNTIME_ROOT ?? ".");
const EXPECTED_RELEASE_ID = "seed-release-v0.19";
const EXPECTED_APPROVED_REVISION = "seed-structured-artifacts-v0.6";

const runtime = createManagedSeedThinRuntime({
  root,
  structuredManifestPath: path.resolve(root, "work/domain-seed/seed-structured-artifacts.v0.6.manifest.json"),
  canonicalReleaseManifestPath: path.resolve(root, "domain/releases/seed-release.v0.19.manifest.json"),
  planPath: path.resolve(root, "work/domain-seed/seed-thin-flow-plans.v0.6.jsonl"),
  planManifestPath: path.resolve(root, "work/domain-seed/seed-thin-flow-plans.v0.6.manifest.json"),
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
  console.log(`Agent API (v0.20 CANDIDATE config injection -- see this file's header) listening on http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
