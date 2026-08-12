// Evaluation Harness runner. Calls the deployed Agent's GET /answer over
// real HTTP only — never imports any Agent-internal Flow module. Gold
// loading, FinalResponse shape validation, and Usage Ledger accounting all
// import this repository's own current contracts as the single source of
// truth (domain/contracts.mjs, domain/runtime/evaluation-usage-ledger.mjs,
// domain/runtime/final-response-validator.mjs) rather than bundling private
// copies that could silently drift from the real thing.
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { loadGold } from "./gold-loader.mjs";
import { requestAnswer } from "./api-client.mjs";
import { scoreClosed } from "./metrics/closed-metric.mjs";
import { scoreOpen } from "./metrics/open-metric.mjs";
import { writeJson, writeJsonl } from "./result-writer.mjs";
import { appendEventLineDurable, acquireExclusiveLock, releaseExclusiveLock } from "./durable-ledger.mjs";
import { validateFinalResponse } from "../runtime/final-response-validator.mjs";
import { canUseSplit, appendUsageEvent, readLedgerFile } from "../runtime/evaluation-usage-ledger.mjs";
import { EVALUATION_SPLITS, RUN_PURPOSES, RUN_PURPOSE_TO_SPLITS, USAGE_KIND_TO_SPLIT } from "../contracts.mjs";

const ALL_SPLITS = Object.freeze(["SANDBOX", ...EVALUATION_SPLITS]);
// Derived from contracts.mjs's own USAGE_KIND_TO_SPLIT — never a second,
// hand-maintained copy of the same mapping.
const SPLIT_TO_USAGE_KIND = Object.freeze(
  Object.fromEntries(Object.entries(USAGE_KIND_TO_SPLIT).map(([kind, split]) => [split, kind]))
);
// SANDBOX now requires the same lifecycle_path+ledger_path wiring as
// DEV_CHECK/HOLDOUT: SANDBOX eligibility is itself proven by a validated,
// still-provisional lifecycle record (see gold-loader.mjs), and every
// SANDBOX exposure must still be reserved+durably persisted before any HTTP
// call, same as any other split.
const SPLITS_REQUIRING_LIFECYCLE_LEDGER = Object.freeze(["SANDBOX", "DEV_CHECK", "HOLDOUT"]);
const CONFIGURATION_SHA256 = /^[0-9a-f]{64}$/;
// A conventional full git commit SHA — the Usage Event schema itself only
// requires git_commit to be a string-or-null, but the Harness's own config
// validation holds run provenance to a stricter, unambiguous standard.
const GIT_COMMIT = /^[0-9a-f]{40}$/;
// All the statuses any metric result (Closed or Open) can carry — see
// metrics/closed-metric.mjs and metrics/open-metric.mjs.
const METRIC_STATUSES = Object.freeze(["PASS", "FAIL", "NOT_SCORED", "REVIEW_REQUIRED"]);

async function readLifecycle(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  return new Map((Array.isArray(value) ? value : [value]).map((v) => [v.assignment_id, v]));
}

function percentile(values, p) {
  const finite = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (!finite.length) return null;
  const sorted = [...finite].sort((a, b) => a - b);
  return sorted[Math.ceil(p * sorted.length) - 1];
}

function distribution(values) {
  return values.reduce((out, value) => {
    const key = value ?? "UNKNOWN";
    out[key] = (out[key] ?? 0) + 1;
    return out;
  }, {});
}

// Redacts anything that could carry a secret. Deliberately conservative:
// truncates and strips common credential keywords rather than trying to
// enumerate every possible header name. This is a second, independent layer
// on top of api-client.mjs's own refusal to surface raw fetch error detail.
function safeError(error) {
  return String(error ?? "")
    .replace(/authorization|bearer|secret|token|api[-_]?key/gi, "[REDACTED]")
    .slice(0, 500);
}

