import http from "node:http";
import { createAnswerHandler } from "./answer-handler.mjs";

const JSON_HEADERS = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
});

function sendJson(response, status, body) {
  response.writeHead(status, JSON_HEADERS);
  response.end(JSON.stringify(body));
}

// Node deployment adapter for the organizer's public GET API. The domain
// handler and managed Runtime remain the only sources of answer/readiness
// behavior; this module only translates node:http requests and responses.
export function createNodeAgentServer({ runtime, timeoutMs } = {}) {
  if (!runtime || typeof runtime.run !== "function" || typeof runtime.initialize !== "function" || typeof runtime.readiness !== "function") {
    throw new TypeError("runtime must expose run, initialize, and readiness");
  }
  const handleAnswer = createAnswerHandler({ runner: runtime.run, ...(timeoutMs === undefined ? {} : { timeoutMs }) });

  return http.createServer(async (request, response) => {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
      return;
    }

    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname === "/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (url.pathname === "/ready") {
      await runtime.initialize();
      const readiness = runtime.readiness();
      sendJson(response, readiness.ready ? 200 : 503, readiness);
      return;
    }
    if (url.pathname !== "/answer") {
      sendJson(response, 404, { error: "NOT_FOUND" });
      return;
    }

    const controller = new AbortController();
    const abort = () => controller.abort(new Error("CLIENT_DISCONNECT"));
    request.once("aborted", abort);
    try {
      const result = await handleAnswer(url.searchParams, { signal: controller.signal });
      sendJson(response, result.status, result.body);
    } finally {
      request.off("aborted", abort);
    }
  });
}
