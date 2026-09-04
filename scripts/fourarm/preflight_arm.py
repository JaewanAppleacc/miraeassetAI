"""단일 arm 사전점검 — A/C 산출물을 score.py --final에 넣기 **전에** 혼자서 검증한다.

팀원1 요청(임베딩 도는 동안 사전 대조로 완료 후 2~3시간 단축): --final은 4-arm 완비를
요구하므로 혼자서는 못 돌린다. 이 스크립트는 --final이 arm 하나에 대해 검사하는 것 전부를
단일 arm에 대해 미리 돌려, 형식·pin 문제를 러너 완료 직후 그 자리에서 잡는다.

실행:
    PYTHONIOENCODING=utf-8 python scripts/fourarm/preflight_arm.py --arm A \
        [--results-dir results/fourarm] [--no-locator-check]

검사 항목(= score.py --final의 단일 arm 몫):
  파일: {arm}.results.jsonl + {arm}.run.json 존재
  run.json: arm/config.arm/config.label 일치 · config 의미(strategy·dense)가 arm 정의와 일치 ·
            config_sha256 재계산 일치 · code_sha256 존재 · results_sha256 = 파일 해시 ·
            input_sha256.{conditions, document_ir, universe}가 고정 pin과 일치
  행: 101문항 ID 완비·유일(gold와 정확히 일치) · 행마다 arm/config_sha256/code_sha256이
      run.json과 결박 · rank 1..k 연속 · 필수 필드 · locator 파싱·doc/node 일치
  (색인 있으면) doc_id 존재·node_index 범위 검증
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

# 고정 pin — 모든 arm이 같은 입력을 봤어야 한다(vFINAL·interfaces §1).
PIN = {
    "conditions": "83d5b8a02de2e3e79e388ec417ed104c81b08eb0a8dc8a8366b020df36b5e527",
    "universe": "96560165c836b10e315cb253ab96a99b369478c3f71a0415d16b7b6fadbfa1dc",
    "gold": "7941144c09ce25debeeab6c3fbdfbd4c16761a6be06ab3a844ad159c832f102b",
    "document_ir": {
        "exchange.jsonl": "80000c1c12f09bb59ce5bea41f62c5a70a39bdc965859c8436c261e9bde02c2a",
        "holding.jsonl": "fd88d83c53a4c465ec1cbedce0a41046cfa7819822e2d7df046fccf42b8cbc09",
        "major.jsonl": "5c58da7ad32fe31603f59bdea6829c29e6cb00b823c336b6e90b71f41d25d3ba",
        "periodic.jsonl": "0aee546312b93797cf35f946144e044d8f43a947c38bb49b0766b623076be852",
    },
}
RESULT_ITEM_KEYS = {"rank", "doc_id", "node_index", "locator", "chunk_id",
                    "chunk_text_sha256", "score"}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="단일 arm 사전점검")
    p.add_argument("--arm", required=True, choices=["A", "B", "C", "D"])
    p.add_argument("--results-dir", type=Path, default=REPO / "results" / "fourarm")
    p.add_argument("--gold", type=Path, default=REPO / "data" / "eval" / "phase1_devtune_gold.v0.1.jsonl")
    p.add_argument("--index-dir", type=Path, default=REPO / "data" / "index")
    p.add_argument("--no-locator-check", action="store_true")
    p.add_argument("--k", type=int, default=20)
    args = p.parse_args(argv)
    arm = args.arm
    issues: list[str] = []
    warn: list[str] = []

    rpath = args.results_dir / f"{arm}.results.jsonl"
    runpath = args.results_dir / f"{arm}.run.json"
    for path in (rpath, runpath):
        if not path.exists():
            print(f"FAIL — 파일 없음: {path}")
            return 1

    run = json.loads(runpath.read_text(encoding="utf-8"))
    cfg = run.get("config") or {}
    if run.get("arm") != arm:
        issues.append(f"run.arm={run.get('arm')!r} ≠ 파일명 arm {arm!r}")
    if cfg.get("arm") != arm:
        issues.append(f"config.arm={cfg.get('arm')!r} ≠ {arm!r}")
    if cfg.get("label") != fourarm.ARM_LABELS[arm]:
        issues.append(f"config.label={cfg.get('label')!r} ≠ {fourarm.ARM_LABELS[arm]!r}")
    is_lw = str(cfg.get("strategy") or "") == "line_window"
    dense_off = str(cfg.get("dense") or "off").lower() in ("off", "none", "false", "absent", "")
    if is_lw != (arm in ("B", "D")):
        issues.append(f"config.strategy={cfg.get('strategy')!r} — {arm}은 line_window={'필수' if arm in ('B','D') else '금지'}")
    if dense_off != (arm in ("C", "D")):
        issues.append(f"config.dense={cfg.get('dense')!r} — {arm}은 dense {'off' if arm in ('C','D') else 'on'} 이어야 함")
    recomputed = hashlib.sha256(json.dumps(cfg, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    if recomputed != run.get("config_sha256"):
        issues.append("config_sha256이 config 내용의 sha256(json.dumps(config, sort_keys=True, "
                      "ensure_ascii=False))과 다름")
    if not run.get("code_sha256"):
        issues.append("code_sha256 없음(실행 시점 git HEAD)")
    actual = hashlib.sha256(rpath.read_bytes()).hexdigest()
    if run.get("results_sha256") != actual:
        issues.append(f"results_sha256 불일치: run={str(run.get('results_sha256'))[:12]}… 실제={actual[:12]}…")

    inp = run.get("input_sha256") or {}
    if inp.get("conditions") != PIN["conditions"]:
        issues.append(f"input_sha256.conditions ≠ v2 pin({PIN['conditions'][:12]}…) — conditions v2를 그대로 썼는지 확인")
    if inp.get("universe") != PIN["universe"]:
        issues.append("input_sha256.universe ≠ pin")
    ir = inp.get("document_ir") or {}
    for name, sha in PIN["document_ir"].items():
        got = ir.get(name) or ir.get(name.replace(".jsonl", ""))
        if got != sha:
            issues.append(f"input_sha256.document_ir[{name}] ≠ pin({sha[:12]}…)")
    if inp.get("gold") not in (None, PIN["gold"]):
        issues.append("input_sha256.gold이 Gold pin과 다름(러너는 Gold를 열면 안 됨 — 키 자체가 없어도 정상)")

    gold_ids = {json.loads(l)["question_id"] for l in args.gold.open(encoding="utf-8") if l.strip()}
    counts: dict[str, int] = {}
    n_err = 0
    store = None
    if not args.no_locator_check:
        try:
            from dart_corpus.retrieval.node_store import NodeStore
            store = NodeStore(args.index_dir)
        except Exception as exc:  # noqa: BLE001
            warn.append(f"색인 없음 → doc/node 존재 검증 생략({type(exc).__name__}). "
                        "scripts/build_index.py 후 재실행하면 완전 검증")
    for i, line in enumerate(rpath.open(encoding="utf-8"), 1):
        if not line.strip():
            continue
        row = json.loads(line)
        qid = str(row.get("question_id") or "")
        counts[qid] = counts.get(qid, 0) + 1
        if row.get("arm") != arm:
            issues.append(f"행 {i}: arm={row.get('arm')!r}")
        if row.get("config_sha256") != run.get("config_sha256"):
            issues.append(f"행 {i}: config_sha256이 run.json과 다름/누락")
        if row.get("code_sha256") != run.get("code_sha256"):
            issues.append(f"행 {i}: code_sha256이 run.json과 다름/누락")
        if row.get("error"):
            n_err += 1
            if row.get("results"):
                issues.append(f"행 {i}: error인데 results 비어있지 않음")
            continue
        results = row.get("results")
        if not isinstance(results, list):
            issues.append(f"행 {i}: results가 목록이 아님(실패면 results:[] + error)")
            continue
        # 빈 목록은 정당하다 — 검색 0건 문항(함정·기업 미검출 계열, B/D 실측 행 48).
        if not results:
            continue
        if len(results) > args.k:
            issues.append(f"행 {i}: results {len(results)}개 > k={args.k}")
        for j, item in enumerate(results, 1):
            missing = RESULT_ITEM_KEYS - set(item)
            if missing:
                issues.append(f"행 {i} rank{j}: 필드 누락 {sorted(missing)}")
                break
            if item["rank"] != j:
                issues.append(f"행 {i}: rank가 1부터 연속이 아님({j}번째가 rank={item['rank']})")
                break
            parsed = fourarm.parse_locator(str(item["locator"] or ""))
            if parsed is None:
                issues.append(f"행 {i} rank{j}: locator 파싱 불가: {item['locator']!r}")
                break
            if parsed[0] != item["doc_id"] or parsed[1] != item["node_index"]:
                issues.append(f"행 {i} rank{j}: locator({parsed[0]}#{parsed[1]})가 doc_id/node_index 필드와 다름")
                break
            if store is not None:
                if item["doc_id"] not in store:
                    issues.append(f"행 {i} rank{j}: doc_id가 코퍼스에 없음: {item['doc_id']}")
                    break
                n_nodes = store.location(item["doc_id"]).n_nodes
                nodes = set(item.get("node_indices") or []) | {item["node_index"]}
                bad = [n for n in nodes if not 0 <= int(n) < n_nodes]
                if bad:
                    issues.append(f"행 {i} rank{j}: node_index 범위 밖 {bad} (n_nodes={n_nodes})")
                    break
        if len(issues) > 40:
            issues.append("… (이후 생략)")
            break

    dup = sorted(q for q, n in counts.items() if n > 1)
    missing_ids = sorted(gold_ids - set(counts))
    unexpected = sorted(set(counts) - gold_ids)
    if dup:
        issues.append(f"중복 question_id {len(dup)}건: {dup[:3]}…")
    if missing_ids:
        issues.append(f"누락 question_id {len(missing_ids)}건: {missing_ids[:3]}…")
    if unexpected:
        issues.append(f"gold에 없는 question_id {len(unexpected)}건: {unexpected[:3]}…")
    if run.get("n_questions") not in (None, len(counts)):
        issues.append(f"run.n_questions={run.get('n_questions')} ≠ 실제 행 {len(counts)}")
    if run.get("n_errors") not in (None, n_err):
        warn.append(f"run.n_errors={run.get('n_errors')} ≠ 실제 error 행 {n_err}")
    lat = run.get("latency_ms") or {}
    if not (isinstance(lat.get("p50"), int) and isinstance(lat.get("p95"), int)):
        issues.append("latency_ms.p50/p95 없음(vFINAL 18번)")
    if not isinstance(run.get("peak_rss_mb"), (int, float)):
        issues.append("peak_rss_mb 없음(vFINAL 18번)")
    if not isinstance(run.get("external_services"), list):
        issues.append("external_services 목록 없음(배포 tie-break 입력)")

    for w in warn:
        print(f"WARN — {w}")
    if issues:
        print(f"FAIL — {arm}: {len(issues)}건")
        for x in issues[:40]:
            print("  ·", x)
        return 1
    print(f"PASS — {arm}: 행 {len(counts)}개(오류 {n_err}) · results_sha256 {actual[:12]}… · "
          f"config_sha256 {run['config_sha256'][:12]}… · code {run['code_sha256'][:12]}…")
    print("다음 단계: 세 SHA(config/code/results)를 지영에게 보내 arm_registry.json 등록 → "
          "4-arm 합류 시 score.py --arms A B C D --final")
    return 0


if __name__ == "__main__":
    sys.exit(main())
