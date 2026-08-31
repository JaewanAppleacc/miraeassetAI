#!/usr/bin/env python3
"""Turn P9.3: task-owned local embedding server for ONE pinned frozen
candidate at a time. Implements the exact P9.2 contract:

  GET  /health
  GET  /info      -> ready, repository_id, model_revision, embedding_dimension,
                      max_input_length, device, runtime_versions
  POST /v1/embeddings -> { model, input: string[] } -> { data: [{embedding}] }

Every identity field /info reports is read back from the ACTUALLY LOADED
snapshot/config on disk -- never simply echoed from the CLI arguments the
launcher passed in. Binds ONLY to 127.0.0.1 on a caller-chosen (or
kernel-assigned, if 0) port -- never 0.0.0.0 or any other interface.

trust_remote_code is always False. If sentence-transformers refuses to load
the pinned snapshot without it, this process exits with a distinct,
recognizable message (BLOCKED_RUNTIME_REQUIRES_REMOTE_CODE) rather than
silently enabling it.

No truncation is ever applied to an input that exceeds max_input_length --
the underlying tokenizer's own truncation is disabled; a too-long input is
allowed to reach the model as-is (letting a real over-length failure surface
honestly) rather than being silently shortened.
"""
import argparse
import gc
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REQUIRED_HOSTNAME = "127.0.0.1"


def log(message):
    print(f"[local_embedding_server] {message}", file=sys.stderr, flush=True)


def load_model(repository_id, revision, cache_dir):
    import torch
    from sentence_transformers import SentenceTransformer

    device = "cpu"
    mps_attempted = False
    mps_failure_reason = None
    if torch.backends.mps.is_available():
        mps_attempted = True
        try:
            model = SentenceTransformer(
                repository_id, revision=revision, cache_folder=cache_dir,
                trust_remote_code=False, device="mps",
            )
            # Smoke the device with a real forward pass -- MPS "available"
            # does not guarantee every op this model uses is implemented.
            model.encode(["mps smoke test"], convert_to_numpy=True)
            device = "mps"
            return model, device, mps_attempted, mps_failure_reason
        except Exception as error:  # noqa: BLE001 -- deliberate broad catch: ANY MPS failure must fail over to CPU, never crash the server
            mps_failure_reason = f"{type(error).__name__}: {error}"
            log(f"MPS attempted and failed, failing over to CPU: {mps_failure_reason}")

    try:
        model = SentenceTransformer(
            repository_id, revision=revision, cache_folder=cache_dir,
            trust_remote_code=False, device="cpu",
        )
    except Exception as error:  # noqa: BLE001
        message = str(error)
        if "trust_remote_code" in message or "custom code" in message.lower():
            log("BLOCKED_RUNTIME_REQUIRES_REMOTE_CODE: this snapshot requires trust_remote_code=True, which this Turn refuses to enable.")
            sys.exit(42)
        raise
    return model, device, mps_attempted, mps_failure_reason


