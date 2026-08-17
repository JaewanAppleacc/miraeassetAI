// Turn M7 Section 6: a TEST-ONLY entrypoint for Candidate Runtime
// integration verification. Never imports domain/runtime/configured-
// seed-runtime.mjs (left completely untouched) -- constructs its own
// createManagedSeedThinRuntime directly, pointed at the Turn M7 sandbox
// release manifest/decision (seed-release-turn-m7-candidate-sandbox.*)
// which in turn binds the Turn M7 structured manifest (v0.7, 87 VERIFIED
// facts) and Plan (v0.11.candidate). expectedReleaseId/
// expectedApprovedRevision/requireOwnerBatchDecision are all left at
// their no-op defaults (undefined/false) -- this is exactly the
// "fixture-driven tests, audits" caller shape the runtime module's own
// comments describe, never the production caller. Company Directory
// resolution is wired to the SAME already-approved artifacts production
// uses (unmodified this Turn) so entity names render realistically.
import { createNodeAgentServer } from "../domain/runtime/node-agent-server.mjs";
import { createManagedSeedThinRuntime } from "../domain/runtime/seed-thin-runner.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const host = process.env.AGENT_HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new TypeError("PORT must be an integer from 1 to 65535");
}

const candidateSandboxRuntime = createManagedSeedThinRuntime({
  root: REPO,
  structuredManifestPath: path.resolve(REPO, "work/domain-seed/seed-structured-artifacts.v0.7.manifest.json"),
  canonicalReleaseManifestPath: path.resolve(REPO, "work/domain-seed/seed-release-turn-m7-candidate-sandbox.manifest.json"),
  planPath: path.resolve(REPO, "work/domain-seed/seed-thin-flow-plans.v0.11.candidate.jsonl"),
  planManifestPath: path.resolve(REPO, "work/domain-seed/seed-thin-flow-plans.v0.11.candidate.manifest.json"),
  // expectedReleaseId / expectedApprovedRevision / requireOwnerBatchDecision
  // intentionally omitted (no-op defaults) -- this is a sandbox test
  // runtime, never a production release-identity claim.
  companyDirectoryArtifactPath: path.resolve(REPO, "work/domain-seed/seed-company-directory.v0.1.candidate.jsonl"),
  companyDirectoryManifestPath: path.resolve(REPO, "work/domain-seed/seed-company-directory.v0.1.candidate.manifest.json"),
  companyDirectoryOwnerDecisionPath: path.resolve(REPO, "work/domain-seed/seed-company-directory-owner-decision.v0.1.approved.json"),
  expectedCompanyDirectoryOwnerDecisionSha256: "2d8766ba4c5c1da42758b7823feca96cbbab58e844dac6e68c580709f5c22a20",
  requireCompanyDirectory: true,
});

const server = createNodeAgentServer({ runtime: candidateSandboxRuntime });
server.listen(port, host, () => {
  console.log(`Turn M7 Candidate sandbox agent API listening on http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
