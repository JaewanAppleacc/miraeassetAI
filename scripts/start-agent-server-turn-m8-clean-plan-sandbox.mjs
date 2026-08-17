// Turn M8 Section 7: a TEST-ONLY entrypoint for the clean-Plan Candidate
// Runtime integration verification (wire r12). Never imports
// domain/runtime/configured-seed-runtime.mjs (untouched) -- constructs
// its own createManagedSeedThinRuntime directly, pointed at the Turn M8
// sandbox release manifest/decision, which binds structured-artifacts
// v0.7 (unchanged from Turn M7) + the NEW clean Plan v0.12.
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

const cleanPlanSandboxRuntime = createManagedSeedThinRuntime({
  root: REPO,
  structuredManifestPath: path.resolve(REPO, "work/domain-seed/seed-structured-artifacts.v0.7.manifest.json"),
  canonicalReleaseManifestPath: path.resolve(REPO, "work/domain-seed/seed-release-turn-m8-clean-plan-sandbox.manifest.json"),
  planPath: path.resolve(REPO, "work/domain-seed/seed-thin-flow-plans.v0.12.clean.candidate.jsonl"),
  planManifestPath: path.resolve(REPO, "work/domain-seed/seed-thin-flow-plans.v0.12.clean.candidate.manifest.json"),
  companyDirectoryArtifactPath: path.resolve(REPO, "work/domain-seed/seed-company-directory.v0.1.candidate.jsonl"),
  companyDirectoryManifestPath: path.resolve(REPO, "work/domain-seed/seed-company-directory.v0.1.candidate.manifest.json"),
  companyDirectoryOwnerDecisionPath: path.resolve(REPO, "work/domain-seed/seed-company-directory-owner-decision.v0.1.approved.json"),
  expectedCompanyDirectoryOwnerDecisionSha256: "2d8766ba4c5c1da42758b7823feca96cbbab58e844dac6e68c580709f5c22a20",
  requireCompanyDirectory: true,
});

const server = createNodeAgentServer({ runtime: cleanPlanSandboxRuntime });
server.listen(port, host, () => {
  console.log(`Turn M8 clean-Plan Candidate sandbox agent API listening on http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
