"""배포 리허설 — 주최측 평가 방식 그대로 공개 엔드포인트를 호출한다 (v4 §16 항목 6).

평가 공지 재현: GET {base}/answer?question_id&question · 순차 1건씩 · 타임아웃 300초 ·
타임아웃/5xx 시 최대 2회 재시도. 문항마다 5필드 계약·답변가능성(trace)·지연을 기록한다.

실행: PYTHONIOENCODING=utf-8 .venv/bin/python scripts/rehearsal_http.py http://<IP>
출력: results/rehearsal/rehearsal.jsonl · summary.json
"""
from __future__ import annotations

import collections
import json
import statistics
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
TIMEOUT_S = 300
MAX_RETRIES = 2


def get(base: str, params: dict, timeout: int = TIMEOUT_S
        ) -> tuple[int, dict | None, int, int, list[dict]]:
    """(status, json, latency_ms(성공 시도), retries, attempts) — 평가자 재현: 타임아웃/5xx만 재시도.

    attempts에는 시도별 소요·예외 문구를 남긴다 — 1차 리허설에서 재시도 원인(타임아웃인지
    연결 리셋인지)을 기록하지 않아 추적이 안 됐던 것의 교정."""
    url = f"{base}/answer?" + urllib.parse.urlencode(params)
    retries = 0
    attempts: list[dict] = []
    while True:
        t0 = time.perf_counter()
        try:
            with urllib.request.urlopen(url, timeout=timeout) as r:
                body = json.loads(r.read().decode("utf-8"))
                ms = int((time.perf_counter() - t0) * 1000)
                attempts.append({"ms": ms, "outcome": "200"})
                return r.status, body, ms, retries, attempts
        except urllib.error.HTTPError as e:
            ms = int((time.perf_counter() - t0) * 1000)
            attempts.append({"ms": ms, "outcome": f"HTTP {e.code}"})
            if e.code >= 500 and retries < MAX_RETRIES:
                retries += 1
                continue
            return e.code, None, ms, retries, attempts
        except Exception as e:  # noqa: BLE001 — 타임아웃·연결 오류
            ms = int((time.perf_counter() - t0) * 1000)
            attempts.append({"ms": ms, "outcome": f"{type(e).__name__}: {str(e)[:80]}"})
            if retries < MAX_RETRIES:
                retries += 1
                continue
            return 0, None, ms, retries, attempts


def trace_answerability(wire: dict) -> str:
    try:
        t = json.loads(wire["think_trace"])
        return str((t.get("validation") or {}).get("answerability") or "SUPPORTED")
    except Exception:  # noqa: BLE001
        return "?"


def main() -> int:
    base = sys.argv[1].rstrip("/")
    gold = [json.loads(l) for l in (REPO / "data/eval/phase1_devtune_gold.v0.1.jsonl").open(encoding="utf-8")]
    out_dir = REPO / "results" / "rehearsal"
    out_dir.mkdir(parents=True, exist_ok=True)

    lat, ans, n_contract_bad, n_http_bad, n_retried = [], collections.Counter(), 0, 0, 0
    with (out_dir / "rehearsal.jsonl").open("w", encoding="utf-8") as f:
        for i, g in enumerate(gold, 1):
            status, wire, ms, retries, attempts = get(base, {"question_id": g["question_id"],
                                                              "question": g["question"]})
            lat.append(ms)
            n_retried += retries
            ok_http = status == 200 and wire is not None
            if not ok_http:
                n_http_bad += 1
            ok_contract = bool(ok_http and set(wire) == {"question_id", "question",
                                                         "retrieved_context", "think_trace", "answer"}
                               and all(isinstance(v, str) for v in wire.values())
                               and wire["question_id"] == g["question_id"] and wire["answer"])
            if ok_http and not ok_contract:
                n_contract_bad += 1
            got = trace_answerability(wire) if ok_http else "?"
            exp = g.get("expected_answerability", "SUPPORTED")
            match = got == exp or (exp == "SUPPORTED" and got not in ("NOT_FOUND", "WITHHELD"))
            ans[match] += 1
            f.write(json.dumps({"question_id": g["question_id"], "http": status, "retries": retries,
                                "latency_ms": ms, "attempts": attempts, "contract_ok": ok_contract,
                                "expected": exp, "got": got, "match": match},
                               ensure_ascii=False) + "\n")
            if i % 10 == 0:
                print(f"{i}/101 · 누적 {sum(lat)/1000:.0f}s", file=sys.stderr, flush=True)

    summary = {
        "endpoint": base, "n": len(gold),
        "http_failures": n_http_bad, "retries_total": n_retried,
        "contract_violations": n_contract_bad,
        "answerability_match": f"{ans[True]}/{len(gold)}",
        "latency_ms": {"p50": int(statistics.median(lat)),
                       "p95": int(sorted(lat)[max(0, round(0.95 * len(lat)) - 1)]),
                       "max": max(lat), "total_s": round(sum(lat) / 1000, 1)},
        "timeout_budget_s": TIMEOUT_S,
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
