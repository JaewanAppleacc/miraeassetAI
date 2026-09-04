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


def test_final_detects_full_forgery_with_recomputed_hashes(tmp_path):
    """검수 6차 발견 3: run.arm·행 arm·results_sha256까지 전부 고쳐 써도
    config.arm/label 결박과 config_sha256 재계산이 바꿔치기를 잡아야 한다."""
    import hashlib, json
    d = _copy_bd_as_abcd(tmp_path)
    for arm in ("A", "C"):
        rows = [json.loads(l) for l in (d / f"{arm}.results.jsonl").open(encoding="utf-8")]
        for r in rows:
            r["arm"] = arm
        body = "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n"
        (d / f"{arm}.results.jsonl").write_text(body, encoding="utf-8")
        run = json.loads((d / f"{arm}.run.json").read_text(encoding="utf-8"))
        run["arm"] = arm
        run["results_sha256"] = hashlib.sha256(body.encode("utf-8")).hexdigest()
        # config 내부의 arm은 B/D 그대로 — 여기서 걸려야 한다.
        (d / f"{arm}.run.json").write_text(json.dumps(run, ensure_ascii=False), encoding="utf-8")
    rc = score.main(["--arms", "A", "B", "C", "D", "--final", "--no-locator-check",
                     "--results-dir", str(d)])
    assert rc == 1


def test_final_requires_registered_shas_for_every_arm(tmp_path):
    """검수 8차 발견 3: 디렉터리 안 값을 전부 자기일관되게 고쳐 써도 외부 registry와 어긋나면 거부."""
    import hashlib, json
    d = _copy_bd_as_abcd(tmp_path)
    for arm, origin in (("A", "B"), ("C", "D")):
        rows = [json.loads(l) for l in (d / f"{arm}.results.jsonl").open(encoding="utf-8")]
        run = json.loads((d / f"{arm}.run.json").read_text(encoding="utf-8"))
        cfg = dict(run["config"]); cfg["arm"] = arm; cfg["label"] = score.fourarm.ARM_LABELS[arm]
        cfg["strategy"] = "fixed"; cfg["dense"] = "present" if arm == "A" else "off"
        csha = hashlib.sha256(json.dumps(cfg, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        for r in rows:
            r["arm"] = arm; r["config_sha256"] = csha
        body = "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n"
        (d / f"{arm}.results.jsonl").write_text(body, encoding="utf-8")
        run.update({"arm": arm, "config": cfg, "config_sha256": csha,
                    "results_sha256": hashlib.sha256(body.encode("utf-8")).hexdigest()})
        (d / f"{arm}.run.json").write_text(json.dumps(run, ensure_ascii=False), encoding="utf-8")
    rc = score.main(["--arms", "A", "B", "C", "D", "--final", "--no-locator-check",
                     "--results-dir", str(d)])
    assert rc == 1        # registry(git 추적)에 A/C 미등록 → 거부


def test_final_result_id_check_rejects_duplicates_missing_and_unknown(tmp_path):
    """dict 로더가 중복 ID를 덮어써도 --final 사전검사는 원시 행 이상을 잡아야 한다."""
    p = tmp_path / "A.results.jsonl"
    p.write_text(
        '{"question_id":"q1"}\n'
        '{"question_id":"q1"}\n'
        '{"question_id":"q3"}\n',
        encoding="utf-8")
    errors = score._result_id_errors(p, {"q1", "q2"})
    assert errors["duplicates"] == ["q1"]
    assert errors["missing"] == ["q2"]
    assert errors["unexpected"] == ["q3"]
