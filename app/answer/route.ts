import { createAnswerHandler } from "../../domain/runtime/answer-handler.mjs";
import { createNoFlowConnectedRunner } from "../../domain/runtime/no-flow-connected-runner.mjs";

// The only piece of Flow wiring in this file: no real AgentFlow exists yet
// (CLAUDE.md section 19), so the fail-closed placeholder runner is used.
// Swapping in a real Flow later only means passing a different `runner`
// here — domain/runtime/answer-handler.mjs itself never imports or knows
// about any specific Flow.
const handleAnswerRequest = createAnswerHandler({ runner: createNoFlowConnectedRunner() });

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const { status, body } = await handleAnswerRequest(url.searchParams);
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
