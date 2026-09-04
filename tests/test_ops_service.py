"""팀원2 운영 계약(interfaces §2 + 09-03 업데이트 8번) — ops_service 검증.

계약 요점: 파라미터 검증 400 · 5필드 전부 문자열 · 캐시는 meta.cacheable=True일 때만
(degraded 모드 금지) · 세마포어 1 · /health와 /ready 분리 · 예외에도 유효 5필드.
"""
from __future__ import annotations

import json
import threading
import time

import pytest
from fastapi.testclient import TestClient

from dart_detective import ops_service


def _wire(qid, q, answer="답"):
    return {"question_id": qid, "question": q,
            "retrieved_context": "[근거1] x [/근거1]",
            "think_trace": json.dumps({"mode": "real"}), "answer": answer}


@pytest.fixture()
def client():
    ops_service._cache.clear()
    ops_service.configure(
        call_fn=lambda qid, q, *, deadline_s=None: (_wire(qid, q), {"cacheable": True}),
        readiness_fn=lambda: {"ready": True, "missing": [], "pins": {"v": 1},
                              "mode": "real"},
    )
    with TestClient(ops_service.app) as c:
        yield c
    ops_service._cache.clear()
    ops_service.configure()          # 자동 탐색으로 복귀


def test_missing_empty_duplicate_params_are_400(client):
    assert client.get("/answer").status_code == 400
    assert client.get("/answer", params={"question_id": "q1"}).status_code == 400
    assert client.get("/answer?question_id=q1&question=%20").status_code == 400
    assert client.get("/answer?question_id=q1&question=a&question=b").status_code == 400


def test_five_string_fields(client):
    r = client.get("/answer", params={"question_id": "q1", "question": "매출은?"})
    assert r.status_code == 200
    body = r.json()
    assert set(body) == set(ops_service.WIRE_KEYS)
    assert all(isinstance(v, str) for v in body.values())
    assert body["question_id"] == "q1"


def test_cacheable_true_hits_second_call(client):
    calls = {"n": 0}

    def provider(qid, q, *, deadline_s=None):
        calls["n"] += 1
        return _wire(qid, q), {"cacheable": True}

    ops_service.configure(call_fn=provider)
    for _ in range(2):
        assert client.get("/answer", params={"question_id": "q2",
                                             "question": "같은 질문"}).status_code == 200
    assert calls["n"] == 1


def test_meta_cacheable_false_is_not_cached(client):
    """업데이트 8번: meta.cacheable=False면 캐시에 넣지 않는다 — 폴백·저하·시간부족 답."""
    calls = {"n": 0}

    def provider(qid, q, *, deadline_s=None):
        calls["n"] += 1
        return _wire(qid, q, answer="폴백"), {"cacheable": False, "reason": "fallback"}

    ops_service.configure(call_fn=provider)
    for _ in range(2):
        client.get("/answer", params={"question_id": "q3", "question": "질문"})
    assert calls["n"] == 2


def test_missing_cacheable_defaults_to_not_cached(client):
    calls = {"n": 0}

    def provider(qid, q, *, deadline_s=None):
        calls["n"] += 1
        return _wire(qid, q), {}

    ops_service.configure(call_fn=provider)
    for _ in range(2):
        client.get("/answer", params={"question_id": "q3b", "question": "질문"})
    assert calls["n"] == 2


def test_degraded_mode_is_not_cached(client):
    calls = {"n": 0}

    def provider(qid, q, *, deadline_s=None):
        calls["n"] += 1
        return _wire(qid, q), {"cacheable": True}

    ops_service.configure(
        call_fn=provider,
        readiness_fn=lambda: {"ready": True, "missing": [], "pins": {},
                              "mode": "degraded"})
    for _ in range(2):
        client.get("/answer", params={"question_id": "q4", "question": "질문"})
    assert calls["n"] == 2


def test_pins_change_invalidates_cache(client):
    calls = {"n": 0}

    def provider(qid, q, *, deadline_s=None):
        calls["n"] += 1
        return _wire(qid, q), {"cacheable": True}

    pins = {"v": 1}
    ops_service.configure(call_fn=provider,
                          readiness_fn=lambda: {"ready": True, "missing": [],
                                                "pins": dict(pins), "mode": "real"})
    client.get("/answer", params={"question_id": "q5", "question": "질문"})
    pins["v"] = 2                    # 설정 지문이 바뀌면 캐시 키도 바뀐다
    client.get("/answer", params={"question_id": "q5", "question": "질문"})
    assert calls["n"] == 2


def test_health_and_ready_are_separate(client):
    assert client.get("/health").json() == {"status": "ok"}
    assert client.get("/ready").status_code == 200
    ops_service.configure(readiness_fn=lambda: {"ready": False,
                                                "missing": ["index"], "pins": {}})
    assert client.get("/ready").status_code == 503
    assert client.get("/health").status_code == 200   # 프로세스 생존과 준비는 별개


def test_provider_exception_still_returns_five_fields(client):
    def provider(qid, q, *, deadline_s=None):
        raise RuntimeError("내부 폭발")

    ops_service.configure(call_fn=provider)
    r = client.get("/answer", params={"question_id": "q6", "question": "질문"})
    assert r.status_code == 200
    body = r.json()
    assert set(body) == set(ops_service.WIRE_KEYS)
    assert "fallback" in body["think_trace"]


def test_exception_fallback_is_not_cached(client):
    calls = {"n": 0}

    def provider(qid, q, *, deadline_s=None):
        calls["n"] += 1
        raise RuntimeError("내부 폭발")

    ops_service.configure(call_fn=provider)
    for _ in range(2):
        client.get("/answer", params={"question_id": "q7", "question": "질문"})
    assert calls["n"] == 2           # 예외 폴백 답이 박제되지 않는다


