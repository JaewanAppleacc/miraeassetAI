"""4-arm 러너(B/D) — 사전 계산 조건으로 101문항을 검색하고 interfaces.md §1-1·§1-3 형식으로 기록한다.

non-leak(vFINAL 20번)은 구조로 보장한다: 이 스크립트는 Gold 파일을 열지 않는다. 질문 목록과 조건은
사전 계산 파일(devtune101_conditions.v1.jsonl)에서만 읽는다.

실행:
    PYTHONIOENCODING=utf-8 .venv/bin/python scripts/fourarm/run_arm.py --arm D
    PYTHONIOENCODING=utf-8 .venv/bin/python scripts/fourarm/run_arm.py --arm B      # KURE 필요

출력 (results/fourarm/):
    {arm}.results.jsonl   문항당 1줄 {question_id, arm, segment, results[…], latency_ms}
    {arm}.run.json        실행 메타: config·config_sha256·code_sha256·input_sha256·latency p50/p95·peak_rss_mb

측정(vFINAL 18번): 첫 문항으로 warm-up 1회(미기록) 후 101문항 순서 고정. peak RSS는 이 프로세스의 ru_maxrss.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import platform
import resource
import statistics
import subprocess
import sys
import time
import unicodedata
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "src"))

from dart_detective import retriever_adapter as ra  # noqa: E402

REPORT_K = 20          # 보고 k=5/10/20 → 20개까지 기록 (vFINAL 15번)


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def text_sha(text: str) -> str:
    norm = "".join(unicodedata.normalize("NFC", text or "").split())
    return hashlib.sha256(norm.encode("utf-8")).hexdigest()


def git_head() -> str:
    try:
        return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip()
    except Exception:  # noqa: BLE001
        return "unknown"


def peak_rss_mb() -> float:
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return round(rss / (1024 * 1024 if platform.system() == "Darwin" else 1024), 1)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="4-arm 러너 (B/D)")
    p.add_argument("--arm", required=True, choices=["B", "D"])
    p.add_argument("--conditions", type=Path,
                   default=REPO / "data" / "eval" / "devtune101_conditions.v1.jsonl")
    p.add_argument("--out-dir", type=Path, default=REPO / "results" / "fourarm")
    p.add_argument("--k", type=int, default=REPORT_K)
    p.add_argument("--limit", type=int, default=0, help="디버그용: 앞 N문항만")
    args = p.parse_args(argv)

    rows = [json.loads(l) for l in args.conditions.open(encoding="utf-8") if l.strip()]
    if args.limit:
        rows = rows[:args.limit]

    started = time.strftime("%Y-%m-%dT%H:%M:%S")
    t_bind = time.perf_counter()
    adapter = ra.bind(args.arm)
    bind_s = round(time.perf_counter() - t_bind, 1)
    ready = adapter.readiness()
    if not ready.get("ready"):
        print(json.dumps({"status": "BLOCKED", "reason": "adapter not ready", "readiness": ready},
                         ensure_ascii=False, indent=1))
        return 2

    # warm-up (미기록) — vFINAL 18번 "동일 warm-up 후 측정"
    adapter.search(rows[0]["question"], conditions=rows[0]["conditions"], k=args.k)

    args.out_dir.mkdir(parents=True, exist_ok=True)
    results_path = args.out_dir / f"{args.arm}.results.jsonl"
    latencies: list[int] = []
    n_err = 0
    with results_path.open("w", encoding="utf-8") as f:
        for i, r in enumerate(rows, 1):
            t0 = time.perf_counter()
            rec = {"question_id": r["question_id"], "arm": args.arm, "segment": r["segment"]}
            try:
                chunks = adapter.search(r["question"], conditions=r["conditions"], k=args.k)
                rec["results"] = [{
                    "rank": j + 1,
                    "doc_id": c["doc_id"],
                    "node_index": c["node_index"],
                    "locator": c["locator"],
                    "chunk_id": c["chunk_id"],
                    "chunk_text_sha256": text_sha(c["text"]),
                    "score": round(float(c["score"]), 6),
                    "text": c["text"],
                } for j, c in enumerate(chunks[:args.k])]
                rec["dense_reranked"] = bool(getattr(adapter, "last", {}).get("dense_reranked"))
                rec["pool"] = getattr(adapter, "last", {}).get("pool")
            except Exception as exc:  # noqa: BLE001 — 실패 문항만 재실행 금지(15번), 기록하고 계속
                rec["results"] = []
                rec["error"] = f"{type(exc).__name__}: {exc}"
                n_err += 1
            rec["latency_ms"] = int((time.perf_counter() - t0) * 1000)
            latencies.append(rec["latency_ms"])
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            if i % 20 == 0:
                print(f"{args.arm}: {i}/{len(rows)} · 누적 {sum(latencies)/1000:.0f}s", file=sys.stderr, flush=True)

    pins = ready.get("pins") or {}
    config = {
        "arm": args.arm, "label": ready.get("label"), "k": args.k,
        "strategy": pins.get("strategy"), "stage1_k": pins.get("stage1_k"), "chunk_k": pins.get("chunk_k"),
        "text_recipe": pins.get("text_recipe"), "text_cap": pins.get("text_cap"),
        "dense": ready.get("dense"), "dense_model": pins.get("dense_model"), "dense_rev": pins.get("dense_rev"),
        "dense_pool": pins.get("dense_pool"), "dense_device": pins.get("dense_device"),
        "dense_dtype": pins.get("dense_dtype"),
        "conditions_source": "precomputed",
    }
    index_manifest = json.loads((REPO / "data" / "index" / "index_manifest.json").read_text(encoding="utf-8"))
    run = {
        "arm": args.arm, "label": ready.get("label"),
        "started_at": started, "finished_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "host": platform.node(), "platform": platform.platform(), "python": platform.python_version(),
        "code_sha256": git_head(),
        "config": config,
        "config_sha256": hashlib.sha256(json.dumps(config, sort_keys=True, ensure_ascii=False).encode()).hexdigest(),
        "input_sha256": {
            "conditions": sha256_file(args.conditions),
            "document_ir": {k: v["sha256"] for k, v in index_manifest["files"].items()},
            "doc_index": index_manifest.get("doc_index_sha256"),
            "universe": sha256_file(REPO / "data" / "corpus" / "universe.csv"),
            "manifest": index_manifest.get("manifest_sha256"),
        },
        "n_questions": len(rows), "n_errors": n_err,
        "bind_s": bind_s,
        "latency_ms": {
            "p50": int(statistics.median(latencies)),
            "p95": int(sorted(latencies)[max(0, int(round(0.95 * len(latencies))) - 1)]),
            "mean": int(statistics.mean(latencies)), "max": max(latencies), "total_s": round(sum(latencies) / 1000, 1),
        },
        "peak_rss_mb": peak_rss_mb(),
        "external_services": ready.get("external_services", []),
        "results_sha256": sha256_file(results_path),
    }
    (args.out_dir / f"{args.arm}.run.json").write_text(json.dumps(run, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: run[k] for k in ("arm", "label", "n_questions", "n_errors", "bind_s", "latency_ms",
                                          "peak_rss_mb", "config_sha256", "results_sha256")},
                     ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
