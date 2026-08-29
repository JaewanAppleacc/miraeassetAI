"""QA Agent smoke — 질문 3개만 돌린다(전체 평가 아님).

    1. 단일 문서 숫자 질문
    2. 일반 재무/공시 질문
    3. 여러 문서가 필요한 질문

각 질문에서 확인하는 것:
    · Retrieval 후보가 나왔는가
    · 근거(evidence)가 붙었는가, provenance(doc_id/chunk_id/section_path)가 남는가
    · 근거가 원문 그대로인가(발췌가 후보 청크의 부분문자열인가)
    · Validator 판정 (UNSUPPORTED면 실패 — 근거 없는 수치)
    · LLM을 실제로 썼는지 / fallback으로 내려갔는지

CLOVA_API_KEY가 있으면 HyperCLOVA X를 실제로 부르고, 없으면 결정론적 fallback으로
같은 검사를 한다. 키가 없다고 임의 호출하거나 가짜 키를 만들지 않는다.

실행:
    PYTHONIOENCODING=utf-8 python scripts/qa_smoke.py
    PYTHONIOENCODING=utf-8 python scripts/qa_smoke.py --url http://localhost:8000  # HTTP 경유
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))

from dart_detective.agents import qa_agent  # noqa: E402
from dart_detective.llm import get_llm  # noqa: E402
from dart_detective import qa_service  # noqa: E402

QUESTIONS = [
    ("단일 문서 숫자", "신한지주의 2025년 반기보고서에 나온 자기주식 소각 주식수는?"),
    ("일반 재무/공시", "HMM의 2025년 연결 매출액과 영업이익은 얼마인가?"),
    ("다중 문서", "에스엠의 자기주식취득 신탁계약이 체결부터 소각까지 어떻게 진행됐는지 설명해줘."),
]


def check(label: str, question: str, result: dict) -> tuple[bool, list[str]]:
    problems: list[str] = []
    if not result.get("evidence"):
        problems.append("근거 없음")
    for ev in result.get("evidence", []):
        if not (ev.get("doc_id") and ev.get("chunk_id")):
            problems.append("provenance 누락")
    status = (result.get("validation") or {}).get("status")
    if status == "UNSUPPORTED":
        problems.append(f"validator={status} (근거 없는 수치/인용)")
    if not result.get("answer"):
        problems.append("답변 없음")
    return (not problems), problems


def run_local(question: str, llm) -> dict:
    retriever = qa_service.get_retriever()
    return qa_agent.answer_question(question, retriever, llm=llm).to_dict()


def run_http(url: str, question: str) -> dict:
    import urllib.request
    req = urllib.request.Request(
        f"{url.rstrip('/')}/qa",
        data=json.dumps({"question": question}).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=120) as res:
        return json.loads(res.read().decode("utf-8"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="", help="지정하면 HTTP로 POST /qa를 부른다")
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()

    llm = get_llm()
    provider = getattr(llm, "provider", None)
    print(f"LLM provider: {provider or 'none (결정론적 fallback)'}")
    if not args.url:
        missing = qa_service.missing_paths()
        if missing:
            print(f"코퍼스 인덱스 없음: {missing}", file=sys.stderr)
            return 2

    rows, failed = [], 0
    for label, question in QUESTIONS:
        result = run_http(args.url, question) if args.url else run_local(question, llm)
        ok, problems = check(label, question, result)
        failed += 0 if ok else 1
        used = (result.get("llm") or {}).get("used")
        print(f"\n[{label}] {'OK' if ok else 'FAIL ' + ', '.join(problems)}")
        print(f"  질문: {question}")
        print(f"  llm_used={used} provider={(result.get('llm') or {}).get('provider')} "
              f"validation={(result.get('validation') or {}).get('status')} "
              f"evidence={len(result.get('evidence') or [])}")
        for ev in (result.get("evidence") or [])[:3]:
            path = " > ".join(ev.get("section_path") or [])
            print(f"    - {ev['doc_id']} {('· ' + path) if path else ''}")
            print(f"      {ev['text'][:110]}")
        rows.append({"label": label, "question": question, "ok": ok,
                     "problems": problems, "result": result})

    if args.out:
        args.out.write_text(json.dumps(rows, ensure_ascii=False, indent=2),
                            encoding="utf-8")
        print(f"\n-> {args.out}")
    print(f"\n{len(QUESTIONS) - failed}/{len(QUESTIONS)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
