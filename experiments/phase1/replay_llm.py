"""run B 결과를 API 호출 없이 재채점한다.

- LLM을 부른 문항: 저장된 raw_text를 다시 파싱해 지금 코드의 answer_text/validator로
  판정한다(결정론). 호출 0회.
- LLM을 안 부른 문항(계산기·규칙·근거없음): 파이프라인을 LLM 없이 다시 돌린다.
  계산기 트리거 수정은 이 경로에서 검증된다.
실행:
    PYTHONIOENCODING=utf-8 .venv/bin/python experiments/phase1/replay_llm.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(HERE))

from run_llm import score_value  # noqa: E402

from dart_detective import llm as llm_mod  # noqa: E402
from dart_detective.agents import calculator, qa_agent, validator  # noqa: E402
from dart_detective.corpus_retriever import CorpusRetriever  # noqa: E402

SRC = HERE / "llm_results.json"
OUT = HERE / "llm_results.replay.json"


def main() -> int:
    data = json.loads(SRC.read_text(encoding="utf-8"))
    retriever = CorpusRetriever.from_paths(
        ROOT / "experiments" / "gold25_retrieval" / "doc_index.jsonl",
        HERE / "candidate_documents.jsonl",
        sorted((ROOT / "data").rglob("universe.csv"))[0])
    out = []
    changed = 0
    for r in data["rows"]:
        # 결정론 경로는 그대로 다시 돌린다(LLM 없음). 계산기가 깨어나면 여기서 답이 바뀐다.
        state = qa_agent.answer_question(r["question"], retriever)
        s = state.to_dict()
        answer = s["answer"]
        source = "deterministic"
        if r["raw_text"] and not s["derived"] and not s.get("answerability"):
            # LLM 응답 재파싱 — 지금의 answer_text/validator로
            try:
                payload = llm_mod.extract_json(r["raw_text"])
                llm_answer = qa_agent.answer_text(payload.get("answer"))
                cites = qa_agent.normalize_citations(payload.get("evidence"))
                sources = [c.as_source() for c in state.retrieval_results]
                check = validator.validate(llm_answer, cites, sources,
                                           derived=calculator.allowed_numbers(state.derived))
                if llm_answer and check["status"] != "UNSUPPORTED":
                    answer = llm_answer
                    source = "llm_replay"
                else:
                    source = "llm_discarded:" + ("empty" if not llm_answer else "unsupported")
            except Exception as exc:  # noqa: BLE001
                source = "llm_parse_fail:" + type(exc).__name__
        rule = s.get("answerability") or ""
        status = rule or ("SUPPORTED" if s["evidence"] and s["validation"]["status"] != "UNSUPPORTED"
                          else "NOT_FOUND")
        vlabel, vscore = score_value(r["expected"].get("value"), answer)
        entry = dict(r)
        entry.update({"answer": answer, "source": source, "status": status,
                      "status_ok": status == r["expected_status"],
                      "value_label": vlabel, "value_score": vscore,
                      "value_ok": (vscore >= 0.999) if r["expected_status"] == "SUPPORTED" else None,
                      "n_derived": len(s["derived"]),
                      "prev_value_score": r["value_score"]})
        entry.pop("raw_text", None)
        if abs(vscore - r["value_score"]) > 1e-9:
            changed += 1
            print("변경 %-14s %s -> %s | %s" % (r["type"][:14], r["value_label"], vlabel, r["question"][:60]))
        out.append(entry)
    sup = [e for e in out if e["expected_status"] == "SUPPORTED"]
    summary = {
        "n": len(out), "status_ok": sum(1 for e in out if e["status_ok"]),
        "value_full": sum(1 for e in sup if e["value_ok"]),
        "value_partial": sum(1 for e in sup if not e["value_ok"] and e["value_score"] > 0),
        "value_zero": sum(1 for e in sup if e["value_score"] == 0),
        "n_supported": len(sup), "changed_rows": changed,
        "sources": {k: sum(1 for e in out if e["source"] == k) for k in {e["source"] for e in out}},
    }
    for key in ("mode", "type"):
        summary["by_" + key] = {}
        for k in sorted({e[key] for e in sup}):
            grp = [e for e in sup if e[key] == k]
            summary["by_" + key][k] = "%d/%d full" % (sum(1 for e in grp if e["value_ok"]), len(grp))
    OUT.write_text(json.dumps({"summary": summary, "rows": out}, ensure_ascii=False, indent=1),
                   encoding="utf-8")
    print("\n" + json.dumps(summary, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