export function validateConfig(c) {
  const required = [
    "base_url",
    "answer_path",
    "question_parameter",
    "gold_path",
    "result_path",
    "summary_path",
    "split",
    "run_purpose",
    "timeout_ms",
    "concurrency",
    "configuration_sha256",
    "git_commit",
  ];
  const missing = required.filter((key) => c[key] === undefined || c[key] === "");
  if (missing.length) throw new Error(`missing config: ${missing.join(", ")}`);

  if (!ALL_SPLITS.includes(c.split)) {
    throw new Error(`invalid split: ${c.split} (must be one of ${ALL_SPLITS.join(", ")})`);
  }
  if (!RUN_PURPOSES.includes(c.run_purpose)) {
    throw new Error(`invalid run_purpose: ${c.run_purpose} (must be one of ${RUN_PURPOSES.join(", ")})`);
  }
  if (!RUN_PURPOSE_TO_SPLITS[c.run_purpose].includes(c.split)) {
    throw new Error(
      `run_purpose ${c.run_purpose} cannot execute against split ${c.split} (allowed: ${RUN_PURPOSE_TO_SPLITS[c.run_purpose].join(", ")})`
    );
  }
  if (!Number.isInteger(c.timeout_ms) || c.timeout_ms <= 0) {
    throw new Error("timeout_ms must be a positive integer");
  }
  if (!Number.isInteger(c.concurrency) || c.concurrency <= 0) {
    throw new Error("concurrency must be a positive integer");
  }
  if (!CONFIGURATION_SHA256.test(c.configuration_sha256)) {
    throw new Error("configuration_sha256 must be 64 lowercase hex characters");
  }
  if (!GIT_COMMIT.test(c.git_commit)) {
    throw new Error("git_commit must be a 40-character lowercase hex SHA");
  }
  if (SPLITS_REQUIRING_LIFECYCLE_LEDGER.includes(c.split)) {
    if (!c.lifecycle_path) throw new Error(`lifecycle_path is required for split ${c.split}`);
    if (!c.ledger_path) throw new Error(`ledger_path is required for split ${c.split}`);
  }
  // A half-configured lifecycle-only setup is never valid, for ANY split:
  // canUseSplit/appendUsageEvent gating is meaningless without somewhere
  // durable to record the reservations it produces.
  if (c.lifecycle_path && !c.ledger_path) {
    throw new Error("ledger_path is required whenever lifecycle_path is provided");
  }
  if (c.sandbox_allowlist !== undefined && !Array.isArray(c.sandbox_allowlist)) {
    throw new Error("sandbox_allowlist must be an array of question_ids when present");
  }

  const pathFields = ["gold_path", "lifecycle_path", "ledger_path", "result_path", "summary_path"].filter(
    (key) => c[key]
  );
  const resolved = pathFields.map((key) => [key, resolvePath(c[key])]);
  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      if (resolved[i][1] === resolved[j][1]) {
        throw new Error(`config paths must be distinct: ${resolved[i][0]} and ${resolved[j][0]} both resolve to ${resolved[i][1]}`);
      }
    }
  }
}

// Minimal serialized-write helper: every call to fn() is guaranteed to run
// only after the previous call's promise has settled. This protects THIS
// process's own concurrent workers from racing on the in-memory ledger
// snapshot; it does nothing for a second OS process, which is what the
// cross-process lock (acquireExclusiveLock, held for the whole run on
// DEV_CHECK/HOLDOUT) is for.
function createSerialQueue() {
  let tail = Promise.resolve();
  return function run(fn) {
    const result = tail.then(fn, fn);
    tail = result.then(
      () => {},
      () => {}
    );
    return result;
  };
}

// Tallies every metric result's top-level status across all scored items
// into the four canonical buckets, so the summary can never conflate "we
// scored it and it passed" with "we didn't score it" or "a human still
// needs to judge it."
function tallyMetricStatuses(results) {
  const tally = { metric_pass: 0, metric_fail: 0, not_scored: 0, review_required: 0 };
  for (const r of results) {
    for (const metric of Object.values(r.metric_results ?? {})) {
      const status = metric?.status;
      if (status === "PASS") tally.metric_pass++;
      else if (status === "FAIL") tally.metric_fail++;
      else if (status === "NOT_SCORED") tally.not_scored++;
      else if (status === "REVIEW_REQUIRED") tally.review_required++;
    }
  }
  return tally;
}

