"""크레딧 쓰기 전 점검 — 환경변수·경로·프롬프트를 확인한다. **API를 부르지 않는다.**

확인 항목:
    1. LLM 환경변수: 어떤 provider가 선택되는가, 키가 들어왔는가(값은 마스킹)
    2. 엔드포인트/모델: 실제로 호출될 URL (키 없이도 계산된다)
    3. 코퍼스 인덱스 경로: /qa가 뜰 수 있는가
    4. 프롬프트 동결 상태: 버전 + 지문(fingerprint)
    5. 실제 전송될 프롬프트: --dump-prompt <질문> 으로 그대로 출력

실행:
    PYTHONIOENCODING=utf-8 python scripts/qa_preflight.py
    PYTHONIOENCODING=utf-8 python scripts/qa_preflight.py --dump-prompt "HMM의 2025년 매출액은?"
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))

from dart_detective import llm as llm_mod, qa_service  # noqa: E402
from dart_detective.agents import qa_agent  # noqa: E402

WATCHED_ENV = (
    "CLOVA_API_KEY", "CLOVA_MODEL", "CLOVA_ENDPOINT",
    "DART_DETECTIVE_LLM", "DART_DETECTIVE_LLM_PROVIDER",
    "DART_QA_DOC_INDEX", "DART_QA_DOCUMENTS", "DART_QA_UNIVERSE",
)
SECRET_ENV = {"CLOVA_API_KEY"}


def mask(name: str, value: str) -> str:
    """비밀값은 길이와 앞뒤 두 글자만 보여준다 — 로그로 새어도 키를 복원할 수 없다."""
    if name not in SECRET_ENV:
        return value
    if len(value) <= 6:
        return f"<설정됨 · {len(value)}자>"
    return f"{value[:2]}…{value[-2:]} · {len(value)}자"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump-prompt", default="",
                    help="이 질문으로 실제 전송될 프롬프트를 그대로 출력한다(호출 없음)")
    ap.add_argument("--chars", type=int, default=0,
                    help="프롬프트 출력 길이 제한(0=전체)")
    args = ap.parse_args()
    problems: list[str] = []

    print("=== 1. 환경변수")
    for name in WATCHED_ENV:
        value = os.environ.get(name)
        print(f"  {name:32}{mask(name, value) if value else '(없음)'}")

    print("\n=== 2. LLM provider")
    client = llm_mod.get_llm()
    if client is None:
        print("  선택된 provider: 없음 → 결정론적 fallback 경로로 동작한다")
        print(f"  기본 provider   : {llm_mod.DEFAULT_PROVIDER} "
              f"(CLOVA_API_KEY가 있으면 자동 선택)")
        print(f"  참고 · 호출될 URL: {llm_mod.CLOVA_DEFAULT_ENDPOINT}/"
              f"{os.environ.get('CLOVA_MODEL', llm_mod.CLOVA_DEFAULT_MODEL)}")
    else:
        print(f"  선택된 provider: {client.provider}")
        url = getattr(client, "url", None)
        if url:
            print(f"  호출될 URL     : {url}")
        print(f"  모델           : {getattr(client, 'model', '?')}")
    if os.environ.get("DART_DETECTIVE_LLM_PROVIDER", "").lower() == "anthropic":
        problems.append("provider가 anthropic으로 강제돼 있다 — 평가 대상은 HyperCLOVA X뿐이다")

    print("\n=== 3. 코퍼스 인덱스")
    for name, path in qa_service.qa_paths().items():
        mark = "OK " if path.exists() else "없음"
        size = f"{path.stat().st_size / 1e6:.1f}MB" if path.exists() else "-"
        print(f"  {mark} {name:14}{size:>10}  {path}")
    if qa_service.missing_paths():
        problems.append(f"인덱스 없음: {qa_service.missing_paths()} → /qa는 503을 낸다")

    print("\n=== 4. 프롬프트 동결")
    print(f"  version      {qa_agent.PROMPT_VERSION}")
    print(f"  fingerprint  {qa_agent.prompt_fingerprint()}")
    print(f"  발췌 청크 수  {qa_agent.LLM_CONTEXT_CHUNKS}")
    print(f"  응답 스키마   {qa_service.RESPONSE_SCHEMA_PATH.name}")

    if args.dump_prompt:
        print("\n=== 5. 실제 전송될 프롬프트 (호출 없음)")
        if qa_service.missing_paths():
            print("  인덱스가 없어 프롬프트를 만들 수 없다", file=sys.stderr)
            return 2
        state = qa_agent.answer_question(args.dump_prompt, qa_service.get_retriever())
        context = qa_agent.llm_context(state.retrieval_results)
        user = qa_agent.build_user_prompt(args.dump_prompt, state.evidence_matches,
                                          context)
        print(f"  --- system ({len(qa_agent.SYSTEM_PROMPT)}자) ---")
        print(qa_agent.SYSTEM_PROMPT)
        print(f"\n  --- user ({len(user)}자, 청크 {len(context)}개) ---")
        print(user if not args.chars else user[:args.chars])
        print(f"\n  검색 {state.timings.get('retrieval_ms')}ms · "
              f"근거 {len(state.evidence_matches)}건 · slot {list(state.slots)}")

    print()
    for p in problems:
        print(f"주의: {p}", file=sys.stderr)
    print("점검 완료" if not problems else f"점검 완료 — 확인 필요 {len(problems)}건")
    return 0


if __name__ == "__main__":
    sys.exit(main())
