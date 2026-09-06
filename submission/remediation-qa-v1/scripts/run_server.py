#!/usr/bin/env python3
"""Start the QA server with ARM_A4_A3_REMEDIATION_LIVE as the active backend.

Why this script exists instead of `uvicorn dart_detective.ops_service:app` directly:
at the pinned source commit (b5f9443f, codex/a4-a3-remediation-integration-v01), the new
ARM_A4_A3_REMEDIATION_LIVE backend is fully implemented but not yet registered in
answer_api.py's own backend dispatch table (arm_a_serving_bridge.RETRIEVAL_BACKENDS /
answer_api._build_retriever()) -- that wiring was intentionally out of scope for the turn
that added the backend. Rather than patch those two files for this submission (which
would no longer be byte-identical to the pinned commit), this script builds the
remediation retriever directly via its own public builder and injects it into
answer_api's existing (public) `reset()` hook, then starts uvicorn in-process so the
injected state is visible to every request. No source file in this package is modified
by this script at import time or otherwise -- it only calls already-existing public
functions.

Usage:
    python scripts/run_server.py                # binds 0.0.0.0:${PORT:-8000}

Requires the environment variables documented in .env.example, both the
ARM_A4_A3_REMEDIATION_LIVE_* ones (consumed by the Node worker this script spawns
indirectly through the Python client) and the DART_QA_* ones (consumed by the base
CorpusRetriever used for docs_by_id/conditions/document metadata).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))


def main() -> None:
    from dart_detective import answer_api
    from dart_detective.arm_a4_a3_remediation_live_adapter import (
        build_arm_a4_a3_remediation_live_serving_retriever,
    )

    retriever, store, arm, pins = build_arm_a4_a3_remediation_live_serving_retriever()
    answer_api.reset(retriever)
    # answer_api.reset() intentionally clears _store/_arm/_arm_pins (it exists for test
    # doubles that don't carry that bookkeeping) -- set them explicitly here so
    # readiness()'s "arm"/"pins" fields correctly report ARM_A4_A3_REMEDIATION_LIVE
    # instead of the unconfigured defaults. These are the same module-level names
    # answer_api._build_retriever() itself would have assigned.
    answer_api._store = store  # noqa: SLF001 -- see docstring above
    answer_api._arm = arm  # noqa: SLF001
    answer_api._arm_pins = pins  # noqa: SLF001

    readiness = answer_api.readiness()
    print(f"readiness before serving: {readiness}", file=sys.stderr)
    if not readiness.get("ready"):
        print("WARNING: readiness() reports ready=False -- check env vars / worker "
             "connectivity before sending real traffic.", file=sys.stderr)

    import uvicorn

    from dart_detective.ops_service import app

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")), workers=1)


if __name__ == "__main__":
    main()