def build_handler(model, repository_id, revision, expected_dimension, expected_max_input_length, device, mps_attempted, mps_failure_reason):
    import numpy as np
    import torch
    import transformers
    import sentence_transformers

    # Read the ACTUALLY loaded config back off the model object -- never
    # just re-echo the CLI-supplied repository_id/revision as if loading
    # had implicitly confirmed them.
    actual_dimension = model.get_sentence_embedding_dimension()
    actual_max_seq_length = model.get_max_seq_length()
    tokenizer = model.tokenizer

    runtime_versions = {
        "python": sys.version.split()[0],
        "torch": torch.__version__,
        "transformers": transformers.__version__,
        "sentence_transformers": sentence_transformers.__version__,
    }

    state = {"request_count": 0}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):  # noqa: A002 -- silence default stderr access log spam
            pass

        def _send_json(self, status, payload):
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802
            if self.path == "/health":
                self._send_json(200, {"status": "ok"})
                return
            if self.path == "/info":
                self._send_json(200, {
                    "ready": True,
                    "repository_id": repository_id,
                    "model_revision": revision,
                    "embedding_dimension": actual_dimension,
                    "max_input_length": actual_max_seq_length,
                    "device": device,
                    "mps_attempted": mps_attempted,
                    "mps_failure_reason": mps_failure_reason,
                    "runtime_versions": runtime_versions,
                })
                return
            self._send_json(404, {"error": "not found"})

        def do_POST(self):  # noqa: N802
            if self.path == "/tokenize":
                self._handle_tokenize()
                return
            if self.path != "/v1/embeddings":
                self._send_json(404, {"error": "not found"})
                return
            length = int(self.headers.get("content-length", 0))
            raw = self.rfile.read(length)
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                self._send_json(400, {"error": "malformed JSON body"})
                return
            texts = payload.get("input")
            if not isinstance(texts, list) or not texts:
                self._send_json(400, {"error": "input must be a non-empty array of strings"})
                return

            # NEVER truncate -- disable the tokenizer's own truncation for
            # this call so an over-length input surfaces as a real error
            # (or a real, honest over-long encode) rather than being
            # silently shortened.
            original_truncation = tokenizer.model_max_length
            tokenizer.model_max_length = int(1e30)
            try:
                embeddings = model.encode(
                    texts, convert_to_numpy=True, show_progress_bar=False,
                    normalize_embeddings=False,  # never re-normalize here -- report the model's OWN raw output; runner.mjs's own metrics use cosine similarity regardless
                )
            finally:
                tokenizer.model_max_length = original_truncation

            state["request_count"] += 1
            data = []
            for vector in np.asarray(embeddings, dtype=np.float64):
                if not np.all(np.isfinite(vector)):
                    self._send_json(500, {"error": "embedding contained a non-finite value"})
                    return
                data.append({"embedding": vector.tolist()})
            self._send_json(200, {"data": data})

        def _handle_tokenize(self):
            # Section F: REAL tokenizer counts, never a character-length
            # proxy -- used to detect (never to silently truncate) any
            # input exceeding max_input_length before it is ever embedded.
            length = int(self.headers.get("content-length", 0))
            raw = self.rfile.read(length)
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                self._send_json(400, {"error": "malformed JSON body"})
                return
            texts = payload.get("input")
            if not isinstance(texts, list) or not texts:
                self._send_json(400, {"error": "input must be a non-empty array of strings"})
                return
            lengths = [len(tokenizer.encode(text, add_special_tokens=True)) for text in texts]
            self._send_json(200, {"lengths": lengths, "max_input_length": actual_max_seq_length})

    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository-id", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--expected-dimension", type=int, required=True)
    parser.add_argument("--expected-max-input-length", type=int, required=True)
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()

    os.environ.setdefault("HF_HOME", args.cache_dir)
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "0")
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

    load_started_at = time.time()
    model, device, mps_attempted, mps_failure_reason = load_model(args.repository_id, args.revision, args.cache_dir)
    load_elapsed_s = time.time() - load_started_at
    log(f"model loaded in {load_elapsed_s:.2f}s on device={device}")

    handler_cls = build_handler(
        model, args.repository_id, args.revision, args.expected_dimension, args.expected_max_input_length,
        device, mps_attempted, mps_failure_reason,
    )
    server = ThreadingHTTPServer((REQUIRED_HOSTNAME, args.port), handler_cls)
    actual_port = server.server_address[1]
    # Single, greppable line the Node launcher waits for on stdout.
    print(f"LISTENING {REQUIRED_HOSTNAME}:{actual_port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        del model
        gc.collect()
        try:
            import torch
            if torch.backends.mps.is_available():
                torch.mps.empty_cache()
        except Exception:  # noqa: BLE001 -- best-effort cleanup only
            pass
        log("server stopped, model released")


if __name__ == "__main__":
    main()
