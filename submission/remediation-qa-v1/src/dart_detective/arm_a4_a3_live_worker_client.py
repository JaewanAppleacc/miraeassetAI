"""arm_a4_a3_live_worker_client — ARM_A4_A3_LIVE 백엔드(A4 광역 풀 + R4_wide_rrf_centric 재정렬
+ A3 모순 가드, 실시간)를 위한 Python <-> 상주 Node.js 워커 전송 계층.

워커는 외부 구현 경로 의존 없이 자기완결적이다 — import하는 four-arm-ac 프로덕션 모듈 전부가
이 저장소의 domain/ 아래에 byte 동일하게 내장되어 있다. 구조는 arm_a_live_worker_client.py와
동일하다(`scripts/arm_a4_a3_live_worker.mjs`를 **한 번만** 띄워 프로세스 수명 동안 유지, 동시
요청 1건, 크래시/타임아웃 시 투명 재기동). 두 백엔드는 필수 env가 다르고 워커 스크립트가
다르고 typed 오류 코드가 다르므로, 매개변수화 대신 복제를 택했고 기존
arm_a_live_worker_client.py는 수정하지 않는다.
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
    "ARM_A4_A3_LIVE_DATABASE_URL",
    "ARM_A4_A3_LIVE_RETRIEVAL_INDEX_ID",
    "ARM_A4_A3_LIVE_LOAD_SESSION_ID",
    "ARM_A4_A3_LIVE_CORPUS_SNAPSHOT_ID",
    "ARM_A4_A3_LIVE_KURE_SERVER_URL",
    "ARM_A4_A3_LIVE_BM25_CACHE_DIR",
)

DEFAULT_WORKER_SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "arm_a4_a3_live_worker.mjs"

_ERROR_CLASSES: dict[str, type["ArmA4A3LiveWorkerError"]] = {}


class ArmA4A3LiveWorkerError(Exception):
    """Base class for every error this transport raises."""
    code = "ARM_A4_A3_SEARCH_FAILED"


def _register(cls: type[ArmA4A3LiveWorkerError]) -> type[ArmA4A3LiveWorkerError]:
    _ERROR_CLASSES[cls.code] = cls
    return cls


@_register
class ArmA4A3NotReadyError(ArmA4A3LiveWorkerError):
    code = "ARM_A4_A3_NOT_READY"


@_register
class ArmA4A3SearchFailedError(ArmA4A3LiveWorkerError):
    code = "ARM_A4_A3_SEARCH_FAILED"


@_register
class ArmA4A3WorkerTimeoutError(ArmA4A3LiveWorkerError):
    code = "ARM_A4_A3_WORKER_TIMEOUT"


@_register
class ArmA4A3WorkerTerminatedError(ArmA4A3LiveWorkerError):
    code = "ARM_A4_A3_WORKER_TERMINATED"


def _error_for(code: str, message: str) -> ArmA4A3LiveWorkerError:
    cls = _ERROR_CLASSES.get(code, ArmA4A3SearchFailedError)
    return cls(message)


class ArmA4A3LiveWorkerClient:
    """Owns one persistent `node scripts/arm_a4_a3_live_worker.mjs` subprocess.

    One request in flight at a time, matching QA's existing single-concurrency serving
    semaphore. On timeout or unexpected process exit, the dead process is torn down and
    the *next* call transparently respawns a fresh one.
    """

    def __init__(self, *, env: Mapping[str, str] | None = None,
                 worker_script: str | os.PathLike | None = None, timeout_s: float = 120.0):
        self._env_overrides = dict(env) if env is not None else None
        self._worker_script = Path(worker_script) if worker_script else DEFAULT_WORKER_SCRIPT
        self._timeout_s = timeout_s
        self._proc: subprocess.Popen | None = None
        self._out_queue: "queue.Queue[str]" = queue.Queue()
        self._lock = threading.Lock()
        self._next_request_id = 0

    def _resolved_env(self) -> dict[str, str]:
        env = dict(self._env_overrides if self._env_overrides is not None else os.environ)
        missing = [name for name in REQUIRED_ENV_VARS if not env.get(name)]
        if missing:
            raise ArmA4A3NotReadyError(f"missing required env var(s) for ARM_A4_A3_LIVE: {', '.join(missing)}")
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
                logger.info("[arm-a4-a3-live-worker stderr] %s", line.rstrip())

        threading.Thread(target=_pump_stdout, daemon=True).start()
        threading.Thread(target=_pump_stderr, daemon=True).start()
        self._proc = proc
        try:
            startup_line = self._out_queue.get(timeout=self._timeout_s)
        except queue.Empty as exc:
            self._kill()
            raise ArmA4A3WorkerTimeoutError("worker did not signal worker_started in time") from exc
        try:
            startup = json.loads(startup_line)
        except json.JSONDecodeError as exc:
            self._kill()
            raise ArmA4A3SearchFailedError(f"worker startup line was not valid JSON: {startup_line!r}") from exc
        if not startup.get("worker_started"):
            self._kill()
            raise ArmA4A3SearchFailedError(f"worker did not confirm startup: {startup_line!r}")

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
                raise ArmA4A3WorkerTerminatedError("worker pipe closed while writing request") from exc

            try:
                line = self._out_queue.get(timeout=self._timeout_s)
            except queue.Empty as exc:
                self._kill()
                raise ArmA4A3WorkerTimeoutError(f"no response within {self._timeout_s}s") from exc

            if self._proc.poll() is not None and not line:
                self._proc = None
                raise ArmA4A3WorkerTerminatedError("worker process exited before responding")

            try:
                response = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ArmA4A3SearchFailedError(f"worker response was not valid JSON: {line!r}") from exc

            if "error" in response:
                error = response["error"]
                raise _error_for(error.get("code", "ARM_A4_A3_SEARCH_FAILED"), error.get("message", "unknown worker error"))
            return response

    def readiness(self) -> dict[str, Any]:
        response = self._call({"type": "readiness"})
        return response["readiness"]

    def search(self, question: str, conditions: Mapping[str, Any] | None, top_k: int) -> dict[str, Any]:
        response = self._call({"question": question, "conditions": dict(conditions or {}), "top_k": top_k})
        return response

    def close(self) -> None:
        if self._proc is not None and self._proc.stdin is not None:
            try:
                self._proc.stdin.close()
            except OSError:
                pass
        self._kill()
