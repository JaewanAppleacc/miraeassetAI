"""arm_a4_a3_remediation_live_worker_client — opt-in ARM_A4_A3_REMEDIATION_LIVE 백엔드(A4 광역
풀 + R4_wide_rrf_centric 재정렬 + A3 모순 가드에, 검증된 검색 개선의
정정/서브타입/날짜창/BM25-0점 정책을 각 검색 leg의 후보 생성에 적용)를 위한
Python <-> 상주 Node.js 워커 전송 계층.

구조는 arm_a4_a3_live_worker_client.py와 동일하다
(`scripts/arm_a4_a3_remediation_live_worker.mjs`를 **한 번만** 띄워 프로세스 수명 동안 유지,
동시 요청 1건, 크래시/타임아웃 시 투명 재기동). 두 백엔드는 필수 env가 다르고 워커 스크립트가
다르고 typed 오류 코드가 다르므로, 매개변수화 대신 복제를 택했고 기존
arm_a4_a3_live_worker_client.py는 수정하지 않는다.
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
    "ARM_A4_A3_REMEDIATION_LIVE_DATABASE_URL",
    "ARM_A4_A3_REMEDIATION_LIVE_RETRIEVAL_INDEX_ID",
    "ARM_A4_A3_REMEDIATION_LIVE_LOAD_SESSION_ID",
    "ARM_A4_A3_REMEDIATION_LIVE_CORPUS_SNAPSHOT_ID",
    "ARM_A4_A3_REMEDIATION_LIVE_KURE_SERVER_URL",
    "ARM_A4_A3_REMEDIATION_LIVE_BM25_CACHE_DIR",
)

DEFAULT_WORKER_SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "arm_a4_a3_remediation_live_worker.mjs"

_ERROR_CLASSES: dict[str, type["ArmA4A3RemediationLiveWorkerError"]] = {}


class ArmA4A3RemediationLiveWorkerError(Exception):
    """이 전송 계층이 던지는 모든 오류의 기반 클래스."""
    code = "ARM_A4_A3_REMEDIATION_SEARCH_FAILED"


def _register(cls: type[ArmA4A3RemediationLiveWorkerError]) -> type[ArmA4A3RemediationLiveWorkerError]:
    _ERROR_CLASSES[cls.code] = cls
    return cls


@_register
class ArmA4A3RemediationNotReadyError(ArmA4A3RemediationLiveWorkerError):
    code = "ARM_A4_A3_REMEDIATION_NOT_READY"


@_register
class ArmA4A3RemediationSearchFailedError(ArmA4A3RemediationLiveWorkerError):
    code = "ARM_A4_A3_REMEDIATION_SEARCH_FAILED"


@_register
class ArmA4A3RemediationWorkerTimeoutError(ArmA4A3RemediationLiveWorkerError):
    code = "ARM_A4_A3_REMEDIATION_WORKER_TIMEOUT"


@_register
class ArmA4A3RemediationWorkerTerminatedError(ArmA4A3RemediationLiveWorkerError):
    code = "ARM_A4_A3_REMEDIATION_WORKER_TERMINATED"


@_register
class ArmA4A3RemediationConditionMappingFailedError(ArmA4A3RemediationLiveWorkerError):
    code = "ARM_A4_A3_CONDITION_MAPPING_FAILED"


def _error_for(code: str, message: str) -> ArmA4A3RemediationLiveWorkerError:
    cls = _ERROR_CLASSES.get(code, ArmA4A3RemediationSearchFailedError)
    return cls(message)


class ArmA4A3RemediationLiveWorkerClient:
    """상주 `node scripts/arm_a4_a3_remediation_live_worker.mjs` 서브프로세스 하나를 소유한다.

    동시 요청은 1건 — QA의 기존 단일 동시성 서빙 세마포어와 맞춘 것이다. 타임아웃이나 예기치
    않은 프로세스 종료 시 죽은 프로세스를 정리하고, *다음* 호출이 투명하게 새 프로세스를
    띄운다.
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
            raise ArmA4A3RemediationNotReadyError(
                f"missing required env var(s) for ARM_A4_A3_REMEDIATION_LIVE: {', '.join(missing)}")
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
                logger.info("[arm-a4-a3-remediation-live-worker stderr] %s", line.rstrip())

        threading.Thread(target=_pump_stdout, daemon=True).start()
        threading.Thread(target=_pump_stderr, daemon=True).start()
        self._proc = proc
        try:
            startup_line = self._out_queue.get(timeout=self._timeout_s)
        except queue.Empty as exc:
            self._kill()
            raise ArmA4A3RemediationWorkerTimeoutError("worker did not signal worker_started in time") from exc
        try:
            startup = json.loads(startup_line)
        except json.JSONDecodeError as exc:
            self._kill()
            raise ArmA4A3RemediationSearchFailedError(f"worker startup line was not valid JSON: {startup_line!r}") from exc
        if not startup.get("worker_started"):
            self._kill()
            raise ArmA4A3RemediationSearchFailedError(f"worker did not confirm startup: {startup_line!r}")

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
                raise ArmA4A3RemediationWorkerTerminatedError("worker pipe closed while writing request") from exc

            try:
                line = self._out_queue.get(timeout=self._timeout_s)
            except queue.Empty as exc:
                self._kill()
                raise ArmA4A3RemediationWorkerTimeoutError(f"no response within {self._timeout_s}s") from exc

            if self._proc.poll() is not None and not line:
                self._proc = None
                raise ArmA4A3RemediationWorkerTerminatedError("worker process exited before responding")

            try:
                response = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ArmA4A3RemediationSearchFailedError(f"worker response was not valid JSON: {line!r}") from exc

            if "error" in response:
                error = response["error"]
                raise _error_for(error.get("code", "ARM_A4_A3_REMEDIATION_SEARCH_FAILED"), error.get("message", "unknown worker error"))
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
