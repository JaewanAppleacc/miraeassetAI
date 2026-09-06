"""run_arm_a4_a3_live_family — retrieval-only DEV_TUNE-101 runner for the live A4/A3
worker family (ARM_A4_A3_LIVE, ARM_A4_A3_REMEDIATION_LIVE).

Turn A4-A3-REMEDIATION-INTEGRATION-V1, Section H. Neither `scripts/fourarm/run_arm.py`
(B/D only, via retriever_adapter.bind()) nor answer_api/qa_service (which would pull in
QA Evidence V2/DocumentBinder/HCX -- explicitly out of this turn's scope) drives the live
A4/A3 workers against the full precomputed conditions file, so this is a new, small,
retrieval-only script: for each of the 101 pre-computed conditions, calls the named
backend's worker `search()` directly (bypassing answer_api entirely), and writes results
in the same {arm}.results.jsonl / {arm}.run.json shape `scripts/fourarm/score.py` already
reads (interfaces.md §1-1), so the existing, unmodified scorer can grade it.

This file never reads Gold (only the conditions file), never calls an LLM, and never
falls back between backends on an error -- a per-question failure is recorded as an
empty-results row with an `error` field and the run continues (matching run_arm.py's own
"실패 문항만 재실행 금지" discipline), never a silent retry.

Usage:
    PYTHONIOENCODING=utf-8 python3 scripts/fourarm/run_arm_a4_a3_live_family.py \
        --backend ARM_A4_A3_LIVE --out-dir work/a4-a3-remediation-devtune/baseline
    PYTHONIOENCODING=utf-8 python3 scripts/fourarm/run_arm_a4_a3_live_family.py \
        --backend ARM_A4_A3_REMEDIATION_LIVE --out-dir work/a4-a3-remediation-devtune/candidate
"""
from __future__ import annotations

import argparse
import hashlib
import importlib
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

BACKENDS = {
    "ARM_A4_A3_LIVE": {
        "client_module": "dart_detective.arm_a4_a3_live_worker_client",
        "client_class": "ArmA4A3LiveWorkerClient",
        "ready_key": "arm_a4_a3_live_ready",
    },
    "ARM_A4_A3_REMEDIATION_LIVE": {
        "client_module": "dart_detective.arm_a4_a3_remediation_live_worker_client",
        "client_class": "ArmA4A3RemediationLiveWorkerClient",
        "ready_key": "arm_a4_a3_remediation_live_ready",
    },
}


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


def git_dirty_paths() -> list[str]:
    try:
        out = subprocess.check_output(["git", "status", "--porcelain", "--", "src", "scripts", "domain"],
                                      cwd=REPO, text=True)
    except Exception:  # noqa: BLE001
        return ["(git unavailable)"]
    return [ln[3:] for ln in out.splitlines() if ln.strip()]


