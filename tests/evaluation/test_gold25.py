"""공통 gold25 하니스 자체 테스트.

여기서 지키려는 것은 "지표가 안 바뀐다"이다. 집계는 evidence span 단위
micro-average이고 문항 평균이 아니다 — 그 둘이 다른 값을 내는 케이스를 박아둔다.
"""
import json

import pytest

from dart_corpus.evaluation.gold25 import (
    GoldEvidence, GoldQuestion, QuestionResult, aggregate, evidence_chunk_rank,
    load_gold_evidence, load_gold_questions, norm, run_gold25, score_question,
)

import run_gold25_eval


def ev(eid, quote, doc="periodic_1"):
    return GoldEvidence(evidence_id=eid, document_id=doc, quote=quote)


def result(qid, n_ev, found20, ceiling=None, n_chunks=10):
    return QuestionResult(qid=qid, n_evidence=n_ev, n_chunks=n_chunks,
                          found_at_k={1: 0, 3: 0, 5: 0, 10: 0, 20: found20},
                          found_at_budget={2000: found20, 5000: found20,
                                           10000: found20, 20000: found20},
                          doc_ceiling_hits=n_ev if ceiling is None else ceiling,
                          chunk_ranks={})


# --- 로더 ---------------------------------------------------------------

def test_load_gold_questions_keeps_file_order(tmp_path):
    p = tmp_path / "gold25.jsonl"
    p.write_text(
        json.dumps({"qid": "Q02", "question": "두번째", "anchors": ["a2"]},
                   ensure_ascii=False) + "\n"
        + json.dumps({"qid": "Q01", "question": "첫번째", "anchors": []},
                     ensure_ascii=False) + "\n",
        encoding="utf-8")
    qs = load_gold_questions(p)
    assert [q.qid for q in qs] == ["Q02", "Q01"]
    assert qs[0].anchors == ("a2",)


def test_load_gold_evidence_maps_question_seed_id_to_qid(tmp_path):
    p = tmp_path / "evidence.jsonl"
    p.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in [
        {"question_id": "question_seed_v07_09", "evidence_id": "e1",
         "document_id": "periodic_a", "quoted_text": "자기주식  취득 후\n소각함.",
         "source_context": {"block_type": "table"}},
        {"question_id": "question_seed_v07_09", "evidence_id": "e2",
         "document_id": "periodic_b", "quoted_text": "두 번째 근거"},
    ]), encoding="utf-8")
    gold = load_gold_evidence(p)
    assert set(gold) == {"Q09"}
    assert len(gold["Q09"]) == 2
    # 공백만 정규화한다 — 글자는 그대로 둔다.
    assert gold["Q09"][0].quote == "자기주식 취득 후 소각함."
    assert gold["Q09"][0].block_type == "table"
    assert gold["Q09"][1].block_type is None


def test_norm_collapses_whitespace_only():
    assert norm("  가\t나\n\n다  ") == "가 나 다"
    assert norm(None) == ""


# --- chunk_rank ---------------------------------------------------------

def test_evidence_chunk_rank_is_one_based_first_containing_chunk():
    texts = ["관계없는 청크", "정답 인용이 여기 있다", "정답 인용이 여기 있다"]
    assert evidence_chunk_rank("정답 인용", texts) == 2


def test_evidence_chunk_rank_is_none_when_absent_or_empty():
    assert evidence_chunk_rank("없는 문장", ["가", "나"]) is None
    assert evidence_chunk_rank("", ["가"]) is None


def test_chunk_rank_finds_evidence_beyond_top20():
    texts = [f"noise {i}" for i in range(40)] + ["정답 span"]
    r = score_question("Q01", [ev("e1", "정답 span")], texts, ["periodic_1"])
    assert r.found_at_k[20] == 0            # top-20에는 없다
    assert r.chunk_ranks["e1"] == 41        # 그래도 얼마나 멀리 있는지는 잰다


# --- score_question -----------------------------------------------------

