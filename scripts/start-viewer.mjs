import { spawn } from "node:child_process";

const children = [];

const start = (command, args) => {
  const child = spawn(command, args, {
    stdio: "inherit",
    env: process.env,
  });
  children.push(child);
  return child;
};

const api = start(process.execPath, ["scripts/viewer-api.mjs"]);
const site = start("npm", ["run", "dev"]);

const shutdown = () => {
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

for (const child of children) {
  child.on("exit", (code) => {
    if (code && code !== 0) process.exitCode = code;
    shutdown();
  });
}

await Promise.all([
  new Promise((resolve) => api.on("exit", resolve)),
  new Promise((resolve) => site.on("exit", resolve)),
]);
