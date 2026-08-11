// Liveness check only — deliberately calls no Agent/SharedServices code, so
// it cannot fail because of anything downstream (Retriever, HCX, DB, ...).

export async function GET(): Promise<Response> {
  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