def test_recall_at_k_counts_each_evidence_span():
    texts = ["첫번째 근거 문장", "두번째 근거 문장", "세번째 근거 문장"]
    evs = [ev("e1", "첫번째 근거"), ev("e2", "두번째 근거"), ev("e3", "세번째 근거")]
    r = score_question("Q01", evs, texts, ["periodic_1"], n_chunks=3)
    assert r.found_at_k[1] == 1
    assert r.found_at_k[3] == 3
    assert r.metrics()["evidence_recall@1"] == pytest.approx(1 / 3, abs=1e-4)
    assert r.metrics()["evidence_recall@3"] == 1.0


def test_recall_matches_quote_spanning_two_chunks():
    """상위 k개를 개행으로 이어붙인 뒤 판정한다 — 실험 5-2와 같은 규칙."""
    texts = ["앞부분 인용", "인용 뒷부분"]
    r = score_question("Q01", [ev("e1", "앞부분 인용\n인용 뒷부분")], texts, ["periodic_1"])
    assert r.found_at_k[1] == 0
    assert r.found_at_k[3] == 1


def test_char_budget_stops_before_exceeding_budget():
    texts = ["a" * 1500, "b" * 600, "정답 span"]
    r = score_question("Q01", [ev("e1", "정답 span")], texts, ["periodic_1"])
    assert r.found_at_budget[2000] == 0     # 1500 + 600 > 2000 이라 두번째에서 끊긴다
    assert r.found_at_budget[5000] == 1


def test_char_budget_pool_is_capped_at_top20_like_experiment_5_2():
    """실험 5-2는 top-20만 랭킹했으므로 문자예산도 20청크가 상한이었다.
    이 상한을 풀면 @20000chars가 0.9143 -> 0.9357로 뛰어 과거 수치와 비교가 끊긴다."""
    texts = ["짧은 청크"] * 30 + ["정답 span"]
    evs = [ev("e1", "정답 span")]
    capped = score_question("Q01", evs, texts, ["periodic_1"])
    assert capped.found_at_budget[20000] == 0
    opened = score_question("Q01", evs, texts, ["periodic_1"], budget_pool=100)
    assert opened.found_at_budget[20000] == 1


def test_doc_ceiling_counts_evidence_whose_document_reached_stage2():
    evs = [ev("e1", "가", doc="periodic_1"), ev("e2", "나", doc="periodic_9")]
    r = score_question("Q01", evs, ["가", "나"], ["periodic_1", "periodic_2"])
    assert r.doc_ceiling_hits == 1
    assert r.metrics()["doc_ceiling@20"] == 0.5


# --- 집계 ---------------------------------------------------------------

def test_aggregate_is_micro_average_over_evidence_not_macro_over_questions():
    # 문항 평균이면 (1.0 + 0.0)/2 = 0.5, evidence 단위면 9/10 = 0.9.
    results = [result("Q01", n_ev=9, found20=9), result("Q02", n_ev=1, found20=0)]
    summary = aggregate(results)
    assert summary["evidence_recall@20"] == 0.9
    assert summary["n_evidence"] == 10
    assert summary["n_questions"] == 2


def test_aggregate_reports_mean_chunks_and_handles_empty():
    results = [result("Q01", 1, 1, n_chunks=10), result("Q02", 1, 1, n_chunks=21)]
    assert aggregate(results)["mean_chunks_per_question"] == 15.5
    assert aggregate([]) == {"n_evidence": 0, "n_questions": 0}


def test_aggregate_key_set_matches_experiment_5_2():
    """키 이름이 바뀌면 이전 라운드 결과 JSON과 비교가 끊긴다."""
    summary = aggregate([result("Q01", 1, 1)])
    for k in (1, 3, 5, 10, 20):
        assert f"evidence_recall@{k}" in summary
    for b in (2000, 5000, 10000, 20000):
        assert f"evidence_recall@{b}chars" in summary
    assert "doc_ceiling@20" in summary


# --- run_gold25 (실제 ChunkIndex 사용) ----------------------------------