def test_semaphore_serializes_concurrent_requests(client):
    active = {"now": 0, "max": 0}
    lock = threading.Lock()

    def provider(qid, q, *, deadline_s=None):
        with lock:
            active["now"] += 1
            active["max"] = max(active["max"], active["now"])
        time.sleep(0.2)
        with lock:
            active["now"] -= 1
        return _wire(qid, q), {"cacheable": True}

    ops_service.configure(call_fn=provider)
    threads = [threading.Thread(target=lambda i=i: client.get(
        "/answer", params={"question_id": f"c{i}", "question": f"질문{i}"}))
        for i in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert active["max"] == 1        # 세마포어 1 — 동시 실행 없음


def test_dummy_mode_works_without_answer_api(monkeypatch):
    """answer_api가 없어도(스켈레톤) 유효한 5필드가 나오고 캐시는 안 된다.

    이제 저장소에 answer_api가 실존하므로, 부재 상황은 탐색 실패를 강제해 재현한다."""
    ops_service._cache.clear()
    monkeypatch.setattr(ops_service, "_load_provider",
                        lambda: (ops_service._dummy_call, ops_service._dummy_readiness))
    ops_service.configure()          # 자동 탐색 — answer_api 없으면 더미
    with TestClient(ops_service.app) as c:
        r = c.get("/answer", params={"question_id": "d1", "question": "확인"})
        assert r.status_code == 200
        body = r.json()
        assert set(body) == set(ops_service.WIRE_KEYS)
        assert all(isinstance(v, str) for v in body.values())
    assert ops_service._cache == {}  # 더미는 절대 캐시되지 않는다


def test_answer_replaces_invalid_fresh_wire_with_fallback(monkeypatch):
    """검수 4차 발견 3: provider가 None/불량 wire를 돌려줘도 200 + 유효 5필드여야 한다."""
    from fastapi.testclient import TestClient
    from dart_detective import ops_service as ops
    for bad in (None, {"question_id": "x"}, "문자열", 42):
        ops.configure(call_fn=lambda qid, q, deadline_s=None, _b=bad: (_b, {"cacheable": False}),
                      readiness_fn=lambda: {"ready": True, "pins": {}})
        ops._cache.clear()
        r = TestClient(ops.app).get("/answer", params={"question_id": "bad", "question": "q"})
        assert r.status_code == 200
        body = r.json()
        assert set(body) == set(ops.WIRE_KEYS)
        assert all(isinstance(v, str) for v in body.values()) and body["answer"]


def test_deadline_janitor_serializes_and_waiting_request_respects_deadline(monkeypatch):
    """검수 7·8차 발견 4: 데드라인 후에도 provider가 겹치지 않고, 세마포어 대기로 예산을
    넘긴 요청은 새 계산 없이 즉시 데드라인 폴백을 받는다."""
    import asyncio, threading, time
    import httpx
    from dart_detective import ops_service as ops
    monkeypatch.setenv("DART_QA_DEADLINE_S", "0.1")
    live = {"n": 0, "max": 0, "calls": 0}
    lock = threading.Lock()

    def slow_call(qid, q, deadline_s=None):
        with lock:
            live["n"] += 1; live["max"] = max(live["max"], live["n"]); live["calls"] += 1
        time.sleep(0.6)
        with lock:
            live["n"] -= 1
        return {"question_id": qid, "question": q, "retrieved_context": "", "think_trace": "{}",
                "answer": "느린 답"}, {"cacheable": False}

    ops.configure(call_fn=slow_call, readiness_fn=lambda: {"ready": True, "pins": {}})
    ops._cache.clear()

    async def run():
        transport = httpx.ASGITransport(app=ops.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
            r1, r2 = await asyncio.gather(
                c.get("/answer", params={"question_id": "j1", "question": "q"}),
                c.get("/answer", params={"question_id": "j2", "question": "q"}))
            await asyncio.sleep(0.8)
            return r1, r2
    r1, r2 = asyncio.run(run())
    assert r1.status_code == 200 and r2.status_code == 200
    assert live["max"] == 1                      # 겹침 없음
    assert live["calls"] == 1                    # 대기 중 데드라인 초과 요청은 계산을 시작하지 않음
    assert all(isinstance(v, str) for v in r2.json().values()) and r2.json()["answer"]


def test_provider_finishing_just_after_deadline_is_not_accepted(monkeypatch):
    """0.5초 폴링보다 빨리 끝나도 요청 데드라인을 넘긴 결과는 폴백이어야 한다."""
    import asyncio
    import time
    import httpx
    from dart_detective import ops_service as ops

    monkeypatch.setenv("DART_QA_DEADLINE_S", "0.05")

    def slightly_late(qid, q, deadline_s=None):
        time.sleep(0.10)
        return _wire(qid, q, answer="늦은 정상 답"), {"cacheable": True}

    ops.configure(call_fn=slightly_late,
                  readiness_fn=lambda: {"ready": True, "pins": {}, "mode": "real"})
    ops._cache.clear()

    async def run():
        transport = httpx.ASGITransport(app=ops.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as client:
            response = await client.get(
                "/answer", params={"question_id": "late", "question": "q"})
            await asyncio.sleep(0.12)  # janitor가 세마포어를 반환할 시간
            return response

    response = asyncio.run(run())
    assert response.status_code == 200
    assert response.json()["answer"] != "늦은 정상 답"
    assert '"reason": "deadline"' in response.json()["think_trace"]
