// Shared helpers for the two isolated-deployment test tiers (Turn L2 item 3):
//   - tests/seed-release-isolated-deployment-candidate.test.mjs (CANDIDATE)
//   - tests/seed-release-isolated-deployment-official-clean-clone.test.mjs (OFFICIAL)
// Kept here so both tiers exercise IDENTICAL isolation-proof logic --
// only how the isolated tree's files are sourced differs between them.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function waitForReady(baseUrl, { timeoutMs = 30_000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/ready`);
      if (response.ok) return;
      lastError = new Error(`GET /ready returned ${response.status}`);
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`isolated server did not become ready within ${timeoutMs}ms: ${lastError?.message}`);
}

// Returns { cwdRow, rows } from `lsof -p <pid>` -- parsed generically so
// both test tiers can independently assert cwd/no-leak-into-root without
// duplicating the lsof invocation/parsing.
export async function lsofRows(pid) {
  const { stdout } = await execFileAsync("lsof", ["-p", String(pid)]).catch((error) => {
    if (error.stdout) return { stdout: error.stdout };
    throw error;
  });
  const lines = stdout.split("\n").slice(1).filter((l) => l.trim() !== "");
  return lines.map((line) => {
    const fields = line.trim().split(/\s+/);
    return { fd: fields[3], type: fields[4], name: fields.slice(8).join(" ") };
  });
}

export async function grepForHardcodedPath(searchRoot, needlePath) {
  const { stdout } = await execFileAsync("grep", ["-rl", "--include=*.mjs", "--include=*.ts", needlePath, searchRoot]).catch((error) => {
    if (error.code === 1) return { stdout: "" };
    throw error;
  });
  return stdout.split("\n").filter(Boolean);
}