GOLD_DOC = {
    "doc_id": "periodic_1", "doc_group": "periodic",
    "nodes": [
        {"node_index": 0, "kind": "table",
         "section_hierarchy": ["III. 재무에 관한 사항", "1. 요약재무정보"],
         "text": "구분 | 제 52 기\n매출액 | 61,118,127 | 59,254,361"},
        {"node_index": 1, "kind": "paragraph",
         "section_hierarchy": ["I. 회사의 개요", "4. 자본금 변동사항"],
         "text": "2025년 6월 26일 자기주식 10,347,131주를 소각함."},
    ],
}
NOISE_DOC = {
    "doc_id": "periodic_2", "doc_group": "periodic",
    "nodes": [{"node_index": 0, "kind": "paragraph",
               "section_hierarchy": ["II. 사업의 내용"],
               "text": "관계없는 본문이 들어 있는 문단."}],
}


def test_run_gold25_scores_each_question_end_to_end():
    questions = [GoldQuestion(qid="Q01", question="자기주식 소각 주식수는?")]
    gold = {"Q01": [ev("e1", "자기주식 10,347,131주를 소각함.")]}
    docs = {d["doc_id"]: d for d in (GOLD_DOC, NOISE_DOC)}
    results = run_gold25(questions, gold,
                         stage1_docs=lambda q: ["periodic_1", "periodic_2"],
                         docs_by_id=docs)
    assert len(results) == 1
    assert results[0].found_at_k[20] == 1
    assert results[0].doc_ceiling_hits == 1
    assert results[0].chunk_ranks["e1"] is not None
    assert results[0].n_chunks > 0


def test_run_gold25_skips_questions_without_gold_evidence():
    questions = [GoldQuestion(qid="Q01", question="근거가 없는 질문")]
    results = run_gold25(questions, {}, stage1_docs=lambda q: ["periodic_1"],
                         docs_by_id={"periodic_1": GOLD_DOC})
    assert results == []


def test_run_gold25_ignores_stage1_docs_without_cached_body():
    """본문을 캐시하지 못한 문서는 Stage 2 후보에서 빠지되, doc_ceiling에는 남는다."""
    questions = [GoldQuestion(qid="Q01", question="자기주식 소각 주식수는?")]
    gold = {"Q01": [ev("e1", "자기주식 10,347,131주를 소각함.", doc="periodic_1")]}
    results = run_gold25(questions, gold,
                         stage1_docs=lambda q: ["periodic_1", "periodic_missing"],
                         docs_by_id={"periodic_1": GOLD_DOC})
    assert results[0].doc_ceiling_hits == 1


# --- 실행기(회귀 게이트) ------------------------------------------------

def test_label_defaults_describe_the_configuration():
    args = run_gold25_eval.parse_args([])
    assert run_gold25_eval.label_of(args) == "line_window+section0.5+row0.5"
    args = run_gold25_eval.parse_args(["--section-alpha", "0", "--context-mode", "full"])
    assert run_gold25_eval.label_of(args) == "line_window+row0.5+ctx_full"


def test_compare_flags_regression_against_baseline(tmp_path, capsys):
    baseline = tmp_path / "baseline.json"
    baseline.write_text(json.dumps({"summary": {
        "evidence_recall@1": 0.2929, "evidence_recall@3": 0.6,
        "evidence_recall@5": 0.6571, "evidence_recall@10": 0.7929,
        "evidence_recall@20": 0.9143}}), encoding="utf-8")
    same = {f"evidence_recall@{k}": v for k, v in
            zip((1, 3, 5, 10, 20), (0.2929, 0.6, 0.6571, 0.7929, 0.9143))}
    assert run_gold25_eval.compare(same, baseline) == 0
    worse = {**same, "evidence_recall@20": 0.8}
    assert run_gold25_eval.compare(worse, baseline) == 1
    assert "REGRESSION" in capsys.readouterr().out


def test_tracked_gold_is_the_same_25_questions():
    """문항 집합이 바뀌면 이전 라운드 수치와 비교가 끊긴다 — Q01~Q25 고정."""
    questions = load_gold_questions(run_gold25_eval.DEFAULTS["gold"])
    assert [q.qid for q in questions] == [f"Q{i:02d}" for i in range(1, 26)]
    assert all(q.question.strip() for q in questions)


def test_missing_inputs_are_reported_by_key(tmp_path):
    args = run_gold25_eval.parse_args(["--doc-index", str(tmp_path / "nope.jsonl")])
    assert "doc_index" in run_gold25_eval.missing_inputs(args)
