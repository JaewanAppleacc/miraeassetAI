#!/usr/bin/env node
import { createNodeAgentServer } from "../domain/runtime/node-agent-server.mjs";
import { configuredSeedRuntime } from "../domain/runtime/configured-seed-runtime.mjs";

const host = process.env.AGENT_HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new TypeError("PORT must be an integer from 1 to 65535");
}

const server = createNodeAgentServer({ runtime: configuredSeedRuntime });
server.listen(port, host, () => {
  console.log(`Agent API listening on http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
