"""팀 평가 하니스 설정 파일을 만든다. configuration_sha256은 직접 계산할 필요 없다.

하니스는 config에 64자리 sha256과 40자리 git commit을 요구한다. 손으로 채우면 매번
틀리므로 여기서 만든다.

실행:
    python scripts/make_harness_config.py \
        --gold path/to/gold.jsonl --out run/config.json
    python scripts/make_harness_config.py --gold ... --base-url http://127.0.0.1:8080
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

# lifecycle/ledger 없이 돌릴 수 있는 조합. DEV_CHECK·HOLDOUT·SANDBOX는 별도 원장이 필요하다.
DEFAULT_SPLIT = "DEV_TUNE"
DEFAULT_PURPOSE = "FLOW_SELECTION"


def git_commit() -> str:
    try:
        out = subprocess.run(["git", "rev-parse", "HEAD"],
                             capture_output=True, text=True, check=True)
        return out.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return "0" * 40


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="팀 하니스 config 생성")
    p.add_argument("--gold", required=True, help="Gold v0.2 jsonl 경로(하니스 실행 위치 기준)")
    p.add_argument("--out", default="run/config.json")
    p.add_argument("--base-url", default="http://127.0.0.1:8000")
    p.add_argument("--answer-path", default="/answer")
    p.add_argument("--result-path", default="run/results.jsonl")
    p.add_argument("--summary-path", default="run/summary.json")
    p.add_argument("--split", default=DEFAULT_SPLIT)
    p.add_argument("--run-purpose", default=DEFAULT_PURPOSE)
    p.add_argument("--timeout-ms", type=int, default=300_000)
    p.add_argument("--concurrency", type=int, default=1)
    p.add_argument("--retries", type=int, default=0)
    args = p.parse_args(argv)

    cfg = {
        "base_url": args.base_url,
        "answer_path": args.answer_path,
        "question_parameter": "question",
        "question_id_parameter": "question_id",
        "gold_path": args.gold,
        "result_path": args.result_path,
        "summary_path": args.summary_path,
        "split": args.split,
        "run_purpose": args.run_purpose,
        "timeout_ms": args.timeout_ms,
        "concurrency": args.concurrency,
        "retries": args.retries,
        "git_commit": git_commit(),
    }
    body = json.dumps(cfg, ensure_ascii=False, sort_keys=True).encode("utf-8")
    cfg["configuration_sha256"] = hashlib.sha256(body).hexdigest()

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(cfg, ensure_ascii=False, indent=2))
    print(f"\n-> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
