import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, readlink, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

function parseArgs(argv) {
  const args = { outputDir: "work/a-document-ir" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--input-dir") args.inputDir = argv[++index];
    else if (token === "--output-dir") args.outputDir = argv[++index];
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (!args.inputDir) throw new Error("--input-dir is required");
  return args;
}

async function inspectFile(path) {
  const hash = createHash("sha256");
  let bytes = 0;
  let lines = 0;
  let lastByte = null;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] === 10) lines += 1;
    }
    if (chunk.length > 0) lastByte = chunk[chunk.length - 1];
  }
  if (bytes > 0 && lastByte !== 10) lines += 1;
  return { file_name: basename(path), bytes, lines, sha256: hash.digest("hex") };
}

const args = parseArgs(process.argv.slice(2));
const inputDir = resolve(args.inputDir);
const outputDir = resolve(args.outputDir);
await mkdir(outputDir, { recursive: true });

const sourceLink = join(outputDir, "source");
try {
  const stat = await lstat(sourceLink);
  if (!stat.isSymbolicLink() || resolve(await readlink(sourceLink)) !== inputDir) {
    await unlink(sourceLink);
    await symlink(inputDir, sourceLink, "dir");
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  await symlink(inputDir, sourceLink, "dir");
}

const files = (await readdir(inputDir))
  .filter((name) => name.endsWith(".jsonl"))
  .sort()
  .map((name) => join(inputDir, name));
const inventory = [];
for (const file of files) inventory.push(await inspectFile(file));

const result = {
  inventory_version: "0.1.0",
  registered_at: new Date().toISOString(),
  source_dir: inputDir,
  total_bytes: inventory.reduce((sum, file) => sum + file.bytes, 0),
  total_documents: inventory.reduce((sum, file) => sum + file.lines, 0),
  files: inventory,
};
await writeFile(join(outputDir, "inventory.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

