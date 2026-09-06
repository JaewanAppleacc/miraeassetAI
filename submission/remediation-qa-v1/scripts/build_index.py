"""DocumentIR 4파일 -> data/index/ (node_offsets.jsonl · doc_index.jsonl · index_manifest.json).

한 번의 스트리밍 패스. 8GB를 메모리에 올리지 않고, 새 대용량 파일도 만들지 않는다
(doc_index는 문서당 본문 3,000자만 담아 약 30~40MB).

실행:
    PYTHONIOENCODING=utf-8 .venv/bin/python scripts/build_index.py
    # 옵션: --document-ir-dir ~/Desktop/document_ir --manifest data/corpus/manifest.jsonl --out data/index

재현성: index_manifest.json에 DocumentIR 각 파일의 SHA-256·크기·문서 수, manifest SHA,
텍스트 규칙 이름과 상한이 기록된다. 킥오프 체크리스트 1번(input SHA 고정)의 근거 파일이다.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))

from dart_corpus.retrieval.node_store import (  # noqa: E402
    DEFAULT_TEXT_CAP, build_index, default_document_ir_dir,
)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="DocumentIR byte-offset 색인 + Stage 1 문서 인덱스 생성")
    p.add_argument("--document-ir-dir", type=Path, default=default_document_ir_dir())
    p.add_argument("--manifest", type=Path, default=REPO / "data" / "corpus" / "manifest.jsonl")
    p.add_argument("--out", type=Path, default=REPO / "data" / "index")
    p.add_argument("--text-cap", type=int, default=DEFAULT_TEXT_CAP)
    args = p.parse_args(argv)

    summary = build_index(args.document_ir_dir, args.manifest, args.out, text_cap=args.text_cap,
                          progress=lambda m: print(m, file=sys.stderr, flush=True))
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
