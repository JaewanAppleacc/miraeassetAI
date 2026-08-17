// Official/Release-Gate Harness executions must be reproducible from a
// recorded commit SHA alone -- `git rev-parse HEAD` by itself does NOT
// guarantee that: uncommitted tracked modifications, staged changes, or
// untracked source files all change what actually runs without changing
// HEAD. This binds HEAD together with the exact `git status --porcelain`
// output (empty when the tree is clean) into one source_tree_hash, and by
// default throws BEFORE the caller does anything that could reserve state
// (starting an HTTP server, writing to a Usage Ledger) if the tree is not
// reproducible this way.
//
// gitignored paths (work/ in this repo) never appear in `git status
// --porcelain` output at all, so throwaway harness scratch files there
// never trip this check -- only tracked/staged/untracked SOURCE changes do.
//
// allowDirty:true is a SANDBOX_EXPLORATION-only escape hatch: instead of
// throwing, it returns a non-throwing { clean:false, release_eligible:false,
// ... } result. A caller using this MUST still surface release_eligible
// and source_tree_hash/status_summary in its own run output -- never
// silently drop them just because the run was allowed to proceed.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class DirtySourceTreeError extends Error {
  constructor(message, statusLines) {
    super(message);
    this.name = "DirtySourceTreeError";
    this.code = "SOURCE_TREE_NOT_REPRODUCIBLE";
    this.statusLines = Object.freeze([...statusLines]);
  }
}

async function gitStatusPorcelain(cwd) {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd });
  return stdout.split("\n").filter((line) => line.length > 0);
}

async function gitHeadCommit(cwd) {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
  return stdout.trim();
}

export async function assertReproducibleSourceTree({ cwd = process.cwd(), allowDirty = false } = {}) {
  const [gitCommit, statusLines] = await Promise.all([gitHeadCommit(cwd), gitStatusPorcelain(cwd)]);
  const clean = statusLines.length === 0;
  const sourceTreeHash = createHash("sha256").update(`${gitCommit}\n${statusLines.join("\n")}\n`).digest("hex");
  const result = Object.freeze({
    clean,
    release_eligible: clean,
    git_commit: gitCommit,
    source_tree_hash: sourceTreeHash,
    status_summary: Object.freeze([...statusLines]),
  });
  if (!clean && !allowDirty) {
    throw new DirtySourceTreeError(
      `source tree is not reproducible from git_commit alone: ${statusLines.length} tracked/staged/untracked change(s) present (see status_summary). Official/Release-Gate Harness runs require a clean worktree; pass allowDirty for a SANDBOX-only dev run.`,
      statusLines,
    );
  }
  return result;
}
