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


def _copy_bd_as_abcd(tmp_path):
    """B/D 실측 파일을 4-arm처럼 복제한 변조 시나리오용 디렉터리."""
    import json, shutil
    src = REPO / "results" / "fourarm"
    for arm, origin in (("A", "B"), ("B", "B"), ("C", "D"), ("D", "D")):
        shutil.copy(src / f"{origin}.results.jsonl", tmp_path / f"{arm}.results.jsonl")
        shutil.copy(src / f"{origin}.run.json", tmp_path / f"{arm}.run.json")
    return tmp_path


def test_final_detects_renamed_arm_files(tmp_path):
    """검수 5차 발견 4: B/D 결과를 A/C 이름만 바꿔 최종 판정에 넣으면 잡혀야 한다."""
    d = _copy_bd_as_abcd(tmp_path)
    rc = score.main(["--arms", "A", "B", "C", "D", "--final", "--no-locator-check",
                     "--results-dir", str(d)])
    assert rc == 1        # A.run.json의 arm=B — 파일명 불일치로 거부


def test_final_detects_results_tampering(tmp_path):
    import json
    d = _copy_bd_as_abcd(tmp_path)
    # arm 필드를 이름에 맞게 위조까지 해도, 파일 해시가 run.json 기록과 어긋나 거부돼야 한다.
    for arm in ("A", "C"):
        run = json.loads((d / f"{arm}.run.json").read_text(encoding="utf-8"))
        run["arm"] = arm
        (d / f"{arm}.run.json").write_text(json.dumps(run, ensure_ascii=False), encoding="utf-8")
        rows = [json.loads(l) for l in (d / f"{arm}.results.jsonl").open(encoding="utf-8")]
        for r in rows:
            r["arm"] = arm
        (d / f"{arm}.results.jsonl").write_text(
            "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")
    rc = score.main(["--arms", "A", "B", "C", "D", "--final", "--no-locator-check",
                     "--results-dir", str(d)])
    assert rc == 1        # results_sha256 불일치
