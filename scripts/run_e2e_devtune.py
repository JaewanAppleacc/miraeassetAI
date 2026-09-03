"""통합 E2E — DEV_TUNE 101문항을 **서빙 경계(answer_api.answer_ex)** 그대로 돌린다.

qa_service가 부르는 함수를 그대로 부른다: ⓪ 정책 게이트 → ③ 라우팅 → 검색(D arm) → 근거 선택
→ 계산기 → (LLM: CLOVA_API_KEY 있으면 FC, 없으면 결정론 경로) → 검증 → ⑨ 폴백 → 5필드 직렬화.

키 없이 돌리면 비용 0으로 "LLM 이전의 전부"를 검증한다(v4 §16의 회귀 기준선 확보 단계).
키가 있으면 그대로 실 E2E가 된다 — 코드는 같다.

확인 항목:
    · 5필드 계약(전부 문자열·question_id echo) 위반 0
    · 답변가능성(NOT_FOUND/WITHHELD/SUPPORTED)이 Gold 기대와 일치하는가
    · 전략 분포 · 폴백 발동 · 캐시 가능 비율 · 검증 상태 분포 · 지연(p50/p95)

실행:
    PYTHONIOENCODING=utf-8 .venv/bin/python scripts/run_e2e_devtune.py
    옵션: --limit N · --out results/e2e/e2e.jsonl
"""
from __future__ import annotations

import argparse
import collections
import json
import statistics
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))

from dart_detective import answer_api  # noqa: E402


def trace_answerability(wire: dict) -> str:
    try:
        trace = json.loads(wire["think_trace"])
        return str((trace.get("validation") or {}).get("answerability") or "SUPPORTED")
    except Exception:  # noqa: BLE001
        return "?"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="DEV_TUNE 101 통합 E2E (서빙 경계)")
    p.add_argument("--gold", type=Path, default=REPO / "data" / "eval" / "phase1_devtune_gold.v0.1.jsonl")
    p.add_argument("--out", type=Path, default=REPO / "results" / "e2e" / "devtune101.jsonl")
    p.add_argument("--limit", type=int, default=0)
    args = p.parse_args(argv)

    rows = [json.loads(l) for l in args.gold.open(encoding="utf-8") if l.strip()]
    if args.limit:
        rows = rows[:args.limit]

    ready = answer_api.readiness()
    print(json.dumps({"readiness": {k: ready.get(k) for k in ("ready", "arm", "n_docs", "llm_enabled")}},
                     ensure_ascii=False), file=sys.stderr)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    contract_violations = 0
    ans_match = collections.Counter()
    strategies = collections.Counter()
    val_status = collections.Counter()
    llm_errors = collections.Counter()
    fallback_stages = collections.Counter()
    latencies = []
    n_cacheable = 0

    with args.out.open("w", encoding="utf-8") as f:
        for i, g in enumerate(rows, 1):
            qid, question = g["question_id"], g["question"]
            expected = g.get("expected_answerability", "SUPPORTED")
            t0 = time.perf_counter()
            wire, meta = answer_api.answer_ex(qid, question)
            ms = int((time.perf_counter() - t0) * 1000)
            latencies.append(ms)

            ok_contract = (set(wire) == {"question_id", "question", "retrieved_context",
                                         "think_trace", "answer"}
                           and all(isinstance(v, str) for v in wire.values())
                           and wire["question_id"] == qid and wire["question"] == question
                           and bool(wire["answer"]))
            if not ok_contract:
                contract_violations += 1
            got = trace_answerability(wire)
            ans_match[(expected, got)] += 1
            strategies[meta.get("strategy") or "?"] += 1
            val_status[meta.get("validation_status") or "?"] += 1
            if meta.get("llm_error"):
                llm_errors[str(meta["llm_error"])[:60]] += 1
            if meta.get("fallback_stage"):
                fallback_stages[meta["fallback_stage"]] += 1
            n_cacheable += int(bool(meta.get("cacheable")))

            f.write(json.dumps({
                "question_id": qid, "expected_answerability": expected, "got_answerability": got,
                "strategy": meta.get("strategy"), "validation_status": meta.get("validation_status"),
                "fallback_stage": meta.get("fallback_stage"), "cacheable": meta.get("cacheable"),
                "llm_used": meta.get("llm_used"), "llm_error": (meta.get("llm_error") or "")[:80],
                "latency_ms": ms,
                "answer_chars": len(wire["answer"]), "context_chars": len(wire["retrieved_context"]),
                "contract_ok": ok_contract,
            }, ensure_ascii=False) + "\n")
            if i % 20 == 0:
                print(f"{i}/{len(rows)} · 누적 {sum(latencies)/1000:.0f}s", file=sys.stderr, flush=True)

    matched = sum(v for (exp, got), v in ans_match.items()
                  if got == exp or (exp == "SUPPORTED" and got not in ("NOT_FOUND", "WITHHELD")))
    summary = {
        "n": len(rows),
        "llm_enabled": ready.get("llm_enabled"),
        "contract_violations": contract_violations,
        "answerability_match": f"{matched}/{len(rows)}",
        "answerability_confusion": {f"{e}->{g}": v for (e, g), v in sorted(ans_match.items()) if e != g
                                    and not (e == "SUPPORTED" and g not in ("NOT_FOUND", "WITHHELD"))},
        "strategies": dict(strategies.most_common()),
        "validation_status": dict(val_status.most_common()),
        "fallback_stages": dict(fallback_stages.most_common()),
        "llm_errors": dict(llm_errors.most_common(5)),
        "n_llm_errors": sum(llm_errors.values()),
        "cacheable": f"{n_cacheable}/{len(rows)}",
        "latency_ms": {"p50": int(statistics.median(latencies)),
                       "p95": int(sorted(latencies)[max(0, round(0.95 * len(latencies)) - 1)]),
                       "max": max(latencies), "total_s": round(sum(latencies) / 1000, 1)},
    }
    (args.out.parent / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1),
                                                  encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