export async function runHarness(config) {
  validateConfig(config);
  const runId = config.run_id ?? randomUUID();

  const usesLedger = Boolean(config.lifecycle_path);
  const lifecycle = usesLedger ? await readLifecycle(config.lifecycle_path) : null;
  const gold = await loadGold(config.gold_path, config.split, {
    sandboxAllowlist: config.sandbox_allowlist ?? null,
    lifecycle,
  });

  // Any execution that touches a shared ledger file needs the cross-process
  // lock, not just the two budget-limited official splits: two independent
  // Harness processes racing on the SAME ledger_path (even for SANDBOX or
  // an opted-in DEV_TUNE run) can otherwise both read the same starting
  // hash-chain tail and each append an event whose previous_log_hash
  // points at that same tail -- a forked chain, not merely a duplicate
  // entry, and validateUsageLedger has no way to un-fork it after the fact.
  const needsExclusiveLock = usesLedger;
  const lockPath = needsExclusiveLock ? `${config.ledger_path}.lock` : null;
  const lockFd = needsExclusiveLock ? acquireExclusiveLock(lockPath, { timeoutMs: config.lock_timeout_ms ?? 5000 }) : null;

  try {
    return await executeRun(config, runId, gold, usesLedger, lifecycle);
  } finally {
    if (lockFd !== null) releaseExclusiveLock(lockFd, lockPath);
  }
}

