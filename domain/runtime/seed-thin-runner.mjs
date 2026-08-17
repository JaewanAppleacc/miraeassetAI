import path from "node:path";
import { createSeedQuestionPlanStore } from "../adapters/seed-question-plan-store.mjs";
import { createSeedRuntimeServiceAdapters } from "../adapters/seed-runtime-service-adapters.mjs";
import { createThinStructuredFlow } from "../flows/thin-structured-flow.mjs";
import { runAgentFlow } from "./agent-runtime.mjs";
import { createNoFlowConnectedRunner } from "./no-flow-connected-runner.mjs";

const LIMITS = Object.freeze({ maxHcxCalls: 0, maxRetrievals: 0, maxToolCalls: 200, timeoutMs: 280000 });

export async function createSeedThinRunner({
  root = process.cwd(),
  structuredManifestPath = path.resolve(root, "work/domain-seed/seed-structured-artifacts.v0.1.manifest.json"),
  canonicalReleaseManifestPath = path.resolve(root, "domain/releases/seed-release.v0.11.manifest.json"),
  planPath = path.resolve(root, "work/domain-seed/seed-thin-flow-plans.v0.1.jsonl"),
  planManifestPath = path.resolve(root, "work/domain-seed/seed-thin-flow-plans.v0.1.manifest.json"),
  // Opt-in production anti-rollback policy, forwarded verbatim to
  // createSeedRuntimeServiceAdapters -- see that function's own doc
  // comment and assertExpectedReleaseIdentity. undefined/false by default
  // so callers that don't pass these (fixture-driven tests, audits) are
  // unaffected; domain/runtime/configured-seed-runtime.mjs is the one
  // caller that always sets them.
  expectedReleaseId,
  expectedApprovedRevision,
  requireOwnerBatchDecision = false,
  // Company Directory / CompanyResolver release binding -- forwarded
  // verbatim to createSeedRuntimeServiceAdapters (see that function's own
  // comment). Omitting companyDirectoryArtifactPath is a strict no-op.
  companyDirectoryArtifactPath,
  companyDirectoryManifestPath,
  companyDirectoryOwnerDecisionPath,
  expectedCompanyDirectoryOwnerDecisionSha256,
  requireCompanyDirectory = false,
} = {}) {
  // Sequenced, not parallel: createSeedRuntimeServiceAdapters is the ONLY
  // place that decides whether planPath/planManifestPath are authorized
  // (bound into the release decision -- see domain/adapters/
  // seed-runtime-service-adapters.mjs's "PLAN + CHAIN BINDING" header).
  // The plan store below opens authorizedRuntimeAssets' verified paths,
  // never the raw constructor arguments above -- so even if this
  // function's own caller (or an env-var override upstream) supplied a
  // mismatched plan, only a path that already passed the gate is ever
  // actually read as a plan.
  const { context, serviceAdapters, authorizedRuntimeAssets } = await createSeedRuntimeServiceAdapters({
    structuredManifestPath, canonicalReleaseManifestPath, planPath, planManifestPath, root,
    expectedReleaseId, expectedApprovedRevision, requireOwnerBatchDecision,
    companyDirectoryArtifactPath, companyDirectoryManifestPath, companyDirectoryOwnerDecisionPath,
    expectedCompanyDirectoryOwnerDecisionSha256, requireCompanyDirectory,
  });
  const planStore = await createSeedQuestionPlanStore({
    planPath: authorizedRuntimeAssets.planPath, manifestPath: authorizedRuntimeAssets.planManifestPath,
  });
  if (context.corpus_snapshot_id !== planStore.context.corpus_snapshot_id || context.fact_coverage_snapshot_id !== planStore.context.fact_coverage_snapshot_id) {
    throw new Error("question plan/runtime artifact snapshot mismatch");
  }
  const flow = createThinStructuredFlow();
  const fallback = createNoFlowConnectedRunner({ context });
  return async function runSeedThin(question, options = {}) {
    const plan = planStore.resolve(options.question_id, question, { signal: options.signal });
    if (!plan) return fallback(question, options);
    return runAgentFlow(
      flow,
      { question, question_id: options.question_id, plan: { ...plan, context } },
      { ...context, as_of_date: plan.as_of_date, signal: options.signal },
      LIMITS,
      serviceAdapters,
    );
  };
}

// Lazy wrapper for the API route. Construction/hash verification happens
// once on first request. Missing deployment artifacts never turn into an
// unhandled startup crash: the existing no-flow runner remains the honest
// fail-closed response until a complete pinned bundle is deployed.
export function createLazySeedThinRunner(options = {}) {
  let runnerPromise;
  const fallback = createNoFlowConnectedRunner();
  return async (question, requestOptions = {}) => {
    runnerPromise ??= createSeedThinRunner(options).catch(() => null);
    const runner = await runnerPromise;
    return runner ? runner(question, requestOptions) : fallback(question, requestOptions);
  };
}

// Operational wrapper: unlike createLazySeedThinRunner's intentionally
// minimal function-only API, this exposes a safe readiness state without
// exposing paths, stack traces, or initialization error messages.
export function createManagedSeedThinRuntime(options = {}) {
  let state = "IDLE";
  let runner = null;
  let initialization;
  const fallback = createNoFlowConnectedRunner();
  async function initialize() {
    initialization ??= (async () => {
      state = "INITIALIZING";
      try {
        runner = await createSeedThinRunner(options);
        state = "READY";
        return true;
      } catch {
        state = "FAILED";
        return false;
      }
    })();
    return initialization;
  }
  return Object.freeze({
    async run(question, requestOptions = {}) {
      const ready = await initialize();
      return ready ? runner(question, requestOptions) : fallback(question, requestOptions);
    },
    initialize,
    readiness() {
      return Object.freeze({
        status: state,
        ready: state === "READY",
        error_code: state === "FAILED" ? "SEED_RUNTIME_INIT_FAILED" : null,
      });
    },
  });
}