def peak_rss_mb() -> float:
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return round(rss / (1024 * 1024 if platform.system() == "Darwin" else 1024), 1)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="ARM_A4_A3_LIVE / ARM_A4_A3_REMEDIATION_LIVE retrieval-only DEV_TUNE-101 runner")
    p.add_argument("--backend", required=True, choices=list(BACKENDS))
    p.add_argument("--conditions", type=Path, default=REPO / "data" / "eval" / "devtune101_conditions.v2.jsonl")
    p.add_argument("--out-dir", type=Path, required=True)
    p.add_argument("--k", type=int, default=20)
    p.add_argument("--allow-dirty", action="store_true")
    args = p.parse_args(argv)

    dirty = git_dirty_paths()
    if dirty and not args.allow_dirty:
        print(json.dumps({"status": "REFUSED", "reason": "uncommitted changes in src/, scripts/, or domain/ — "
                          "commit first so code_sha256 pins the executed code", "paths": dirty},
                         ensure_ascii=False, indent=1))
        return 3

    rows = [json.loads(l) for l in args.conditions.open(encoding="utf-8") if l.strip()]

    backend_info = BACKENDS[args.backend]
    mod = importlib.import_module(backend_info["client_module"])
    client_cls = getattr(mod, backend_info["client_class"])
    client = client_cls(timeout_s=150.0)

    started = time.strftime("%Y-%m-%dT%H:%M:%S")
    readiness = client.readiness()
    if not readiness.get(backend_info["ready_key"]):
        print(json.dumps({"status": "BLOCKED", "reason": "worker not ready", "readiness": readiness},
                         ensure_ascii=False, indent=1))
        return 2

    # warm-up (미기록) — vFINAL 18번 "동일 warm-up 후 측정" convention, mirrored here.
    client.search(rows[0]["question"], rows[0]["conditions"], args.k)

    config = {"backend": args.backend, "k": args.k, **{k: v for k, v in readiness.items() if k != "kure_pin"},
              "kure_pin": readiness.get("kure_pin")}
    config_sha = hashlib.sha256(json.dumps(config, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    code_sha = git_head()

    args.out_dir.mkdir(parents=True, exist_ok=True)
    results_path = args.out_dir / "A.results.jsonl"
    latencies: list[int] = []
    n_err = 0
    with results_path.open("w", encoding="utf-8") as f:
        for i, r in enumerate(rows, 1):
            t0 = time.perf_counter()
            rec = {"question_id": r["question_id"], "arm": "A", "segment": r["segment"],
                   "config_sha256": config_sha, "code_sha256": code_sha}
            try:
                resp = client.search(r["question"], r["conditions"], args.k)
                items = resp.get("results") or []
                rec["results"] = [{
                    "rank": it["rank"],
                    "doc_id": it["document_id"],
                    "node_index": it.get("node_index"),
                    "node_indices": it.get("node_indices"),
                    "locator": it.get("locator"),
                    "provenance": it.get("provenance"),
                    "chunk_id": it["chunk_id"],
                    "chunk_text_sha256": text_sha(it["text"]),
                    "score": round(float(it["score"]), 6),
                    "text": it.get("text"),
                    "retrieval_pass": it.get("retrieval_pass"),
                    "retrieval_group": it.get("retrieval_group"),
                    "a3_decision": it.get("a3_decision"),
                } for it in items[:args.k]]
                rec["wide_pool_size"] = resp.get("wide_pool_size")
                rec["a3_pass"] = resp.get("a3_pass")
                rec["a3_reject"] = resp.get("a3_reject")
                rec["a3_keep_unknown"] = resp.get("a3_keep_unknown")
                rec["stable_refill_count"] = resp.get("stable_refill_count")
            except Exception as exc:  # noqa: BLE001 — 실패 문항만 재실행 금지, 기록하고 계속
                rec["results"] = []
                rec["error"] = f"{type(exc).__name__}: {exc}"
                n_err += 1
            rec["latency_ms"] = int((time.perf_counter() - t0) * 1000)
            latencies.append(rec["latency_ms"])
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            if i % 10 == 0:
                print(f"{args.backend}: {i}/{len(rows)} · 누적 {sum(latencies)/1000:.0f}s", file=sys.stderr, flush=True)

    client.close()

    run = {
        "arm": "A", "backend": args.backend,
        "started_at": started, "finished_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "host": platform.node(), "platform": platform.platform(), "python": platform.python_version(),
        "code_sha256": code_sha,
        "git_dirty": bool(dirty), "git_dirty_paths": dirty,
        "config": config, "config_sha256": config_sha,
        "input_sha256": {"conditions": sha256_file(args.conditions)},
        "n_questions": len(rows), "n_errors": n_err,
        "latency_ms": {
            "p50": int(statistics.median(latencies)),
            "p95": int(sorted(latencies)[max(0, int(round(0.95 * len(latencies))) - 1)]),
            "mean": int(statistics.mean(latencies)), "max": max(latencies), "total_s": round(sum(latencies) / 1000, 1),
        },
        "peak_rss_mb": peak_rss_mb(),
        "results_sha256": sha256_file(results_path),
    }
    (args.out_dir / "A.run.json").write_text(json.dumps(run, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: run[k] for k in ("arm", "backend", "n_questions", "n_errors", "latency_ms",
                                          "peak_rss_mb", "config_sha256", "results_sha256")},
                     ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
