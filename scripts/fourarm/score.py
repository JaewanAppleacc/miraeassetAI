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
    args = p.parse_args(argv)
    if args.final and sorted(args.arms) != ["A", "B", "C", "D"]:
        print("--final은 --arms A B C D 전부를 요구한다", file=sys.stderr)
        return 1

    gold = fourarm.load_gold(args.gold)
    segments = fourarm.load_segments(args.conditions)
    gold_sha = hashlib.sha256(args.gold.read_bytes()).hexdigest()
    cond_sha = hashlib.sha256(args.conditions.read_bytes()).hexdigest()
    store = None if args.no_locator_check else NodeStore(args.index_dir)

    reports = {}
    packets: dict[str, dict] = {}                      # packet_id → 패킷 (arm 간 동일 패킷은 하나로)
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
        rep = fourarm.score_arm(arm, results, gold, segments, run=run, store=store,
                                conditions_sha=cond_sha, gold_sha=gold_sha)
        reports[arm] = rep
        (args.results_dir / f"score.{arm}.json").write_text(
            json.dumps(rep, ensure_ascii=False, indent=1), encoding="utf-8")
        arm_packets = fourarm.unresolved_packets(rep)
        for pk in arm_packets:
            packets.setdefault(pk["packet_id"], pk)
        print(f"[{arm}] 채점 완료 · 미해결 {len(arm_packets)}", file=sys.stderr)

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
        print(f"UNRESOLVED 패킷 {len(packets)}건 → {udir} (arm 라벨 없음)", file=sys.stderr)

    table = fourarm.summary_table(reports)
    out = [f"# 4-arm 채점 요약 (k={fourarm.EVAL_K} 평가 · Gold {gold_sha[:8]} · conditions {cond_sha[:8]})", "", table]
    if args.final:
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
            if run.get("arm") and run["arm"] != arm:
                print(f"최종 판정 불가 — {arm}.run.json의 arm={run['arm']} (파일명과 불일치)",
                      file=sys.stderr)
                return 1
            if not run.get("code_sha256") or not run.get("config_sha256"):
                print(f"최종 판정 불가 — {arm}.run.json에 code_sha256/config_sha256 없음",
                      file=sys.stderr)
                return 1
            rpath = args.results_dir / f"{arm}.results.jsonl"
            bad_rows = sum(1 for line in rpath.open(encoding="utf-8") if line.strip()
                           and json.loads(line).get("arm") not in (None, arm))
            if bad_rows:
                print(f"최종 판정 불가 — {arm}.results.jsonl에 다른 arm 행 {bad_rows}건",
                      file=sys.stderr)
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
                                  require_arms={"A", "B", "C", "D"} if args.final else None)
        (args.results_dir / "judgement.json").write_text(
            json.dumps(judgement, ensure_ascii=False, indent=1), encoding="utf-8")
        head = f"## 판정: {judgement['status']}"
        if judgement.get("winner"):
            head += f" → {judgement['winner']} ({judgement.get('selection_type')})"
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
