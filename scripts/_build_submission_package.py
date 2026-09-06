"""One-shot allowlist-based copier for submission/remediation-qa-v1/.

Turn REMEDIATION-QA-SUBMISSION-PACKAGE-V1. Not part of the submission itself (not in the
allowlist below) -- this script only exists in the dev-repo commit that records how the
package was built. It copies an explicit list of relative paths from this checkout
(pinned to codex/a4-a3-remediation-integration-v01 @ b5f9443f) into submission/remediation-qa-v1/,
creating parent directories as needed. It never copies a directory wholesale and never
touches any path not listed here.
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DEST = REPO / "submission" / "remediation-qa-v1"

PYTHON_FILES = [
    "src/dart_corpus/__init__.py",
    "src/dart_corpus/retrieval/__init__.py",
    "src/dart_corpus/retrieval/chains.py",
    "src/dart_corpus/retrieval/chunk_index.py",
    "src/dart_corpus/retrieval/conditions.py",
    "src/dart_corpus/retrieval/corp_dictionary.py",
    "src/dart_corpus/retrieval/document_index.py",
    "src/dart_corpus/retrieval/lexical.py",
    "src/dart_corpus/retrieval/node_store.py",
    "src/dart_corpus/retrieval/segments.py",
    "src/dart_detective/__init__.py",
    "src/dart_detective/agents/__init__.py",
    "src/dart_detective/agents/calculator.py",
    "src/dart_detective/agents/confidence.py",
    "src/dart_detective/agents/qa_agent.py",
    "src/dart_detective/agents/tables.py",
    "src/dart_detective/agents/validator.py",
    "src/dart_detective/answer_api.py",
    "src/dart_detective/answer_wire.py",
    "src/dart_detective/arm_a4_a3_live_adapter.py",
    "src/dart_detective/arm_a4_a3_live_worker_client.py",
    "src/dart_detective/arm_a4_a3_remediation_live_adapter.py",
    "src/dart_detective/arm_a4_a3_remediation_live_worker_client.py",
    "src/dart_detective/arm_a_adapter.py",
    "src/dart_detective/arm_a_live_adapter.py",
    "src/dart_detective/arm_a_live_worker_client.py",
    "src/dart_detective/arm_a_serving_bridge.py",
    "src/dart_detective/corpus_retriever.py",
    "src/dart_detective/fallback.py",
    "src/dart_detective/grounded_answer.py",
    "src/dart_detective/llm.py",
    "src/dart_detective/ops_service.py",
    "src/dart_detective/policy_gate.py",
    "src/dart_detective/retriever_adapter.py",
    "src/dart_detective/routing.py",
]

NODE_FILES = [
    "scripts/arm_a4_a3_remediation_live_worker.mjs",
    "domain/agent-comparison/chunking-comparison/bm25.mjs",
    "domain/agent-comparison/chunking-comparison/rrf.mjs",
    "domain/agent-comparison/four-arm-ac/a3-evidence-contradiction-guard.mjs",
    "domain/agent-comparison/four-arm-ac/a4-a3-remediation-candidate-legs.mjs",
    "domain/agent-comparison/four-arm-ac/a4-a3-remediation-retrieval-pipeline.mjs",
    "domain/agent-comparison/four-arm-ac/a4-a3-retrieval-pipeline.mjs",
    "domain/agent-comparison/four-arm-ac/a4-reranker-configs.v1.json",
    "domain/agent-comparison/four-arm-ac/a4-reranker-engine.mjs",
    "domain/agent-comparison/four-arm-ac/a4-reranker-features.mjs",
    "domain/agent-comparison/four-arm-ac/a4-wide-candidate-pool.mjs",
    "domain/agent-comparison/four-arm-ac/arm-retriever-adapter.mjs",
    "domain/agent-comparison/four-arm-ac/conditions-fixture.mjs",
    "domain/agent-comparison/four-arm-ac/four-arm-conditions-to-filter-mapper.mjs",
    "domain/agent-comparison/four-arm-ac/four-arm-retrieval-policy.mjs",
    "domain/agent-comparison/four-arm-ac/locator-provenance.mjs",
    "domain/agent-comparison/four-arm-ac/qa-condition-mapper.mjs",
    "domain/agent-comparison/retrieval/contracts.mjs",
    "domain/agent-comparison/retrieval/interfaces/embedding-config.schema.json",
    "domain/agent-comparison/retrieval/embedding-adapter.mjs",
    "domain/agent-comparison/retrieval/fake-deterministic-embedding-adapter.mjs",
    "domain/agent-comparison/retrieval/fixed-kure-bm25-index.mjs",
    "domain/agent-comparison/retrieval/fixed-kure-hybrid-retriever-adapter.mjs",
    "domain/chunking/chunker.mjs",
    "domain/contracts.mjs",
    "domain/postgres/reference-vector-retrieval-repository.mjs",
    "domain/retrieval/metadata-filter.mjs",
    "domain/runtime/abortable.mjs",
    "package.json",
    "package-lock.json",
]

DATA_FILES = [
    "data/corpus/manifest.jsonl",
    "data/corpus/universe.csv",
    "data/corpus/corp_aliases.v1.json",
]

OPS_SCRIPTS = [
    "scripts/build_index.py",
    "scripts/deploy_probe.py",
    "scripts/qa_preflight.py",
]

ALL_FILES = PYTHON_FILES + NODE_FILES + DATA_FILES + OPS_SCRIPTS


def main() -> int:
    if DEST.exists():
        print(f"refusing to run: {DEST} already exists (remove it first if rebuilding)", file=sys.stderr)
        return 1
    missing = [p for p in ALL_FILES if not (REPO / p).is_file()]
    if missing:
        print("missing source files:", missing, file=sys.stderr)
        return 1
    for rel in ALL_FILES:
        src = REPO / rel
        dst = DEST / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
    print(f"copied {len(ALL_FILES)} files into {DEST}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
