"""팀원2 운영 계약 서버 — interfaces.md §2 + 2026-09-03 업데이트 8번.

배포 스켈레톤이자 최종 서빙 앱이다. 답을 만드는 쪽(`answer_api`)이 아직 없으면
더미 5필드로 돌고(공개망 스켈레톤), `dart_detective/answer_api.py`가 생기는 순간
자동으로 실물에 연결된다 — 이 파일은 고칠 필요가 없다.

에이전트 층 계약(업데이트 8번 확정):
    answer_api.answer_ex(question_id, question, deadline_s=남은 초)
        -> (5필드 wire dict, meta dict)   # meta["cacheable"] is False -> 캐시 금지
    answer_api.readiness()
        -> {"ready", "missing", "pins", "mode"}
    (구형 answer_api.answer 5필드 단일 반환도 받아 준다 — think_trace 표식으로 캐시 판정)

이 모듈이 소유하는 것(§2-2):
  - GET /answer 파라미터 검증(누락·빈 값·중복 -> 400), 5필드 그대로 전달
  - 캐시: key = question_id + sha256(question) + 설정 지문(readiness().pins)
          meta.cacheable=False·폴백·degraded 결과는 캐시 금지
  - 세마포어 1 · 데드라인(DART_QA_DEADLINE_S, 기본 290초) · 클라이언트 단절 시 취소
  - /health(프로세스 생존)와 /ready(readiness().ready) 분리
  - 요청 전량 로깅(질문 원문·키는 제외) · 기동 시 preload + 워밍업

실행:
    PYTHONIOENCODING=utf-8 uvicorn dart_detective.ops_service:app --port 8000 --workers 1
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import time
from typing import Any, Callable, Mapping

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

logger = logging.getLogger("dart_detective.ops")
# uvicorn은 자기 로거만 구성한다 — 앱 로그(문항별 소요·캐시·폴백 사유)가 journald에
# 안 남아 리허설 재시도 원인 추적이 안 됐다(실측 2026-09-03). 루트에 핸들러가 없을 때만
# 기본 구성을 얹는다(테스트·상위 앱이 이미 구성했다면 건드리지 않음).
if not logging.getLogger().handlers:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(name)s %(levelname)s %(message)s")

WIRE_KEYS = ("question_id", "question", "retrieved_context", "think_trace", "answer")

# 공급자 호출 규약: call(question_id, question, deadline_s) -> (wire, meta)
Provider = Callable[..., tuple[dict, dict]]


# ---------- 답 공급자 (answer_api가 생기면 자동 연결) ----------

def _dummy_call(question_id: str, question: str, *,
                deadline_s: float | None = None) -> tuple[dict, dict]:
    """스켈레톤 더미 — 계약 모양만 실물과 동일. 절대 캐시되지 않는다."""
    wire = {
        "question_id": question_id,
        "question": question,
        "retrieved_context": "",
        "think_trace": json.dumps(
            {"mode": "dummy", "note": "answer_api 미연결 — 배포 스켈레톤 응답"},
            ensure_ascii=False),
        "answer": "서버 연결 확인용 더미 응답입니다. 답변 엔진은 아직 연결되지 않았습니다.",
    }
    return wire, {"cacheable": False, "mode": "dummy"}


def _dummy_readiness() -> dict[str, Any]:
    return {"ready": True, "missing": [], "pins": {"skeleton": "dummy"},
            "mode": "degraded"}


def _legacy_cacheable(wire: Mapping[str, str]) -> bool:
    """구형 answer()에는 meta가 없다 — think_trace 표식으로 보수적으로 판정."""
    trace = wire.get("think_trace", "")
    if '"fallback": true' in trace or '"mode": "dummy"' in trace or '"degraded"' in trace:
        return False
    return True


def _load_provider() -> tuple[Provider, Callable[[], dict]]:
    try:
        from . import answer_api  # type: ignore  # 에이전트 층 산출물
    except Exception:  # noqa: BLE001 — 없으면 스켈레톤 모드
        return _dummy_call, _dummy_readiness

    readiness = getattr(answer_api, "readiness", _dummy_readiness)
    if hasattr(answer_api, "answer_ex"):
        def call(qid: str, q: str, *, deadline_s: float | None = None):
            wire, meta = answer_api.answer_ex(qid, q, deadline_s=deadline_s)
            return wire, dict(meta or {})
        return call, readiness
    if hasattr(answer_api, "answer"):
        def call(qid: str, q: str, *, deadline_s: float | None = None):
            wire = answer_api.answer(qid, q, deadline_s=deadline_s)
            return wire, {"cacheable": _legacy_cacheable(wire)}
        return call, readiness
    return _dummy_call, readiness


_call, _readiness = _load_provider()


def configure(call_fn: Provider | None = None,
              readiness_fn: Callable[[], dict] | None = None) -> None:
    """테스트·수동 배선용. 둘 다 None이면 다시 자동 탐색."""
    global _call, _readiness
    if call_fn is None and readiness_fn is None:
        _call, _readiness = _load_provider()
        return
    if call_fn is not None:
        _call = call_fn
    if readiness_fn is not None:
        _readiness = readiness_fn


# ---------- 캐시 ----------

_cache: dict[str, dict[str, str]] = {}


def deadline_budget() -> float:
    try:
        return float(os.environ.get("DART_QA_DEADLINE_S", "290"))
    except ValueError:
        return 290.0


def _pins_fingerprint() -> str:
    try:
        pins = (_readiness() or {}).get("pins") or {}
    except Exception:  # noqa: BLE001
        pins = {}
    return hashlib.sha256(
        json.dumps(pins, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


def cache_key(question_id: str, question: str) -> str:
    q_sha = hashlib.sha256(question.encode("utf-8")).hexdigest()
    return hashlib.sha256(f"{question_id}|{q_sha}|{_pins_fingerprint()}"
                          .encode("utf-8")).hexdigest()


def cacheable(meta: Mapping[str, Any]) -> bool:
    """meta.cacheable=False면 금지(업데이트 8번). degraded 모드도 금지(§2-2)."""
    if meta.get("cacheable") is not True:
        return False
    try:
        if (_readiness() or {}).get("mode") == "degraded":
            return False
    except Exception:  # noqa: BLE001
        return False
    return True


def _cache_dir() -> str | None:
    return os.environ.get("DART_QA_CACHE_DIR") or None


def _valid_wire(obj: Any) -> bool:
    """캐시에서 꺼낸 응답이 5-string 계약을 지키는가 — 손상 캐시가 200으로 나가는 것을 막는다."""
    return (isinstance(obj, dict) and set(obj) == set(WIRE_KEYS)
            and all(isinstance(v, str) for v in obj.values()) and bool(obj["answer"]))


def _cache_load(key: str) -> dict[str, str] | None:
    hit = _cache.get(key)
    if hit is not None:
        return hit if _valid_wire(hit) else None
    d = _cache_dir()
    if d:
        path = os.path.join(d, key + ".json")
        if os.path.exists(path):
            try:
                with open(path, encoding="utf-8") as f:
                    loaded = json.load(f)
                if _valid_wire(loaded):
                    _cache[key] = loaded
                    return loaded
                logger.warning("cache entry invalid(5-string 위반) key=%s — miss 처리", key[:12])
            except Exception:  # noqa: BLE001 — 캐시 손상은 miss로 처리
                logger.warning("cache read failed key=%s", key[:12])
    return None


def _cache_store(key: str, response: dict[str, str]) -> None:
    _cache[key] = response
    d = _cache_dir()
    if d:
        try:
            os.makedirs(d, exist_ok=True)
            tmp = os.path.join(d, key + ".tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(response, f, ensure_ascii=False)
            os.replace(tmp, os.path.join(d, key + ".json"))
        except Exception:  # noqa: BLE001 — 디스크 캐시 실패는 치명 아님
            logger.warning("cache write failed key=%s", key[:12])


# ---------- 앱 ----------

app = FastAPI(title="DART QA ops", version="1.1")
_gate = asyncio.Semaphore(1)          # 세마포어 1 — 동시 실행 금지(§2-2)


@app.on_event("startup")
async def _startup() -> None:
    """preload + 워밍업 1회. 실패해도 서버는 뜬다 — /ready가 사실을 말한다."""
    try:
        ready = _readiness()
        logger.info("startup readiness ready=%s mode=%s missing=%s",
                    ready.get("ready"), ready.get("mode"), ready.get("missing"))
        await asyncio.to_thread(_call, "warmup-0", "워밍업 질문입니다.",
                                deadline_s=30.0)
        logger.info("warmup ok")
    except Exception as exc:  # noqa: BLE001
        logger.warning("warmup failed: %s", type(exc).__name__)


@app.get("/health")
def health() -> dict[str, Any]:
    return {"status": "ok"}


@app.get("/ready")
def ready() -> JSONResponse:
    try:
        r = _readiness() or {}
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=503, content={"ready": False,
                                                      "error": type(exc).__name__})
    code = 200 if r.get("ready") else 503
    return JSONResponse(status_code=code, content=r)


def _param_error(detail: str) -> JSONResponse:
    return JSONResponse(status_code=400, content={"detail": detail})


def _fallback_wire(question_id: str, question: str, reason: str) -> dict[str, str]:
    return {
        "question_id": question_id, "question": question,
        "retrieved_context": "",
        "think_trace": json.dumps({"fallback": True, "reason": reason},
                                  ensure_ascii=False),
        "answer": ("제한 시간 안에 답변을 완성하지 못했습니다."
                   if reason == "deadline" else "내부 오류로 답변을 생성하지 못했습니다."),
    }


@app.get("/answer")
async def answer_endpoint(request: Request) -> JSONResponse:
    t0 = time.perf_counter()
    params = request.query_params
    for name in ("question_id", "question"):
        values = params.getlist(name)
        if len(values) == 0 or not values[0].strip():
            return _param_error(f"{name} 누락 또는 빈 값")
        if len(values) > 1:
            return _param_error(f"{name} 중복 전달")
    question_id = params["question_id"]
    question = params["question"]

    key = cache_key(question_id, question)
    hit = _cache_load(key)
    if hit is not None:
        logger.info("answer cache=hit qid=%s chars=%d ms=%d",
                    question_id, len(question), int((time.perf_counter() - t0) * 1000))
        return JSONResponse(content=hit)

    meta: dict[str, Any] = {"cacheable": False}
    async with _gate:
        remaining = deadline_budget() - (time.perf_counter() - t0)
        task = asyncio.create_task(
            asyncio.to_thread(_call, question_id, question, deadline_s=remaining))
        try:
            while True:
                done, _ = await asyncio.wait({task}, timeout=0.5)
                if done:
                    response, meta = task.result()
                    break
                if (time.perf_counter() - t0) >= deadline_budget():
                    raise TimeoutError
                if await request.is_disconnected():
                    # 클라이언트가 끊었다 — 결과를 버리고 자리를 비운다(재시도 겹침 대응).
                    task.cancel()
                    logger.info("answer cancelled(disconnect) qid=%s", question_id)
                    return JSONResponse(status_code=499,
                                        content={"detail": "client disconnected"})
        except TimeoutError:
            task.cancel()
            logger.warning("answer deadline qid=%s", question_id)
            response = _fallback_wire(question_id, question, "deadline")
        except Exception as exc:  # noqa: BLE001 — 어떤 실패에도 유효 5필드
            logger.error("answer error qid=%s err=%s", question_id, type(exc).__name__)
            response = _fallback_wire(question_id, question, type(exc).__name__)

    response = {k: str(response.get(k, "")) for k in WIRE_KEYS}
    stored = cacheable(meta)
    if stored:
        _cache_store(key, response)
    logger.info("answer cache=miss qid=%s chars=%d cached=%s ms=%d",
                question_id, len(question), stored,
                int((time.perf_counter() - t0) * 1000))
    return JSONResponse(content=response)
