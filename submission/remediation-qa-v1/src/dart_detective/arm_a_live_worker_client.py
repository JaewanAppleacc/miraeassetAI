"""arm_a_live_worker_client — 실시간 Arm A 검색을 위한 Python <-> 상주 Node.js 워커 전송 계층.

`scripts/arm_a_live_worker.mjs`를 **한 번만** 띄워 프로세스 수명 동안 유지한다(HTTP 서버 없음,
질문마다 프로세스나 BM25 색인을 다시 올리지 않음 — 워커가 장수명 Postgres 클라이언트 1개 +
적재된 BM25 색인 1개 + 임베딩 어댑터 1개를 소유한다. 해당 파일 docstring 참조). 통신은
stdin/stdout으로 줄당 JSON 객체 하나씩이며, 워커의 stderr는 이 프로세스의 로거로 전달될 뿐
프로토콜로 해석하지 않는다.

이 모듈은 자체 검색 로직이 없다 — 요청/응답을 전송하고 워커의 `error.code`를 대응하는 typed
예외로 바꾸는 일만 한다. BM25/dense/RRF/메타데이터 필터는 전부 워커 안에서 Arm A의 무수정
코드로 수행된다.
"""
from __future__ import annotations

import json
import logging
import os
import queue
import subprocess
import threading
from pathlib import Path
from typing import Any, Mapping

logger = logging.getLogger(__name__)

REQUIRED_ENV_VARS = (
    "ARM_A_LIVE_IMPL_ROOT",
    "ARM_A_LIVE_DATABASE_URL",
    "ARM_A_LIVE_RETRIEVAL_INDEX_ID",
    "ARM_A_LIVE_LOAD_SESSION_ID",
    "ARM_A_LIVE_CORPUS_SNAPSHOT_ID",
    "ARM_A_LIVE_KURE_SERVER_URL",
    "ARM_A_LIVE_BM25_CACHE_DIR",
)

DEFAULT_WORKER_SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "arm_a_live_worker.mjs"

_ERROR_CLASSES: dict[str, type["ArmALiveWorkerError"]] = {}


class ArmALiveWorkerError(Exception):
    """Base class for every error this transport raises. `.code` matches the turn's required list."""
    code = "ARM_A_SEARCH_FAILED"


def _register(cls: type[ArmALiveWorkerError]) -> type[ArmALiveWorkerError]:
    _ERROR_CLASSES[cls.code] = cls
    return cls


@_register
class ArmANotReadyError(ArmALiveWorkerError):
    code = "ARM_A_NOT_READY"


@_register
class ArmASearchFailedError(ArmALiveWorkerError):
    code = "ARM_A_SEARCH_FAILED"


@_register
class TextResolutionRequiredError(ArmALiveWorkerError):
    code = "TEXT_RESOLUTION_REQUIRED"


@_register
class TextShaMismatchError(ArmALiveWorkerError):
    code = "TEXT_SHA_MISMATCH"


@_register
class DocumentIdMismatchError(ArmALiveWorkerError):
    code = "DOCUMENT_ID_MISMATCH"


@_register
class ArmAWorkerTimeoutError(ArmALiveWorkerError):
    code = "ARM_A_WORKER_TIMEOUT"


@_register
class ArmAWorkerTerminatedError(ArmALiveWorkerError):
    code = "ARM_A_WORKER_TERMINATED"


def _error_for(code: str, message: str) -> ArmALiveWorkerError:
    cls = _ERROR_CLASSES.get(code, ArmASearchFailedError)
    return cls(message)


