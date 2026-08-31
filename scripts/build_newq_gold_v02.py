"""seed 밖 평가셋(새 질문 18개)을 팀 공통 Gold v0.2 형식으로 변환한다.

왜: 팀 공통 평가 하니스는 Gold v0.2 형식만 읽는다. 지금 팀에는 seed 25문항밖에 없어서
"seed 밖 질문에서 무너지나"를 아무도 재지 못한다. 우리가 만든 18문항(정답 12 + 함정 6)을
같은 형식으로 바꾸면 팀 전체가 같은 하니스로 일반화를 잴 수 있다.

원칙:
  · 값은 실제 공시 원문에서 뽑는다. 지어내지 않는다.
  · 근거 위치(source_locator)는 팀 계약과 같은 형식으로 만든다.
    {doc_id}/{접수번호}.xml#node={노드번호}
  · 우리 시스템이 맞히는지와 무관하게 만든다 — 정답지를 우리 출력에 맞추지 않는다.

실행:
    PYTHONIOENCODING=utf-8 .venv/bin/python scripts/build_newq_gold_v02.py
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "src"))

NEWQ = REPO / "experiments" / "newq"
DOCS = NEWQ / "candidate_documents.jsonl"
QUESTIONS = NEWQ / "new_questions.jsonl"
DOC_INDEX = REPO / "experiments" / "gold25_retrieval" / "doc_index.jsonl"
OUT = REPO / "data" / "eval" / "newq_gold.v0.2.jsonl"

SCHEMA_VERSION = "0.2.0"
GOLD_REVISION = "newq-r1"
SPLIT = "DEV_TUNE"          # 별도 파일이라 팀 seed 세트와 섞이지 않는다
NUM_RE = re.compile(r"^\(?\d[\d,]*(?:\.\d+)?\)?$")

# 문항별 메타. 값(expect)은 new_questions.jsonl에 이미 있고, 여기서는 유형만 정한다.
META: dict[str, dict] = {
    "N01": {"type": "NUMERIC_LOOKUP", "difficulty": "EASY",
            "fields": {"contract_amount": "7,927,088,000"}, "unit": "원"},
    "N02": {"type": "NUMERIC_LOOKUP", "difficulty": "EASY",
            "fields": {"investment_amount": "28,480,000,000",
                       "equity_ratio_percent": "5.26"}, "unit": "원"},
    "N03": {"type": "SIMPLE_LOOKUP", "difficulty": "EASY",
            "fields": {"period_end": "2026-11-30"}, "unit": None},
    "N04": {"type": "NUMERIC_LOOKUP", "difficulty": "EASY",
            "fields": {"investment_amount": "473,200,000,000",
                       "equity_ratio_percent": "31.8"}, "unit": "원"},
    "N05": {"type": "NUMERIC_LOOKUP", "difficulty": "MEDIUM",
            "fields": {"contract_amount": "43,867,615,524,480",
                       "period_end": "2028-12-31"}, "unit": "원"},
    "N06": {"type": "NUMERIC_LOOKUP", "difficulty": "EASY",
            "fields": {"contract_amount": "1,152,180,085,272"}, "unit": "원"},
    "N07": {"type": "NUMERIC_LOOKUP", "difficulty": "MEDIUM",
            "fields": {"investment_amount": "806,800,000,000",
                       "period_end": "2031-06-30"}, "unit": "원"},
    "N08": {"type": "NUMERIC_LOOKUP", "difficulty": "MEDIUM",
            "fields": {"contract_amount": "1,195,242,120,000"}, "unit": "원"},
    "N09": {"type": "EVENT_TRACE", "difficulty": "MEDIUM",
            "fields": {"termination_amount": "4,004,923,296,000"}, "unit": "원"},
    "N10": {"type": "EVENT_TRACE", "difficulty": "MEDIUM",
            "fields": {"termination_amount": "1,147,665,603,998"}, "unit": "원"},
    "N11": {"type": "EVENT_TRACE", "difficulty": "MEDIUM",
            "fields": {"termination_amount": "19,300,000,000",
                       "termination_date": "2024-05-31"}, "unit": "원"},
    "N12": {"type": "EVENT_TRACE", "difficulty": "HARD", "fields": {}, "unit": None},
    "N13": {"type": "ANSWERABILITY", "difficulty": "EASY", "fields": {}, "unit": None,
            "answerability": "OUT_OF_SCOPE"},
    "N14": {"type": "ANSWERABILITY", "difficulty": "EASY", "fields": {}, "unit": None,
            "answerability": "NOT_FOUND"},
    "N15": {"type": "SIMPLE_LOOKUP", "difficulty": "MEDIUM", "fields": {}, "unit": None},
    # 차액은 계산값이라 원문에 없다. 근거는 두 계약금액이고, 차액은 기대값에만 둔다.
    "N16": {"type": "COMPARISON_CALC", "difficulty": "HARD",
            "fields": {}, "unit": "원",
            "evidence": {"kai_contract_amount": ("exchange_20230224800251", "1,195,242,120,000"),
                         "doosan_contract_amount": ("exchange_20230315800453", "1,152,180,085,272")},
            "computed": {"contract_amount_diff_krw": "43,062,034,728",
                         "larger_side": "한국항공우주"}},
    "N17": {"type": "ANSWERABILITY", "difficulty": "EASY", "fields": {}, "unit": None,
            "answerability": "AMBIGUOUS_QUERY"},
    "N18": {"type": "SIMPLE_LOOKUP", "difficulty": "EASY",
            "fields": {"period_end": "2023-08-31"}, "unit": None},
    # N19~N24: 다른 서식(자기주식 처분·신탁계약 해지·대량보유상황보고서).
    # 앞 문항들이 계약·투자 서식에 몰려 있다는 지적을 받아 메커니즘을 넓혔다 —
    # 이 항목들은 우리 항목 사전(DISCLOSURE_ITEMS)에 없어서, 사전에 맞춘 세트가 아니다.
    "N19": {"type": "NUMERIC_LOOKUP", "difficulty": "EASY",
            "fields": {"shares_to_dispose": "108,354",
                       "disposal_planned_amount": "20,999,005,200"}, "unit": "원"},
    "N20": {"type": "NUMERIC_LOOKUP", "difficulty": "MEDIUM",
            "fields": {"disposal_planned_amount": "40,174,398,000"}, "unit": "원"},
    "N21": {"type": "NUMERIC_LOOKUP", "difficulty": "MEDIUM",
            "fields": {"trust_amount_before_termination": "500,000,000,000",
                       "shares_to_terminate": "6,090,941"}, "unit": "원"},
    "N22": {"type": "EVENT_TRACE", "difficulty": "MEDIUM",
            "fields": {"trust_amount_before_termination": "200,000,000,000",
                       "termination_purpose": "신탁계약기간 만료"}, "unit": "원"},
    "N23": {"type": "NUMERIC_LOOKUP", "difficulty": "MEDIUM",
            "fields": {"shares_held_current": "5,098,596",
                       "holding_ratio_percent": "27.28"}, "unit": None},
    "N24": {"type": "SIMPLE_LOOKUP", "difficulty": "MEDIUM",
            "fields": {"report_reason": "특별관계자 및 보유주식수 변동",
                       "holding_ratio_percent": "24.92"}, "unit": None},
}


def as_number(raw: str):
    if not NUM_RE.match(raw or ""):
        return raw
    cleaned = raw.replace(",", "")
    negative = cleaned.startswith("(") and cleaned.endswith(")")
    if negative:
        cleaned = cleaned[1:-1]
    value = float(cleaned) if "." in cleaned else int(cleaned)
    return -value if negative else value


def locate(docs: dict, doc_id: str, span: str) -> tuple[str, str] | None:
    """그 값이 실제로 적힌 노드를 찾아 source_locator와 인용 줄을 만든다."""
    doc = docs.get(doc_id)
    if not doc:
        return None
    rcept_no = doc_id.rsplit("_", 1)[-1]
    for node in doc["nodes"]:
        text = node.get("text") or ""
        if span in text:
            line = next(ln.strip() for ln in text.split("\n") if span in ln)
            return f"{doc_id}/{rcept_no}.xml#node={node['node_index']}", line
    return None


def main() -> int:
    docs = {}
    for line in DOCS.open(encoding="utf-8"):
        d = json.loads(line)
        docs[d["doc_id"]] = d
    corp_code = {}
    for line in DOC_INDEX.open(encoding="utf-8"):
        d = json.loads(line)
        corp_code[d["corp_name"]] = d["corp_code"]

    rows = [json.loads(l) for l in QUESTIONS.open(encoding="utf-8") if l.strip()]
    out = []
    for r in rows:
        meta = META[r["qid"]]
        doc_id = r.get("expect_doc")
        slots = []
        evidence_fields = {f: (doc_id, span) for f, span in meta["fields"].items()}
        evidence_fields.update(meta.get("evidence", {}))
        for field, (field_doc, span) in evidence_fields.items():
            hit = locate(docs, field_doc, span) if field_doc else None
            if hit is None:
                print(f"  경고 {r['qid']} {field}: '{span}' 원문에서 못 찾음", flush=True)
                continue
            locator, _line = hit
            slots.append({
                "slot_name": field,
                "description": f"{field} — 원문에서 확인한 값",
                "acceptable_sources": [{"document_id": field_doc,
                                        "source_locator": locator,
                                        "evidence_span": span}],
            })
        answerability = meta.get(
            "answerability", "SUPPORTED" if (slots or meta.get("computed")) else "NOT_FOUND")
        value_fields = {**meta["fields"], **meta.get("computed", {})}
        value = {k: as_number(v) for k, v in value_fields.items()} or None
        corp = (r.get("corp") or "").split("·")[0]
        record = {
            "schema_version": SCHEMA_VERSION,
            "question_id": f"question_newq_v01_{r['qid'][1:]}",
            "evaluation_group_id": f"newq_group_{r['qid'].lower()}",
            "split": SPLIT,
            "question": r["question"],
            "question_type": meta["type"],
            "difficulty": meta["difficulty"],
            "answer_mode": "CLOSED" if value_fields else "OPEN",
            "doc_groups": sorted({doc_id.split("_")[0]}) if doc_id else ["exchange"],
            "corp_codes": [corp_code[corp]] if corp in corp_code else [],
            "as_of_date": None,
            "expected_answerability": answerability,
            "gold_document_ids": sorted({d for d, _ in evidence_fields.values() if d}),
            "expected_fact_ids": [],
            "expected_event_ids": [],
            "required_evidence_slots": slots,
            "expected_answer": {"status": answerability, "value": value,
                                "unit": meta["unit"],
                                "reason_code": ("DERIVED_CALCULATION" if meta.get("computed")
                                                else "DOCUMENTIR_VERBATIM_LOOKUP" if slots else None)},
            "authored_against": {
                "corpus_snapshot_id": "dart-corpus-2026-08",
                "manifest_sha256": hashlib.sha256(
                    (REPO / "data" / "3.공시" / "corpus" / "manifest.jsonl").read_bytes()
                ).hexdigest(),
                "parser_name": "canonical-parser",
                "parser_version": "0.1.0",
                "document_ir_schema_version": "0.1.0",
                "semantic_bundle_schema_version": "0.2.0",
                "gold_revision": GOLD_REVISION,
            },
            "expected_execution": {
                "applicable_fact_coverage_states": ["NO_STRUCTURED_FACT_COVERAGE"],
                "required_fact_slots": [],
                "required_fact_slots_sha256": hashlib.sha256(b"[]").hexdigest(),
                "required_fact_slots_lock_status": "GOLD_LOCKED",
                # 이 세트는 구조화된 Fact 없이 원문 검색으로 답한다 — 경로는 RETRIEVAL.
                # 금지 조작은 seed 세트와 같은 것을 쓴다(투자권유·미래예측·값 추론).
                "route_policy": [{
                    "when": "NO_STRUCTURED_FACT_COVERAGE",
                    "preferred_route": "RETRIEVAL",
                    "allowed_routes": ["RETRIEVAL", "BOTH"],
                    "required_operations": ["query_verified_evidence", "validate_provenance"],
                    "forbidden_operations": ["recommend_investment", "predict_future_value",
                                             "infer_missing_value"],
                    "expected_answerability": answerability,
                }],
            },
            "scoring_spec": {"comparator": "EXACT", "tolerance": 0,
                             "unit": meta["unit"], "rounding": None},
            "tags": ["newq", "out_of_seed", r["type"]],
        }
        out.append(record)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8") as w:
        for rec in out:
            w.write(json.dumps(rec, ensure_ascii=False) + "\n")
    slots_total = sum(len(r["required_evidence_slots"]) for r in out)
    print(f"\n{len(out)}문항 · 근거 슬롯 {slots_total}개 -> {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
