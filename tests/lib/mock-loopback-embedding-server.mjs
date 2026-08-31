// Turn P9.2: a REAL (but entirely fake/deterministic) loopback HTTP server
// for testing the server-identity-handshake + query/document-prefix wiring
// end to end over a genuine TCP socket -- never downloads a model, never
// makes any outbound network call itself, and only ever binds to
// 127.0.0.1. Embeddings returned are a pure, deterministic function of the
// input text (same hash-to-vector scheme as
// fake-deterministic-embedding-adapter.mjs) -- never randomized.
import http from "node:http";
import { createHash } from "node:crypto";

function deterministicVector(text, dimension) {
  const raw = [];
  let counter = 0;
  while (raw.length < dimension) {
    const block = createHash("sha256").update(Buffer.from(text, "utf8")).update(Buffer.from([counter])).digest();
    for (let i = 0; i + 1 < block.length && raw.length < dimension; i += 2) {
      raw.push((block.readUInt16BE(i) / 65535) * 2 - 1);
    }
    counter += 1;
  }
  const norm = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0)) || 1;
  return raw.map((v) => v / norm);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// `info` is a MUTABLE object the test can edit between requests (e.g. to
// simulate mid-run revision drift) -- { repository_id, model_revision,
// dimension, max_input_length, ready }. Pass `infoMode: "malformed"` to
// return invalid JSON, or "missing" to 404 the /info route entirely, or
// "unavailable" to hang past any reasonable timeout (simulated via a
// destroyed connection).
export function startMockLoopbackEmbeddingServer({ info, dimension = 8, infoResponseOverride = null } = {}) {
  let embedCallCount = 0;
  let infoCallCount = 0;
  const embedCallsLog = [];
  let currentInfo = { ...info };

  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.method === "GET" && req.url === "/info") {
      infoCallCount += 1;
      if (infoResponseOverride === "missing") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      if (infoResponseOverride === "malformed") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{ this is not valid json");
        return;
      }
      if (infoResponseOverride === "unavailable") {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(currentInfo));
      return;
    }
    if (req.method === "POST" && req.url === "/tokenize") {
      const raw = await readBody(req);
      const parsed = JSON.parse(raw);
      // Deterministic, whitespace-based token-count stand-in -- good enough
      // for exercising the truncation-check ORCHESTRATION logic without a
      // real tokenizer; real per-model token counts only ever come from
      // local_embedding_server.py's own real tokenizer.
      const lengths = parsed.input.map((text) => text.split(/\s+/).filter(Boolean).length);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ lengths, max_input_length: currentInfo.max_input_length }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/embeddings") {
      embedCallCount += 1;
      const raw = await readBody(req);
      const parsed = JSON.parse(raw);
      embedCallsLog.push({ model: parsed.model, input: [...parsed.input], authorization: req.headers.authorization ?? null });
      const data = parsed.input.map((text) => ({ embedding: deterministicVector(text, dimension) }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        infoUrl: `http://127.0.0.1:${port}/info`,
        embeddingsUrl: `http://127.0.0.1:${port}/v1/embeddings`,
        setInfo(nextInfo) { currentInfo = { ...currentInfo, ...nextInfo }; },
        get embedCallCount() { return embedCallCount; },
        get infoCallCount() { return infoCallCount; },
        get embedCallsLog() { return embedCallsLog; },
        async close() {
          await new Promise((res2) => server.close(res2));
        },
      });
    });
  });
}
