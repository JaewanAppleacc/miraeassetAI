// Turn M item 7: tsconfig.json's `include` must be a general,
// directory-scoped design (never a specific personal folder name/exclude)
// that still covers every REAL git-tracked TypeScript file. This test
// uses the TypeScript compiler's OWN config-resolution API (never a
// hand-rolled glob matcher, which could silently drift from tsc's real
// behavior) to compute the actual resolved file set, and cross-checks it
// against `git ls-files` (the same tracked+eligible file listing
// convention used elsewhere in this Turn) so a future new top-level
// source directory that tsconfig.json doesn't yet know about fails this
// test loudly instead of silently being skipped by tsc.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import ts from "typescript";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function listRealTrackedTsFiles() {
  const { stdout } = await execFileAsync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  return stdout.split("\0").filter(Boolean).filter((f) => /\.(ts|tsx|mts)$/.test(f) && !f.startsWith("node_modules/"));
}

function resolveTsconfigFileSet() {
  const configPath = path.join(ROOT, "tsconfig.json");
  const configText = ts.sys.readFile(configPath);
  const parsed = ts.parseConfigFileTextToJson(configPath, configText);
  assert.equal(parsed.error, undefined, "tsconfig.json must parse cleanly");
  const resolved = ts.parseJsonConfigFileContent(parsed.config, ts.sys, ROOT);
  return new Set(resolved.fileNames.map((f) => path.relative(ROOT, f)));
}

test("tsconfig.json no longer excludes any specific personal folder name (general directory-scoped include instead)", async () => {
  const raw = JSON.parse(await readFile(path.join(ROOT, "tsconfig.json"), "utf8"));
  assert.deepEqual(raw.exclude, ["node_modules"]);
  assert.equal(raw.include.some((p) => p.includes("무제")), false);
});

test("every real git-tracked .ts/.tsx/.mts file is covered by tsconfig.json's resolved file set (TypeScript's own resolver, not a hand-rolled glob)", async () => {
  const realFiles = await listRealTrackedTsFiles();
  const resolvedSet = resolveTsconfigFileSet();
  const missing = realFiles.filter((f) => !resolvedSet.has(f));
  assert.deepEqual(missing, [], `tsconfig.json's include does not cover: ${missing.join(", ")} -- a new top-level source directory may need to be added to "include"`);
});

test("the unrelated non-project directory ('무제 폴더 2', containing a nested git repo) is naturally excluded by the directory-scoped include -- never via a name-specific exclude", async () => {
  const resolvedSet = resolveTsconfigFileSet();
  for (const file of resolvedSet) {
    assert.equal(file.includes("무제"), false, `tsconfig unexpectedly resolved a file inside the unrelated folder: ${file}`);
  }
});
