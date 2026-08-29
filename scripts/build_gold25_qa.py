"""Gold 25문항을 LLM 답변 평가용 포맷으로 정리한다.

지금까지의 gold는 **검색**을 재기 위한 것이었다(질문 -> 근거 span 140건). LLM 답변을
채점하려면 문항마다 "무엇이 답에 들어 있어야 하는가"가 필요하다. 이 스크립트는 그 골격을
기존 산출물에서 **기계적으로만** 만든다:

    slots              evidence 리뷰의 slot_name (사람이 붙인 요구사항 자리)
    expected_evidence  그 자리에 붙은 gold 인용 span(evidence_id / document_id / quote)
    expected_numbers   gold 인용에서 뽑은 숫자(정규화, validator와 같은 규칙)
    expected_documents 답에 근거로 쓰여야 할 문서 목록 + multi_document 여부

**expected_answer는 비워 둔다.** 정답 문장은 사람이 원문을 보고 써야 하는 것이고,
여기서 만들어내면 그 순간 gold가 아니라 모델 출력이 된다. 채워지기 전까지
answer_review_status = "needs_human"으로 남고, 채점기는 이 상태를 보고 문장 평가를 건너뛴다.

실행:
    PYTHONIOENCODING=utf-8 python scripts/build_gold25_qa.py
    PYTHONIOENCODING=utf-8 python scripts/build_gold25_qa.py --check   # 재생성 없이 검증만
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))

from dart_corpus.evaluation.gold25 import (  # noqa: E402
    QID_OF, load_gold_questions, norm,
)
from dart_detective.agents.validator import numbers_in  # noqa: E402

GOLD = REPO / "data" / "eval" / "gold25.jsonl"
EVIDENCE = REPO / "check" / "seed-evidence-semantic-link-review.v0.1.jsonl"
OUT = REPO / "data" / "eval" / "gold25_qa.jsonl"

SCHEMA_VERSION = "0.1.0"


def load_evidence_rows() -> dict[str, list[dict]]:
    rows: dict[str, list[dict]] = {}
    with EVIDENCE.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line.startswith("{"):
                continue
            r = json.loads(line)
            rows.setdefault(QID_OF[r["question_id"]], []).append(r)
    return rows


def build() -> list[dict]:
    questions = load_gold_questions(GOLD)
    evidence = load_evidence_rows()
    out: list[dict] = []
    for q in questions:
        rows = evidence.get(q.qid, [])
        expected_evidence = [
            {
                "evidence_id": r["evidence_id"],
                "document_id": r["document_id"],
                "slot": r.get("slot_name"),
                "slot_description": r.get("slot_description"),
                "quote": norm(r["quoted_text"]),
                "block_type": (r.get("source_context") or {}).get("block_type"),
            }
            for r in rows
        ]
        documents = list(dict.fromkeys(e["document_id"] for e in expected_evidence))
        # 숫자는 gold 인용에서만 뽑는다 — 원문에 없는 값이 기대값이 되면 안 된다.
        numbers: list[str] = []
        for e in expected_evidence:
            for n in numbers_in(e["quote"]):
                if n not in numbers:
                    numbers.append(n)
        out.append({
            "schema_version": SCHEMA_VERSION,
            "qid": q.qid,
            "question": q.question,
            "cell": q.raw.get("cell"),
            "difficulty": q.raw.get("difficulty"),
            "doc_groups": q.raw.get("groups") or [],
            "corps": q.raw.get("corp") or [],
            "years": q.raw.get("years") or [],
            "slots": list(dict.fromkeys(
                e["slot"] for e in expected_evidence if e["slot"])),
            "expected_evidence": expected_evidence,
            "expected_documents": documents,
            "multi_document": len(documents) > 1,
            "expected_numbers": numbers,
            # 사람이 채울 자리. 비어 있는 동안 문장 채점은 건너뛴다.
            "expected_answer": None,
            "answer_review_status": "needs_human",
        })
    return out


def check(rows: list[dict]) -> list[str]:
    problems: list[str] = []
    if len(rows) != 25:
        problems.append(f"문항 수 {len(rows)} (25여야 한다)")
    total_ev = sum(len(r["expected_evidence"]) for r in rows)
    if total_ev != 140:
        problems.append(f"evidence {total_ev}건 (140이어야 한다)")
    for r in rows:
        if not r["expected_evidence"]:
            problems.append(f"{r['qid']}: gold evidence 없음")
        if not r["slots"]:
            problems.append(f"{r['qid']}: slot 없음")
        for e in r["expected_evidence"]:
            if not e["quote"]:
                problems.append(f"{r['qid']}/{e['evidence_id']}: 빈 인용")
    return problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="파일을 쓰지 않고 검증만")
    args = ap.parse_args()

    rows = build()
    problems = check(rows)
    for p in problems:
        print(f"문제: {p}", file=sys.stderr)

    n_multi = sum(1 for r in rows if r["multi_document"])
    n_ev = sum(len(r["expected_evidence"]) for r in rows)
    print(f"문항 {len(rows)} · evidence {n_ev} · 다중문서 문항 {n_multi} · "
          f"expected_answer 미작성 {sum(1 for r in rows if r['expected_answer'] is None)}")

    if not args.check:
        OUT.write_text(
            "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n",
            encoding="utf-8")
        print(f"-> {OUT}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