async function executeRun(config, runId, gold, usesLedger, lifecycle) {
  let ledger = usesLedger && config.ledger_path ? readLedgerFile(config.ledger_path) : [];
  const usageKind = SPLIT_TO_USAGE_KIND[config.split];

  const lifecycleStates = new Map();
  if (usesLedger) {
    // Whole-run preflight: if ANY item is already blocked by lifecycle
    // state before this run has reserved anything, fail the entire run
    // before a single HTTP request is made for any item.
    for (const item of gold) {
      const state = lifecycle.get(item.question_id) ?? lifecycle.get(item.evaluation_group_id);
      if (!state) throw new Error(`missing lifecycle for ${item.question_id}`);
      const gate = canUseSplit({
        log: ledger,
        assignmentId: state.assignment_id,
        runId,
        lifecycleState: state,
        executedSplit: config.split,
        usageKind,
        runPurpose: config.run_purpose,
        configurationSha256: config.configuration_sha256,
        gitCommit: config.git_commit,
      });
      if (!gate.ok) throw new Error(`preflight ${item.question_id}: ${gate.code}: ${gate.message}`);
      lifecycleStates.set(item.question_id, state);
    }
  }

  const ledgerQueue = createSerialQueue();

  // Reserves this item's exposure BEFORE any HTTP request is made for it,
  // and durably (fsync'd — see durable-ledger.mjs) persists the reservation
  // to disk before returning. The reservation is always recorded with
  // runOutcome "FAILURE" — the Usage Event schema has no "pending"/
  // "reserved" outcome and the ledger is append-only (no event may be
  // edited after the fact, and the same run_id+assignment_id pair may
  // never be appended twice), so there is no safe way to "upgrade" this
  // event to SUCCESS once the real outcome is known. Per this module's own
  // documented policy, a DISTINCT run consumes its budget "regardless of
  // whether that run's outcome is later SUCCESS or FAILURE" — so recording
  // FAILURE up front is consistent with that policy, not a workaround of
  // it. The true, rich outcome (HTTP status, contract validity, metric
  // scores) is recorded separately in the execution-result artifact
  // (result_path/summary_path), never written back into this ledger event.
  async function reserveExposure(item) {
    if (!usesLedger) return { reserved: false, gate: { ok: true } };
    const state = lifecycleStates.get(item.question_id);
    return ledgerQueue(() => {
      const gate = canUseSplit({
        log: ledger,
        assignmentId: state.assignment_id,
        runId,
        lifecycleState: state,
        executedSplit: config.split,
        usageKind,
        runPurpose: config.run_purpose,
        configurationSha256: config.configuration_sha256,
        gitCommit: config.git_commit,
      });
      if (!gate.ok) return { reserved: false, gate };

      const appended = appendUsageEvent(ledger, {
        assignmentId: state.assignment_id,
        questionId: item.question_id,
        runId,
        usageKind,
        executedSplit: config.split,
        runPurpose: config.run_purpose,
        runOutcome: "FAILURE",
        lifecycleState: state,
        gitCommit: config.git_commit,
        configurationSha256: config.configuration_sha256,
        notes: "HARNESS_EXPOSURE_RESERVATION",
      });
      if (!appended.ok) return { reserved: false, gate: appended };

      if (config.ledger_path) appendEventLineDurable(config.ledger_path, appended.event);
      ledger = appended.log;
      return { reserved: true, gate: appended };
    });
  }

  const results = new Array(gold.length);
  let cursor = 0;

  async function worker() {
    while (cursor < gold.length) {
      const index = cursor++;
      const item = gold[index];

      const reservation = await reserveExposure(item);
      if (!reservation.reserved && usesLedger) {
        results[index] = {
          run_id: runId,
          question_id: item.question_id,
          split: config.split,
          request_started_at: null,
          http_status: null,
          latency_ms: null,
          timed_out: false,
          transport_error: null,
          reservation_error: `${reservation.gate.code}: ${reservation.gate.message}`,
          http_requests_made: 0,
          response_contract_valid: false,
          contract_errors: ["exposure reservation failed; request was never sent"],
          question_echo_matches: null,
          response_usable: false,
          answerability_actual: null,
          execution_mode_actual: null,
          metric_results: {},
          raw_response_sha256: null,
        };
        continue;
      }

      const started = new Date().toISOString();
      const api = await requestAnswer(config, item.question);
      const contractErrors = api.body ? validateFinalResponse(api.body) : [api.parseError ?? api.transportError ?? `HTTP ${api.httpStatus}`];
      const contractValid = api.body ? contractErrors.length === 0 : false;
      const questionEchoMatches = contractValid ? api.body.question === item.question : null;

      // response_usable = HTTP 2xx AND FinalResponse schema-valid AND the
      // response echoes the exact question that was asked. A schema-valid
      // body riding on an HTTP 500, or a schema-valid body that answers a
      // DIFFERENT question than the one requested, is never usable — no
      // metric is computed for it, and it always counts as failed.
      const httpOk = typeof api.httpStatus === "number" && api.httpStatus >= 200 && api.httpStatus < 300;
      const responseUsable = httpOk && contractValid && questionEchoMatches === true;

      const metrics = responseUsable
        ? item.answer_mode === "CLOSED"
          ? scoreClosed(item, api.body)
          : scoreOpen(item, api.body)
        : {};

      results[index] = {
        run_id: runId,
        question_id: item.question_id,
        split: config.split,
        request_started_at: started,
        http_status: api.httpStatus,
        latency_ms: api.latencyMs,
        timed_out: api.timedOut,
        transport_error: safeError(api.transportError ?? api.parseError),
        reservation_error: null,
        http_requests_made: 1,
        response_contract_valid: contractValid,
        contract_errors: contractErrors,
        question_echo_matches: questionEchoMatches,
        response_usable: responseUsable,
        answerability_actual: api.body?.think_trace?.validation?.answerability ?? null,
        execution_mode_actual: api.body?.think_trace?.execution_mode ?? null,
        metric_results: metrics,
        raw_response_sha256: api.raw ? createHash("sha256").update(api.raw).digest("hex") : null,
      };
    }
  }

  await Promise.all(Array.from({ length: Math.min(config.concurrency, gold.length || 1) }, worker));

  const failed = results.filter((r) => !r.response_usable);
  const metricTally = tallyMetricStatuses(results.filter((r) => r.response_usable));
  const summary = {
    run_id: runId,
    configuration_sha256: config.configuration_sha256,
    git_commit: config.git_commit,
    total: results.length,
    // Never a single ambiguous "success" count — see the module header of
    // tests/evaluation-harness.test.mjs for why this was split apart.
    api_success: results.filter((r) => typeof r.http_status === "number" && r.http_status >= 200 && r.http_status < 300).length,
    contract_success: results.filter((r) => r.response_contract_valid).length,
    response_usable: results.filter((r) => r.response_usable).length,
    metric_pass: metricTally.metric_pass,
    metric_fail: metricTally.metric_fail,
    not_scored: metricTally.not_scored,
    review_required: metricTally.review_required,
    timeouts: results.filter((r) => r.timed_out).length,
    http_errors: results.filter((r) => r.http_status !== null && (r.http_status < 200 || r.http_status >= 300)).length,
    contract_errors: results.filter((r) => !r.response_contract_valid).length,
    reservation_failures: results.filter((r) => r.reservation_error !== null).length,
    question_echo_mismatches: results.filter((r) => r.question_echo_matches === false).length,
    latency_ms: { p50: percentile(results.map((r) => r.latency_ms), 0.5), p95: percentile(results.map((r) => r.latency_ms), 0.95) },
    answerability_distribution: distribution(results.map((r) => r.answerability_actual)),
    execution_mode_distribution: distribution(results.map((r) => r.execution_mode_actual)),
    failed_question_ids: failed.map((r) => r.question_id),
  };

  await writeJsonl(config.result_path, results);
  await writeJson(config.summary_path, summary);
  return { results, summary };
}
