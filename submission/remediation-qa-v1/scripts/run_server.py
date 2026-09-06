#!/usr/bin/env python3
"""ARM_A4_A3_REMEDIATION_LIVE를 활성 백엔드로 하여 QA 서버를 기동한다.

`uvicorn dart_detective.ops_service:app`을 직접 쓰지 않고 이 스크립트가 존재하는 이유:
원본 커밋(b5f9443f) 시점에 ARM_A4_A3_REMEDIATION_LIVE 백엔드는 구현이 끝났지만
answer_api.py의 백엔드 디스패치 표(arm_a_serving_bridge.RETRIEVAL_BACKENDS /
answer_api._build_retriever())에는 아직 등록되지 않았다 — 그 배선은 백엔드를 추가한 변경의
범위 밖이었다. 제출을 위해 그 두 파일의 동작 코드를 패치해 원본과 달라지게 만드는 대신,
이 스크립트가 공개 빌더 함수로 remediation 검색기를 직접 만들어 answer_api의 기존 공개 훅
`reset()`으로 주입한 뒤, 주입 상태가 모든 요청에 보이도록 uvicorn을 같은 프로세스에서
시작한다. 이 스크립트는 패키지의 어떤 소스 파일도 수정하지 않는다 — 이미 존재하는 공개
함수만 호출한다.

사용법:
    python scripts/run_server.py                # 0.0.0.0:${PORT:-8000} 바인딩

.env.example에 문서화된 환경변수가 필요하다 — ARM_A4_A3_REMEDIATION_LIVE_*(이 스크립트가
Python 클라이언트를 통해 간접 기동하는 Node 워커가 소비)와 DART_QA_*(문서 메타데이터·조건
추출에 쓰는 기반 CorpusRetriever가 소비) 둘 다.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))


def main() -> None:
    from dart_detective import answer_api
    from dart_detective.arm_a4_a3_remediation_live_adapter import (
        build_arm_a4_a3_remediation_live_serving_retriever,
    )

    retriever, store, arm, pins = build_arm_a4_a3_remediation_live_serving_retriever()
    answer_api.reset(retriever)
    # answer_api.reset()은 의도적으로 _store/_arm/_arm_pins를 비운다(그 훅은 그런 부기가
    # 없는 테스트 대역용으로 존재한다) — readiness()의 "arm"/"pins" 필드가 미구성 기본값
    # 대신 ARM_A4_A3_REMEDIATION_LIVE를 정확히 보고하도록 여기서 명시적으로 설정한다.
    # answer_api._build_retriever() 자신이 할당했을 모듈 수준 이름들과 동일하다.
    answer_api._store = store  # noqa: SLF001 -- see docstring above
    answer_api._arm = arm  # noqa: SLF001
    answer_api._arm_pins = pins  # noqa: SLF001

    readiness = answer_api.readiness()
    print(f"readiness before serving: {readiness}", file=sys.stderr)
    if not readiness.get("ready"):
        print("WARNING: readiness() reports ready=False -- check env vars / worker "
             "connectivity before sending real traffic.", file=sys.stderr)

    import uvicorn

    from dart_detective.ops_service import app

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")), workers=1)


if __name__ == "__main__":
    main()
