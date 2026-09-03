"""팀원2 운영 계약(interfaces.md §2) — ops_service 검증.

계약 요점: 파라미터 검증 400 · 5필드 전부 문자열 · 캐시(폴백·degraded 제외) ·
세마포어 1 · /health와 /ready 분리.
"""
from __future__ import annotations

import json
import threading
import time

import pytest
from fastapi.testclient import TestClient

from dart_detective import ops_service


@pytest.fixture()
def client():
    ops_service._cache.clear()
    ops_service.configure(
        answer_fn=lambda qid, q, *, deadline_s=None: {
            "question_id": qid, "question": q,
            "retrieved_context": "[근거1] x [/근거1]",
            "think_trace": json.dumps({"mode": "real"}),
            "answer": "답",
        },
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


def test_cache_hits_second_call(client):
    calls = {"n": 0}

    def provider(qid, q, *, deadline_s=None):
        calls["n"] += 1
        return {"question_id": qid, "question": q, "retrieved_context": "",
                "think_trace": json.dumps({"mode": "real"}), "answer": "답"}

    ops_service.configure(answer_fn=provider)
    for _ in range(2):
        assert client.get("/answer", params={"question_id": "q2",
                                             "question": "같은 질문"}).status_code == 200
    assert calls["n"] == 1


def test_fallback_answer_is_not_cached(client):
    calls = {"n": 0}

    def provider(qid, q, *, deadline_s=None):
        calls["n"] += 1
        return {"question_id": qid, "question": q, "retrieved_context": "",
                "think_trace": json.dumps({"fallback": True, "reason": "x"}),
                "answer": "폴백"}

    ops_service.configure(answer_fn=provider)
    for _ in range(2):
        client.get("/answer", params={"question_id": "q3", "question": "질문"})
    assert calls["n"] == 2           # 두 번 다 실계산 — 폴백은 박제하지 않는다


def test_degraded_mode_is_not_cached(client):
    calls = {"n": 0}

    def provider(qid, q, *, deadline_s=None):
        calls["n"] += 1
        return {"question_id": qid, "question": q, "retrieved_context": "",
                "think_trace": json.dumps({"mode": "real"}), "answer": "답"}

    ops_service.configure(
        answer_fn=provider,
        readiness_fn=lambda: {"ready": True, "missing": [], "pins": {},
                              "mode": "degraded"})
    for _ in range(2):
        client.get("/answer", params={"question_id": "q4", "question": "질문"})
    assert calls["n"] == 2


def test_pins_change_invalidates_cache(client):
    calls = {"n": 0}

    def provider(qid, q, *, deadline_s=None):
        calls["n"] += 1
        return {"question_id": qid, "question": q, "retrieved_context": "",
                "think_trace": json.dumps({"mode": "real"}), "answer": "답"}

    pins = {"v": 1}
    ops_service.configure(answer_fn=provider,
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

    ops_service.configure(answer_fn=provider)
    r = client.get("/answer", params={"question_id": "q6", "question": "질문"})
    assert r.status_code == 200
    body = r.json()
    assert set(body) == set(ops_service.WIRE_KEYS)
    assert "fallback" in body["think_trace"]


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
        return {"question_id": qid, "question": q, "retrieved_context": "",
                "think_trace": json.dumps({"mode": "real"}), "answer": "답"}

    ops_service.configure(answer_fn=provider)
    threads = [threading.Thread(target=lambda i=i: client.get(
        "/answer", params={"question_id": f"c{i}", "question": f"질문{i}"}))
        for i in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert active["max"] == 1        # 세마포어 1 — 동시 실행 없음


def test_dummy_mode_works_without_answer_api():
    """answer_api가 없어도(오늘의 스켈레톤) 유효한 5필드가 나온다."""
    ops_service.configure()          # 자동 탐색 — answer_api 없으면 더미
    with TestClient(ops_service.app) as c:
        r = c.get("/answer", params={"question_id": "d1", "question": "확인"})
    assert r.status_code == 200
    body = r.json()
    assert set(body) == set(ops_service.WIRE_KEYS)
    assert all(isinstance(v, str) for v in body.values())
