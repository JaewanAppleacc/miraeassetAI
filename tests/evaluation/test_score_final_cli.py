"""score.py --final 모드 — A/B/C/D 완비 강제(검수 3·4차 발견 6)."""
from __future__ import annotations

import importlib.util
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("fourarm_score", REPO / "scripts" / "fourarm" / "score.py")
score = importlib.util.module_from_spec(spec)
spec.loader.exec_module(score)


def test_final_requires_all_four_arms_listed():
    assert score.main(["--arms", "B", "D", "--final", "--no-locator-check"]) == 1


def test_final_fails_on_missing_results_file():
    # 저장소에는 B/D 결과만 있다 — A가 없으면 건너뛰지 않고 실패해야 한다.
    assert score.main(["--arms", "A", "B", "C", "D", "--final", "--no-locator-check"]) == 1
