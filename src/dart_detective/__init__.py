"""
dart_detective — DART 공시 QA 백엔드.

파이프라인: 조건추출 -> Stage1/2 검색 -> 슬롯 근거매칭 -> 결정론 계산기 ->
HCX-005(문항당 1회) -> 검증기(근거 없는 숫자 차단) -> 신뢰도.

실행: uvicorn dart_detective.qa_api:app --port 8000
"""

__all__ = ["qa_service", "llm", "corpus_retriever", "answer_wire"]
