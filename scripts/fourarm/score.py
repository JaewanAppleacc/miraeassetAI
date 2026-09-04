"""4-arm 채점 + 판정 CLI — results/fourarm/{arm}.results.jsonl 들을 한 채점기로 채점하고 판정 체인을 돌린다.

실행:
    PYTHONIOENCODING=utf-8 .venv/bin/python scripts/fourarm/score.py --arms D            # 채점만
    PYTHONIOENCODING=utf-8 .venv/bin/python scripts/fourarm/score.py --arms A B C D      # 채점 + 판정
    옵션: --deployable B          vFINAL 19번 최소 배포 가능성 통과 arm (B fallback 판단용)
          --no-locator-check     NodeStore 없이 채점(치명/미해결 검사 생략 — 판정에는 쓰지 말 것)

출력 (results/fourarm/):
    score.{arm}.json      arm 리포트(세그먼트별 Recall@k·all_found·위반·pins·문항별)
    judgement.json        판정 체인 결과 (arm 2개 이상일 때)
    unresolved/u-x-NNN.json   UNRESOLVED 패킷(arm 라벨 제거 — vFINAL 16번)
    summary.md            표
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "src"))

from dart_corpus.evaluation import fourarm  # noqa: E402
from dart_corpus.retrieval.node_store import NodeStore  # noqa: E402


def _result_id_errors(path: Path, expected: set[str]) -> dict[str, list[str]]:
    """원시 JSONL의 문항 ID 완비·유일성을 검사한다(dict 로더의 중복 덮어쓰기 전)."""
    counts: dict[str, int] = {}
    for line in path.open(encoding="utf-8"):
        if not line.strip():
            continue
        row = json.loads(line)
        qid = str(row.get("question_id") or "")
        counts[qid] = counts.get(qid, 0) + 1
    actual = set(counts)
    return {
        "duplicates": sorted(qid for qid, n in counts.items() if n > 1),
        "missing": sorted(expected - actual),
        "unexpected": sorted(actual - expected),
    }


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="4-arm 채점·판정")
    p.add_argument("--arms", nargs="+", required=True, choices=["A", "B", "C", "D"])
    p.add_argument("--results-dir", type=Path, default=REPO / "results" / "fourarm")
    p.add_argument("--gold", type=Path, default=REPO / "data" / "eval" / "phase1_devtune_gold.v0.1.jsonl")
    p.add_argument("--conditions", type=Path, default=REPO / "data" / "eval" / "devtune101_conditions.v2.jsonl")
    p.add_argument("--index-dir", type=Path, default=REPO / "data" / "index")
    p.add_argument("--deployable", nargs="*", default=[])
    p.add_argument("--no-locator-check", action="store_true")
    p.add_argument("--final", action="store_true",
                   help="최종 판정 모드: A/B/C/D 완비·문항 누락 0·arm 간 입력 pin 일치를 강제한다. "
                        "결과 파일이 없으면 건너뛰지 않고 실패한다(검수 3차 발견 6).")
    p.add_argument("--registry", type=Path, default=REPO / "results" / "fourarm" / "arm_registry.json",
                   help="arm별 사전 등록 SHA(config·code·results) — 결과 디렉터리 밖(git 추적)의 "
                        "allowlist. 디렉터리 안 값끼리의 정합만으로는 완전 바꿔치기를 판별할 수 없다"
                        "(검수 8차 발견 3).")
    p.add_argument("--resolutions", type=Path, default=None,
                   help="vFINAL 16번 Owner 패킷 판정 파일({packet_id: {classification, note, critical}}). "
                        "주면 COMMON_SOURCE 공통 제외(한도 min(5, 세트 5%%))·ARM_SPECIFIC slot 실패 "
                        "재계산 후 판정한다. 제외 전 리포트는 score.{arm}.pre_adjudication.json으로 보존.")
    args = p.parse_args(argv)
    if args.final and sorted(args.arms) != ["A", "B", "C", "D"]:
        print("--final은 --arms A B C D 전부를 요구한다", file=sys.stderr)
        return 1

    gold = fourarm.load_gold(args.gold)
    segments = fourarm.load_segments(args.conditions)
    gold_sha = hashlib.sha256(args.gold.read_bytes()).hexdigest()
    cond_sha = hashlib.sha256(args.conditions.read_bytes()).hexdigest()
    if args.final:
        expected_ids = set(gold)
        for arm in args.arms:
            rpath = args.results_dir / f"{arm}.results.jsonl"
            if not rpath.exists():
                print(f"[{arm}] 결과 파일 없음: {rpath} — 최종 판정 불가", file=sys.stderr)
                return 1
            id_errors = _result_id_errors(rpath, expected_ids)
            if any(id_errors.values()):
                brief = {k: v[:5] for k, v in id_errors.items() if v}
                print(f"최종 판정 불가 — {arm} 결과 문항 ID 이상: "
                      f"{json.dumps(brief, ensure_ascii=False)}", file=sys.stderr)
                return 1
    store = None if args.no_locator_check else NodeStore(args.index_dir)

    reports = {}
    packets: dict[str, dict] = {}                      # packet_id → 패킷 (arm 간 동일 패킷은 하나로)
    all_results: dict[str, dict] = {}
    all_runs: dict[str, dict] = {}
    if args.no_locator_check:
        print("경고: --no-locator-check — Hard gate 미평가. judge는 INVALID를 돌려준다.", file=sys.stderr)
    for arm in args.arms:
        rpath = args.results_dir / f"{arm}.results.jsonl"
        runpath = args.results_dir / f"{arm}.run.json"
        if not rpath.exists():
            if args.final:
                print(f"[{arm}] 결과 파일 없음: {rpath} — 최종 판정 불가", file=sys.stderr)
                return 1
            print(f"[{arm}] 결과 파일 없음: {rpath} — 건너뜀", file=sys.stderr)
            continue
        results = fourarm.load_results(rpath)
        run = json.loads(runpath.read_text(encoding="utf-8")) if runpath.exists() else {}
        all_results[arm], all_runs[arm] = results, run
        rep = fourarm.score_arm(arm, results, gold, segments, run=run, store=store,
                                conditions_sha=cond_sha, gold_sha=gold_sha)
        reports[arm] = rep
        (args.results_dir / f"score.{arm}.json").write_text(
            json.dumps(rep, ensure_ascii=False, indent=1), encoding="utf-8")
        arm_packets = fourarm.unresolved_packets(rep)
        for pk in arm_packets:
            packets.setdefault(pk["packet_id"], pk)
        print(f"[{arm}] 채점 완료 · 미해결 {len(arm_packets)}", file=sys.stderr)

    # vFINAL 16번: Owner 판정 적용 — 공통 제외·ARM_SPECIFIC 무효화 후 재채점(결과 파일 불변).
    plan = None
    if args.resolutions is not None:
        resolutions = fourarm.load_resolutions(args.resolutions)
        plan = fourarm.adjudication_plan(reports, resolutions, n_set=len(gold))
        (args.results_dir / "adjudication.json").write_text(
            json.dumps({**plan, "per_arm_invalid": {
                a: {f"{q}|{s}": sorted(map(list, v)) for (q, s), v in m.items()}
                for a, m in plan["per_arm_invalid"].items()}}, ensure_ascii=False, indent=1),
            encoding="utf-8")
        if plan["over_limit"]:
            print(f"공통 제외 {len(plan['common_qids'])}건 > 한도 {plan['limit']} — BLOCKED(16번 A)",
                  file=sys.stderr)
        else:
            exclude = frozenset(plan["common_qids"])
            for arm in list(reports):
                (args.results_dir / f"score.{arm}.pre_adjudication.json").write_text(
                    json.dumps(reports[arm], ensure_ascii=False, indent=1), encoding="utf-8")
                rep = fourarm.score_arm(
                    arm, all_results[arm], gold, segments, run=all_runs[arm], store=store,
                    conditions_sha=cond_sha, gold_sha=gold_sha, exclude_qids=exclude,
                    invalid=plan["per_arm_invalid"].get(arm))
                # 16번 B "치명 확정": Owner가 치명으로 판정한 ARM_SPECIFIC은 Hard gate에 반영.
                for pid in plan["per_arm_critical"].get(arm, []):
                    rep["violations"]["critical"] += 1
                    rep["violations"]["items"].append(
                        {"severity": "critical", "reason": f"arm_specific_adjudicated_critical:{pid}"})
                # Owner "동등 근거" 판정: 위반 아님 확정 → 매치 유지, 경미로 강등 기록.
                fourarm.apply_equivalent_evidence(rep, plan["per_arm_equivalent"].get(arm, []))
                reports[arm] = rep
                (args.results_dir / f"score.{arm}.json").write_text(
                    json.dumps(rep, ensure_ascii=False, indent=1), encoding="utf-8")
            print(f"16번 적용: 공통 제외 {len(exclude)}건(한도 {plan['limit']}) · "
                  f"ARM_SPECIFIC {sum(len(m) for m in plan['per_arm_invalid'].values())}건 무효화 · "
                  f"UNKNOWN 잔여 {plan['unknown_per_arm']}", file=sys.stderr)

    if store is not None:
        store.close()
    if not reports:
        return 1
    if packets:
        udir = args.results_dir / "unresolved"
        udir.mkdir(exist_ok=True)
        for pid, pk in sorted(packets.items()):
            (udir / f"{pid}.json").write_text(json.dumps(pk, ensure_ascii=False, indent=1), encoding="utf-8")
        (udir / "index.json").write_text(json.dumps(sorted(packets), ensure_ascii=False, indent=1), encoding="utf-8")
        # Owner 판정 템플릿(전부 UNKNOWN) — 기존 resolutions.json은 덮어쓰지 않는다.
        tmpl = udir / "resolutions.template.json"
        tmpl.write_text(json.dumps(
            {pid: {"classification": "UNKNOWN", "note": "",
                   "_question_id": pk["question_id"], "_slot": pk["slot_name"], "_reason": pk["reason"]}
             for pid, pk in sorted(packets.items())}, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"UNRESOLVED 패킷 {len(packets)}건 → {udir} (arm 라벨 없음) · 판정 템플릿 {tmpl.name}",
              file=sys.stderr)

    table = fourarm.summary_table(reports)
    out = [f"# 4-arm 채점 요약 (k={fourarm.EVAL_K} 평가 · Gold {gold_sha[:8]} · conditions {cond_sha[:8]})", "", table]
    if args.final:
        # 외부 allowlist 대조(검수 8차 발견 3): 등록된 config/code/results SHA와 run.json이 전부
        # 일치해야 한다. 등록은 각 arm 실행 직후 git에 커밋한다(A/C는 팀원1 run.json 값을 등록).
        if not args.registry.exists():
            print(f"최종 판정 불가 — arm registry 없음: {args.registry}", file=sys.stderr)
            return 1
        registry = json.loads(args.registry.read_text(encoding="utf-8"))
        for arm in args.arms:
            reg = registry.get(arm)
            runpath = args.results_dir / f"{arm}.run.json"
            run = (json.loads(runpath.read_text(encoding="utf-8")) if runpath.exists() else {})
            if not reg:
                print(f"최종 판정 불가 — registry에 {arm} 미등록", file=sys.stderr)
                return 1
            for key in ("config_sha256", "code_sha256", "results_sha256"):
                if reg.get(key) != run.get(key):
                    print(f"최종 판정 불가 — {arm} {key}가 registry와 다름 "
                          f"(등록 {str(reg.get(key))[:12]}… ≠ run {str(run.get(key))[:12]}…)",
                          file=sys.stderr)
                    return 1
        # arm 간 입력 pin 일치(같은 Gold·conditions·코퍼스를 봤는가) — run.json(§1-3) 실키로 대조.
        # code_sha는 스택이 달라 arm별로 다를 수 있으므로 존재만 요구하고 일치는 강제하지 않는다.
        shared: dict[str, dict] = {}
        for arm in args.arms:
            runpath = args.results_dir / f"{arm}.run.json"
            run = (json.loads(runpath.read_text(encoding="utf-8")) if runpath.exists() else {})
            inp = run.get("input_sha256") or {}
            # gold는 없어야 정상이다 — 러너는 Gold를 열지 않는다(vFINAL 20번 비유출).
            # doc_index는 B/D 스택 전용 입력이라 arm 간 대조 대상이 아니다(A/C는 pgvector).
            shared[arm] = {"conditions": inp.get("conditions"),
                           "document_ir": inp.get("document_ir"),
                           "universe": inp.get("universe")}
            if run.get("arm") != arm:
                print(f"최종 판정 불가 — {arm}.run.json의 arm={run.get('arm')!r} (파일명과 불일치/누락)",
                      file=sys.stderr)
                return 1
            if not run.get("code_sha256") or not run.get("config_sha256"):
                print(f"최종 판정 불가 — {arm}.run.json에 code_sha256/config_sha256 없음",
                      file=sys.stderr)
                return 1
            # config 자체를 arm 정체성에 결박한다(검수 6차 발견 3: results_sha256만으로는 같은
            # 디렉터리 안에서 함께 고쳐 쓸 수 있다 — config.arm/label 대조 + sha 재계산까지 본다).
            cfg = run.get("config") or {}
            recomputed = hashlib.sha256(
                json.dumps(cfg, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
            if recomputed != run["config_sha256"]:
                print(f"최종 판정 불가 — {arm} config_sha256이 config 내용과 다름(변조 의심)",
                      file=sys.stderr)
                return 1
            if cfg.get("arm") != arm or cfg.get("label") != fourarm.ARM_LABELS.get(arm):
                print(f"최종 판정 불가 — {arm} config의 arm/label이 arm 정의와 다름: "
                      f"{cfg.get('arm')}/{cfg.get('label')}", file=sys.stderr)
                return 1
            # arm/label 문자열은 함께 위조할 수 있다 — 실제 설정 의미까지 arm 정의와 대조한다
            # (검수 7차 발견 3: B 결과의 config 전체를 A로 고쳐 써도 strategy=line_window가 남는다).
            # A/C(팀원1 스택)의 config에는 strategy(≠line_window)·dense 표시가 있어야 한다.
            is_lw = str(cfg.get("strategy") or "") == "line_window"
            dense_off = str(cfg.get("dense") or "off").lower() in ("off", "none", "false", "absent", "")
            expect_lw = arm in ("B", "D")
            expect_dense_off = arm in ("C", "D")
            if is_lw != expect_lw or dense_off != expect_dense_off:
                print(f"최종 판정 불가 — {arm} config 의미가 arm 정의와 다름: "
                      f"strategy={cfg.get('strategy')!r} dense={cfg.get('dense')!r} "
                      f"(기대: line_window={expect_lw}, dense_off={expect_dense_off})",
                      file=sys.stderr)
                return 1
            rpath = args.results_dir / f"{arm}.results.jsonl"
            # 결과 파일 사후 변조 검출(검수 5차 발견 4) + §1-1 행 SHA 결박(검수 6차 —
            # 행마다 config_sha256/code_sha256이 계약이다. 종전 "계약에 없음" 판단은 오독).
            actual = hashlib.sha256(rpath.read_bytes()).hexdigest()
            if run.get("results_sha256") != actual:
                print(f"최종 판정 불가 — {arm}.results.jsonl 해시가 run.json 기록과 다름 "
                      f"(기록 {str(run.get('results_sha256'))[:12]}… ≠ 실제 {actual[:12]}…)",
                      file=sys.stderr)
                return 1
            bad_rows = 0
            for line in rpath.open(encoding="utf-8"):
                if not line.strip():
                    continue
                row = json.loads(line)
                if (row.get("arm") != arm or row.get("config_sha256") != run["config_sha256"]
                        or row.get("code_sha256") != run["code_sha256"]):
                    bad_rows += 1
            if bad_rows:
                print(f"최종 판정 불가 — {arm}.results.jsonl에 arm/config/code SHA 불일치·누락 행 "
                      f"{bad_rows}건 (§1-1: 행마다 run 메타와 결박)", file=sys.stderr)
                return 1
        keys = ("conditions", "document_ir", "universe")
        missing_pins = {a: [k for k in keys if not shared[a].get(k)] for a in args.arms
                        if any(not shared[a].get(k) for k in keys)}
        if missing_pins:
            print(f"최종 판정 불가 — run.json input_sha256 누락: {missing_pins}", file=sys.stderr)
            return 1
        mismatched = {k: {a: shared[a][k] for a in args.arms} for k in keys
                      if len({json.dumps(shared[a][k], sort_keys=True) for a in args.arms}) > 1}
        if mismatched:
            print(f"최종 판정 불가 — arm 간 입력 pin 불일치: {json.dumps(mismatched, ensure_ascii=False)[:400]}",
                  file=sys.stderr)
            return 1

    judgement = None
    if len(reports) >= 2:
        judgement = fourarm.judge(reports, deployable={a: True for a in args.deployable},
                                  require_arms={"A", "B", "C", "D"} if args.final else None,
                                  adjudication=plan)
        (args.results_dir / "judgement.json").write_text(
            json.dumps(judgement, ensure_ascii=False, indent=1), encoding="utf-8")
        head = f"## 판정: {judgement['status']}"
        if judgement.get("winner"):
            head += f" → {judgement['winner']} ({judgement.get('selection_type')})"
        elif judgement.get("leader"):
            head += (f" — 부분 집합 {judgement.get('arm_set')} 선두 {judgement['leader']} "
                     f"({judgement.get('selection_basis')}) · 비공식 진단, 공식 승자 아님")
        elif judgement.get("candidate"):
            head += f" — 후보 {judgement['candidate']} (Owner UNRESOLVED 판정 후 재실행)"
        elif judgement.get("reason"):
            head += f" — {judgement['reason']}"
        out += ["", head,
                "", "```json", json.dumps(judgement["chain"], ensure_ascii=False, indent=1), "```"]
    (args.results_dir / "summary.md").write_text("\n".join(out) + "\n", encoding="utf-8")
    print("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
