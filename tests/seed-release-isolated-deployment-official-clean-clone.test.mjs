// Turn L2 item 3/4 (OFFICIAL tier): the ONLY test file in this repo
// permitted to claim "a clean `git clone`/`git archive HEAD` can deploy
// this". It never touches the working tree's untracked files -- source
// comes exclusively from `git archive HEAD`, and node_modules comes
// exclusively from a real `npm ci` against the archived package.json +
// package-lock.json (never a hand-copied node_modules subset -- that
// shortcut is CANDIDATE-tier only, see
// tests/seed-release-isolated-deployment-candidate.test.mjs).
//
// The test PRE-CHECKS which essential paths actually exist in HEAD (not
// merely in the staging index). If any are absent it reports
// BLOCKED_BY_UNCOMMITTED_SOURCE and skips the deployment attempt. After a
// selective commit, the same test naturally exercises the real archive.
//
// A run of this file succeeding (all non-summary tests passing) is the
// ONLY thing that may be reported as "clean-clone release_eligible
// verified true".
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { waitForReady, lsofRows, grepForHardcodedPath } from "./lib/isolated-deployment-helpers.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.SEED_ISOLATED_OFFICIAL_PORT ?? 8801);
const HOST = "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}`;

// Every path a real clean-clone deployment needs to exist in HEAD for
// this test to even attempt running. Anything missing here means `git
// archive HEAD` would produce a tree that cannot boot the Runtime, or
// cannot resolve the v0.20 bundle at all.
const ESSENTIAL_TRACKED_PATHS = Object.freeze([
  "package.json",
  "package-lock.json",
  "scripts/start-agent-server.mjs",
  "domain/runtime/node-agent-server.mjs",
  "domain/runtime/configured-seed-runtime.mjs",
  "domain/runtime/bundle-backed-seed-runtime.mjs",
  "domain/runtime/seed-thin-runner.mjs",
  "domain/adapters/seed-runtime-service-adapters.mjs",
  "domain/adapters/seed-company-resolver.mjs",
  "domain/adapters/seed-release-bundle-unpack.mjs",
  "domain/adapters/deterministic-gzip.mjs",
  "domain/releases/bundles/seed-release-v0.20-r3.candidate/bundle-manifest.json",
  "domain/releases/seed-release.v0.20.manifest.json",
  "domain/releases/seed-release.v0.20.decision.json",
  "domain/releases/seed-release.v0.20-r3.candidate.owner-decision.approved.json",
]);

async function isPathTracked(relPath) {
  try {
    await execFileAsync("git", ["cat-file", "-e", `HEAD:${relPath}`], { cwd: ROOT });
    return true;
  } catch {
    return false;
  }
}

async function detectCleanCloneBlocker() {
  const missing = [];
  for (const relPath of ESSENTIAL_TRACKED_PATHS) {
    if (!(await isPathTracked(relPath))) missing.push(relPath);
  }
  const packageJson = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  const deps = packageJson.dependencies ?? {};
  const missingProdDeps = ["ajv", "ajv-formats"].filter((name) => !(name in deps));
  if (missingProdDeps.length > 0) {
    return { blocked: true, code: "BLOCKED_BY_MISSING_PRODUCTION_DEPENDENCY", missing_from_head: missing, missing_prod_deps: missingProdDeps };
  }
  if (missing.length > 0) {
    return { blocked: true, code: "BLOCKED_BY_UNCOMMITTED_SOURCE", missing_from_head: missing, missing_prod_deps: [] };
  }
  return { blocked: false, code: null, missing_from_head: [], missing_prod_deps: [] };
}

let blockedInfo;
let isolatedRoot; let child;

