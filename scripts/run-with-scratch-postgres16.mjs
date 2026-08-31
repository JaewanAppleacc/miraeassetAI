#!/usr/bin/env node
// Turn P8, Section I: a real, disposable PostgreSQL 16 + pgvector 0.8.0
// cluster for the *-postgres16-integration.test.mjs tier -- never brew
// services, never a shared/long-lived server. Every run gets its own
// mkdtemp'd PGDATA + unix-socket directory and its own dynamically chosen
// TCP port, so two runs (even concurrent ones, e.g. from two different
// terminals) never collide. On exit (success, failure, or a signal) the
// server is stopped with `pg_ctl stop -m fast` and the entire temp
// directory is removed -- zero leftover process/socket/data/temp is the
// whole point of this script existing.
//
// Usage:
//   node scripts/run-with-scratch-postgres16.mjs -- npm run test:resumable-dedup-loader:postgres16
//
// The wrapped command is run with DATABASE_URL pointed at the fresh scratch
// database (an EMPTY database each time -- exactly what every
// *-postgres16-integration.test.mjs in this repo already asserts about its
// own DATABASE_URL).
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import process from "node:process";

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) return reject(new Error(`${command} killed by signal ${signal}`));
      if (code !== 0) return reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
      resolve();
    });
  });
}

async function main() {
  const sepIndex = process.argv.indexOf("--");
  if (sepIndex === -1 || sepIndex === process.argv.length - 1) {
    console.error("Usage: node scripts/run-with-scratch-postgres16.mjs -- <command> [args...]");
    process.exit(2);
  }
  const [command, ...args] = process.argv.slice(sepIndex + 1);

  const { existsSync } = await import("node:fs");
  const candidates = [
    "/opt/homebrew/opt/postgresql@16/bin", "/usr/local/opt/postgresql@16/bin",
    "/opt/homebrew/bin", "/usr/local/bin",
  ];
  const binDir = candidates.find((dir) => existsSync(path.join(dir, "pg_ctl")));
  if (!binDir) {
    console.error("BLOCKED_POSTGRESQL_16_NOT_FOUND: no pg_ctl found under Homebrew's postgresql@16 (or bin) locations.");
    process.exit(1);
  }

  const root = await mkdtemp(path.join(tmpdir(), "dedup-loader-scratch-pg16-"));
  const pgData = path.join(root, "pgdata");
  const socketDir = path.join(root, "socket");
  const logFile = path.join(root, "postgres.log");
  await import("node:fs/promises").then((fs) => fs.mkdir(socketDir, { recursive: true }));

  const port = await findFreePort();
  const user = process.env.USER ?? "postgres";
  let started = false;

  async function cleanup() {
    if (started) {
      started = false;
      await run(path.join(binDir, "pg_ctl"), ["-D", pgData, "-m", "fast", "stop"]).catch((e) => {
        console.error(`WARNING: pg_ctl stop failed: ${e.message}`);
      });
    }
    await rm(root, { recursive: true, force: true }).catch((e) => {
      console.error(`WARNING: failed to remove scratch dir ${root}: ${e.message}`);
    });
  }

  process.on("SIGINT", async () => { await cleanup(); process.exit(130); });
  process.on("SIGTERM", async () => { await cleanup(); process.exit(143); });

  let exitCode = 1;
  try {
    await run(path.join(binDir, "initdb"), ["-D", pgData, "-U", user, "-A", "trust", "-E", "UTF8", "--locale=C"]);
    await run(path.join(binDir, "pg_ctl"), [
      "-D", pgData, "-l", logFile, "-w",
      "-o", `-p ${port} -h 127.0.0.1 -k ${socketDir}`,
      "start",
    ]);
    started = true;

    await run(path.join(binDir, "createdb"), ["-h", "127.0.0.1", "-p", String(port), "-U", user, "scratch_db"]);

    const databaseUrl = `postgresql://${user}@127.0.0.1:${port}/scratch_db`;
    console.error(`[scratch-postgres16] ready: ${databaseUrl} (PGDATA=${pgData})`);

    await run(command, args, { env: { ...process.env, DATABASE_URL: databaseUrl } });
    exitCode = 0;
  } catch (error) {
    console.error(`[scratch-postgres16] failed: ${error.message}`);
    exitCode = 1;
  } finally {
    await cleanup();
  }
  process.exit(exitCode);
}

await main();
