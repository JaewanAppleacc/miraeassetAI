#!/usr/bin/env bash
# Turn A4-A3-PLUS-QA-SELF-CONTAINED-AND-JUDGE-V1, Section F: clean-checkout reproducibility
# verification. Clones the CURRENT branch's committed HEAD into a fresh temp directory (never
# under a Codex worktree path, so no sibling worktree can accidentally be found on any search
# path), explicitly unsets every *_IMPL_ROOT env var, runs `npm install` against the committed
# package.json/package-lock.json, then proves the self-contained ARM_A4_A3_LIVE worker starts,
# answers >=3 real non-Gold questions through the full A4 pool -> R4 -> A3 -> refill -> top-20
# pipeline, and hands a result to the Python QA dispatcher (answer_api) — all without ever
# opening a file under another Codex worktree (checked via `lsof` on the worker's own pid).
#
# Requires: the real local Postgres (p11f0_scratch:55329) + persisted BM25 cache + running KURE
# server to already exist on this machine (same infra pins as scripts/a4_a3_full_index_smoke.mjs).
# Never touches Gold/DEV_TUNE/DEV_CHECK/HOLDOUT.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="$(git -C "$REPO_ROOT" branch --show-current)"
CLEAN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/a4a3-clean-checkout-XXXXXX")"

cleanup() { rm -rf "$CLEAN_DIR"; }
trap cleanup EXIT

echo "== cloning $BRANCH (committed HEAD only) into $CLEAN_DIR =="
git clone --no-hardlinks --branch "$BRANCH" "$REPO_ROOT" "$CLEAN_DIR"

echo "== npm install (clean) =="
(cd "$CLEAN_DIR" && npm install)

echo "== node --check =="
node --check "$CLEAN_DIR/scripts/arm_a4_a3_live_worker.mjs"
node --check "$CLEAN_DIR/scripts/a4_a3_full_index_smoke.mjs"

echo "== python import check =="
PYTHONPATH="$CLEAN_DIR/src" python3 -c "
import dart_detective.arm_a4_a3_live_adapter as la4
import dart_detective.arm_a4_a3_live_worker_client as wc
assert 'ARM_A4_A3_LIVE_IMPL_ROOT' not in wc.REQUIRED_ENV_VARS
print('python import OK, no IMPL_ROOT dependency:', la4.__file__)
"

: "${ARM_A4_A3_LIVE_DATABASE_URL:?required — real local Postgres connection string}"
: "${ARM_A4_A3_LIVE_RETRIEVAL_INDEX_ID:?required}"
: "${ARM_A4_A3_LIVE_LOAD_SESSION_ID:?required}"
: "${ARM_A4_A3_LIVE_CORPUS_SNAPSHOT_ID:?required}"
: "${ARM_A4_A3_LIVE_KURE_SERVER_URL:?required}"
: "${ARM_A4_A3_LIVE_BM25_CACHE_DIR:?required}"

echo "== readiness + 3 real non-Gold questions + external-worktree file-handle check =="
unset ARM_A4_A3_LIVE_IMPL_ROOT ARM_A_LIVE_IMPL_ROOT || true
PYTHONPATH="$CLEAN_DIR/src" python3 - "$CLEAN_DIR" <<'PYEOF'
import sys, os, json, subprocess
clean_dir = sys.argv[1]
os.environ["NODE_OPTIONS"] = "--max-old-space-size=8192"
from dart_detective.arm_a4_a3_live_worker_client import ArmA4A3LiveWorkerClient
client = ArmA4A3LiveWorkerClient(worker_script=os.path.join(clean_dir, "scripts", "arm_a4_a3_live_worker.mjs"), timeout_s=120)
readiness = client.readiness()
assert readiness.get("arm_a4_a3_live_ready"), readiness
questions = [
    ("네이버 주식회사의 자기주식 처분예정금액은 얼마인가?", {"corp_code": "00266961"}),
    ("최근 공시된 계약의 계약금액은 얼마인가?", {}),
    ("연결재무제표 기준 매출액 관련 공시 내용은 무엇인가?", {}),
]
for q, cond in questions:
    resp = client.search(q, cond, 20)
    results = resp["results"]
    assert results, f"no results for {q!r}"
    assert all(r["a3_decision"] in ("PASS", "KEEP_UNKNOWN") for r in results)
    assert all(r["rank"] == i + 1 for i, r in enumerate(results))
pid = client._proc.pid
lsof_out = subprocess.run(["lsof", "-p", str(pid)], capture_output=True, text=True).stdout
external_hits = [l for l in lsof_out.splitlines() if "/Documents/Codex/worktrees/" in l and clean_dir not in l]
assert not external_hits, f"worker opened files under another worktree: {external_hits}"
client.close()
print("CLEAN_CHECKOUT_SMOKE_OK: 3/3 questions succeeded, 0 external-worktree file handles")
PYEOF

echo "== ALL CLEAN-CHECKOUT CHECKS PASSED =="