class ArmALiveWorkerClient:
    """Owns one persistent `node scripts/arm_a_live_worker.mjs` subprocess.

    One request in flight at a time — matches QA's existing single-concurrency serving semaphore,
    so no new concurrency model is introduced here. On timeout or unexpected process exit, the
    dead process is torn down and the *next* call transparently respawns a fresh one (a
    desynced pipe is never reused silently).
    """

    def __init__(self, *, env: Mapping[str, str] | None = None,
                 worker_script: str | os.PathLike | None = None, timeout_s: float = 60.0):
        self._env_overrides = dict(env) if env is not None else None
        self._worker_script = Path(worker_script) if worker_script else DEFAULT_WORKER_SCRIPT
        self._timeout_s = timeout_s
        self._proc: subprocess.Popen | None = None
        self._out_queue: "queue.Queue[str]" = queue.Queue()
        self._reader_thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._next_request_id = 0

    def _resolved_env(self) -> dict[str, str]:
        env = dict(self._env_overrides if self._env_overrides is not None else os.environ)
        missing = [name for name in REQUIRED_ENV_VARS if not env.get(name)]
        if missing:
            raise ArmANotReadyError(f"missing required env var(s) for ARM_A_LIVE: {', '.join(missing)}")
        return env

    def _spawn(self) -> None:
        env = self._resolved_env()
        proc = subprocess.Popen(
            ["node", str(self._worker_script)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1, env=env,
        )

        def _pump_stdout():
            assert proc.stdout is not None
            for line in proc.stdout:
                self._out_queue.put(line)

        def _pump_stderr():
            assert proc.stderr is not None
            for line in proc.stderr:
                logger.info("[arm-a-live-worker stderr] %s", line.rstrip())

        threading.Thread(target=_pump_stdout, daemon=True).start()
        threading.Thread(target=_pump_stderr, daemon=True).start()
        self._proc = proc
        # The worker writes one unsolicited {"worker_started": true} line once it has finished
        # connecting to Postgres, loading the BM25 index, and constructing the Arm A adapter --
        # waiting for it here means the first real request is never sent to a half-initialized
        # worker.
        try:
            startup_line = self._out_queue.get(timeout=self._timeout_s)
        except queue.Empty as exc:
            self._kill()
            raise ArmAWorkerTimeoutError("worker did not signal worker_started in time") from exc
        try:
            startup = json.loads(startup_line)
        except json.JSONDecodeError as exc:
            self._kill()
            raise ArmASearchFailedError(f"worker startup line was not valid JSON: {startup_line!r}") from exc
        if not startup.get("worker_started"):
            self._kill()
            raise ArmASearchFailedError(f"worker did not confirm startup: {startup_line!r}")

    def _kill(self) -> None:
        proc, self._proc = self._proc, None
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()

    def _ensure_alive(self) -> None:
        if self._proc is not None and self._proc.poll() is not None:
            # Worker exited on its own (crash) since the last call -- never silently reuse it.
            self._proc = None
        if self._proc is None:
            self._spawn()

    def _call(self, request: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            self._ensure_alive()
            assert self._proc is not None and self._proc.stdin is not None
            self._next_request_id += 1
            request = {**request, "request_id": request.get("request_id") or f"py-{self._next_request_id}"}
            try:
                self._proc.stdin.write(json.dumps(request, ensure_ascii=False) + "\n")
                self._proc.stdin.flush()
            except (BrokenPipeError, OSError) as exc:
                self._kill()
                raise ArmAWorkerTerminatedError("worker pipe closed while writing request") from exc

            try:
                line = self._out_queue.get(timeout=self._timeout_s)
            except queue.Empty as exc:
                self._kill()
                raise ArmAWorkerTimeoutError(f"no response within {self._timeout_s}s") from exc

            if self._proc.poll() is not None and not line:
                self._proc = None
                raise ArmAWorkerTerminatedError("worker process exited before responding")

            try:
                response = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ArmASearchFailedError(f"worker response was not valid JSON: {line!r}") from exc

            if "error" in response:
                error = response["error"]
                raise _error_for(error.get("code", "ARM_A_SEARCH_FAILED"), error.get("message", "unknown worker error"))
            return response

    def readiness(self) -> dict[str, Any]:
        response = self._call({"type": "readiness"})
        return response["readiness"]

    def search(self, question: str, conditions: Mapping[str, Any] | None, top_k: int) -> list[dict[str, Any]]:
        response = self._call({"question": question, "conditions": dict(conditions or {}), "top_k": top_k})
        return response["results"]

    def fetch_node(self, document_id: str, node_index: int, *, row: int | None = None,
                   col: int | None = None) -> dict[str, Any]:
        response = self._call({
            "type": "fetch_node", "document_id": document_id, "node_index": node_index,
            "row": row, "col": col,
        })
        return response["fetch_node"]

    def close(self) -> None:
        if self._proc is not None and self._proc.stdin is not None:
            try:
                self._proc.stdin.close()
            except OSError:
                pass
        self._kill()
