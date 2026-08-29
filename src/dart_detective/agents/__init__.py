"""Agent 모음.

  evidence_agent  탐정게임(Case Pack + PointInTimeRetriever)용
  qa_agent        코퍼스 Retrieval(Stage 1/2) 위에 얹는 QA orchestration
  tutor_agent     힌트
  validator       Agent 출력 검증기(두 Agent가 공유)
"""

__all__ = ["evidence_agent", "qa_agent", "tutor_agent", "validator"]
