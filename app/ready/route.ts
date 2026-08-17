import { configuredSeedRuntime } from "../../domain/runtime/configured-seed-runtime.mjs";

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

// Readiness, distinct from /health liveness. It performs the one-time
// artifact hash/schema/snapshot construction and reports 503 if the real
// Thin Flow cannot be served. Internal paths/errors are never returned.
export async function GET(): Promise<Response> {
  await configuredSeedRuntime.initialize();
  const readiness = configuredSeedRuntime.readiness();
  return new Response(JSON.stringify(readiness), {
    status: readiness.ready ? 200 : 503,
    headers: HEADERS,
  });
}
