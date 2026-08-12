import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function writeJsonl(path, records) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}
