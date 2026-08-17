// Tests domain/evaluation-harness/source-tree-guard.mjs against isolated,
// throwaway git repos (never the real repo -- this repo's own worktree is
// legitimately dirty during active development, which would make a test
// against it either flaky or meaningless). Covers the three scenarios the
// v0.17 audit required: dirty worktree rejected, clean worktree passes,
// and a recorded commit SHA's source_tree_hash is reproducible.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { assertReproducibleSourceTree, DirtySourceTreeError } from "../domain/evaluation-harness/source-tree-guard.mjs";

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  await execFileAsync("git", args, { cwd });
}

async function makeCleanRepo(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "source-tree-guard-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await git(dir, ["init", "--quiet"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  await writeFile(path.join(dir, "file.txt"), "hello\n");
  await git(dir, ["add", "file.txt"]);
  await git(dir, ["commit", "--quiet", "-m", "initial"]);
  return dir;
}

test("clean worktree: assertReproducibleSourceTree resolves with clean:true, release_eligible:true", async (t) => {
  const dir = await makeCleanRepo(t);
  const result = await assertReproducibleSourceTree({ cwd: dir });
  assert.equal(result.clean, true);
  assert.equal(result.release_eligible, true);
  assert.deepEqual(result.status_summary, []);
  assert.match(result.git_commit, /^[0-9a-f]{40}$/);
  assert.match(result.source_tree_hash, /^[0-9a-f]{64}$/);
});

test("dirty worktree (tracked modification): assertReproducibleSourceTree rejects by default", async (t) => {
  const dir = await makeCleanRepo(t);
  await writeFile(path.join(dir, "file.txt"), "modified\n");
  await assert.rejects(
    assertReproducibleSourceTree({ cwd: dir }),
    (error) => {
      assert.ok(error instanceof DirtySourceTreeError);
      assert.equal(error.code, "SOURCE_TREE_NOT_REPRODUCIBLE");
      assert.equal(error.statusLines.length, 1);
      return true;
    },
  );
});

test("dirty worktree (staged change): assertReproducibleSourceTree rejects by default", async (t) => {
  const dir = await makeCleanRepo(t);
  await writeFile(path.join(dir, "file.txt"), "staged-change\n");
  await git(dir, ["add", "file.txt"]);
  await assert.rejects(assertReproducibleSourceTree({ cwd: dir }), DirtySourceTreeError);
});

test("dirty worktree (untracked source file): assertReproducibleSourceTree rejects by default", async (t) => {
  const dir = await makeCleanRepo(t);
  await writeFile(path.join(dir, "new-source.mjs"), "export const x = 1;\n");
  await assert.rejects(assertReproducibleSourceTree({ cwd: dir }), DirtySourceTreeError);
});

test("SANDBOX override (allowDirty:true) does not throw, but reports release_eligible:false and the exact status lines", async (t) => {
  const dir = await makeCleanRepo(t);
  await writeFile(path.join(dir, "file.txt"), "modified\n");
  const result = await assertReproducibleSourceTree({ cwd: dir, allowDirty: true });
  assert.equal(result.clean, false);
  assert.equal(result.release_eligible, false);
  assert.equal(result.status_summary.length, 1);
  assert.match(result.status_summary[0], /file\.txt/);
});

test("a gitignored path never trips the guard (mirrors this repo's work/ scratch convention)", async (t) => {
  const dir = await makeCleanRepo(t);
  await writeFile(path.join(dir, ".gitignore"), "scratch/\n");
  await git(dir, ["add", ".gitignore"]);
  await git(dir, ["commit", "--quiet", "-m", "add gitignore"]);
  await execFileAsync("mkdir", ["-p", path.join(dir, "scratch")]);
  await writeFile(path.join(dir, "scratch", "throwaway.json"), "{}\n");
  const result = await assertReproducibleSourceTree({ cwd: dir });
  assert.equal(result.clean, true);
});

test("recorded SHA checkout reproducibility: the same commit produces the same source_tree_hash on a fresh checkout", async (t) => {
  const dir = await makeCleanRepo(t);
  const first = await assertReproducibleSourceTree({ cwd: dir });

  // Advance history, then check back out the FIRST commit exactly --
  // simulating "reproduce the officially-recorded run from its pinned SHA".
  await writeFile(path.join(dir, "file2.txt"), "second\n");
  await git(dir, ["add", "file2.txt"]);
  await git(dir, ["commit", "--quiet", "-m", "second commit"]);
  await git(dir, ["checkout", "--quiet", first.git_commit]);

  const reproduced = await assertReproducibleSourceTree({ cwd: dir });
  assert.equal(reproduced.git_commit, first.git_commit);
  assert.equal(reproduced.source_tree_hash, first.source_tree_hash);
  assert.equal(reproduced.clean, true);
});