test.before(async () => {
  blockedInfo = await detectCleanCloneBlocker();
  if (blockedInfo.blocked) return; // no deployment attempt this Turn -- see this file's header.

  const realTmp = await realpath(os.tmpdir());
  isolatedRoot = await mkdtemp(path.join(realTmp, "seed-official-clean-clone-"));
  const archivePath = path.join(isolatedRoot, "archive.tar");
  await execFileAsync("git", ["archive", "--format=tar", "-o", archivePath, "HEAD"], { cwd: ROOT });
  const extractDir = path.join(isolatedRoot, "src");
  await mkdir(extractDir, { recursive: true });
  await execFileAsync("tar", ["-xf", archivePath, "-C", extractDir]);

  // Real `npm ci` against the archived package.json/package-lock.json --
  // no hand-copied node_modules subset in this tier.
  await execFileAsync("npm", ["ci", "--omit=dev"], { cwd: extractDir, maxBuffer: 64 * 1024 * 1024 });

  // The real configured production singleton must find, verify, and unpack
  // the Git-tracked r3 bundle itself. The archive intentionally has no work/
  // source tree and this test does not pre-materialize one for it.
  child = spawn(process.execPath, [path.join(extractDir, "scripts/start-agent-server.mjs")], {
    cwd: extractDir,
    env: { PATH: process.env.PATH, PORT: String(PORT), AGENT_HOST: HOST },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForReady(BASE_URL);
});

test.after(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => { child.once("exit", resolve); setTimeout(resolve, 5_000); });
  }
  if (isolatedRoot) await rm(isolatedRoot, { recursive: true, force: true });
});

test("SUMMARY: official clean-clone deployment status is derived from committed HEAD only", () => {
  if (blockedInfo.blocked) {
    console.log(`OFFICIAL clean-clone tier: ${blockedInfo.code} -- missing from HEAD: ${JSON.stringify(blockedInfo.missing_from_head)}, missing prod deps: ${JSON.stringify(blockedInfo.missing_prod_deps)}`);
    assert.ok(["BLOCKED_BY_UNCOMMITTED_SOURCE", "BLOCKED_BY_MISSING_PRODUCTION_DEPENDENCY"].includes(blockedInfo.code));
  } else {
    console.log("OFFICIAL clean-clone tier: all essential paths tracked in HEAD -- deployment attempt below is real.");
  }
});

test("git archive HEAD + npm ci + GET /ready (skipped with reason when blocked)", async (t) => {
  if (blockedInfo.blocked) { t.skip(`${blockedInfo.code}: ${blockedInfo.missing_from_head.join(", ")}`); return; }
  const response = await fetch(`${BASE_URL}/ready`);
  assert.equal(response.status, 200);
});

test("GET /answer Wire contract from the real clean-clone deployment (skipped with reason when blocked)", async (t) => {
  if (blockedInfo.blocked) { t.skip(`${blockedInfo.code}`); return; }
  const { validateAnswerWireResponse } = await import(path.join(isolatedRoot, "src/domain/runtime/answer-wire-response.mjs"));
  const record = {
    question_id: "question_seed_v07_18",
    question: "한화오션이 2024년 6월 14일 결정한 유상증자는 7월 10일 정정 후 실제로 발행까지 완료됐는가? 정정 후 발행 주식 수와 금액도 알려줘.",
  };
  const url = new URL("/answer", BASE_URL);
  url.searchParams.set("question_id", record.question_id);
  url.searchParams.set("question", record.question);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const wire = await response.json();
  assert.deepEqual(validateAnswerWireResponse(wire), []);
  assert.match(wire.answer, /54,495주/);
  assert.match(wire.answer, /40,350원/);
  assert.doesNotMatch(wire.answer, /2,198,873,250\s*원(은|이)?\s*발행총액/);
});

test("no open file / hardcoded path leaks into the real workspace (skipped with reason when blocked)", async (t) => {
  if (blockedInfo.blocked) { t.skip(`${blockedInfo.code}`); return; }
  const rows = await lsofRows(child.pid);
  const leaks = rows.filter((r) => r.name.startsWith(`${ROOT}/`) || r.name === ROOT);
  assert.deepEqual(leaks, []);
  const matches = await grepForHardcodedPath(path.join(isolatedRoot, "src"), ROOT);
  assert.deepEqual(matches, []);
});
