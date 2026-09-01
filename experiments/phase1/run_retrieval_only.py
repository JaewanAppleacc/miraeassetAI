# Phase1 DEV_TUNE 101문항 — LLM 없이 검색·근거 전수. API 호출 0회.
# 채점: (1) 정답 문서가 상위20에 있나 (2) 근거 슬롯이 상위20/인용근거에 있나
#       (3) 정답 값이 근거 텍스트에 있나 (4) 함정 문항에서 근거 없음/경고를 내나
from __future__ import annotations
import json, re, sys, collections
from pathlib import Path
REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "src"))
from dart_detective.agents import qa_agent
from dart_detective.corpus_retriever import CorpusRetriever
HERE = Path(__file__).resolve().parent
GOLD = REPO / "data" / "eval" / "phase1_devtune_gold.v0.1.jsonl"
OUT = HERE / "retrieval_results.json"

def sq(s): return re.sub(r"\s+", "", s or "")

def locator_node(loc):
    m = re.search(r"::n(\d+)$", loc or "")
    return int(m.group(1)) if m else None

def slot_hit(slot, chunks):
    # 노드번호 일치 or 근거 span 앞 40자(공백제거)가 청크에 있음 or 청크가 span 안에 있음
    for src in slot.get("acceptable_sources", []):
        did, n = src.get("document_id"), locator_node(src.get("source_locator"))
        span = sq(src.get("evidence_span"))
        for c in chunks:
            if c.doc_id != did:
                continue
            if n is not None and c.node_index == n:
                return True
            ct = sq(c.evidence_text)
            if span and ((span[:40] and span[:40] in ct) or (len(ct) >= 20 and ct[:60] in span)):
                return True
    return False

def value_forms(v):
    if v is None or isinstance(v, (dict, list)): return []
    if isinstance(v, (int, float)):
        forms = {str(v), f"{v:,}"}
        if isinstance(v, float) and v.is_integer(): forms |= {str(int(v)), f"{int(v):,}"}
        return [f for f in forms]
    s = str(v)
    nums = re.findall(r"\d[\d,\.]*\d", s)
    return nums[:6] if nums else [s[:30]]

def main():
    retriever = CorpusRetriever.from_paths(
        REPO / "experiments" / "gold25_retrieval" / "doc_index.jsonl",
        HERE / "candidate_documents.jsonl",
        sorted((REPO / "data").rglob("universe.csv"))[0])
    rows = [json.loads(l) for l in GOLD.open(encoding="utf-8") if l.strip()]
    out = []
    for i, r in enumerate(rows, 1):
        state = qa_agent.answer_question(r["question"], retriever)
        s = state.to_dict()
        top = state.retrieval_results[:20]
        cited_ids = {e.get("chunk_id") for e in s["evidence"]}
        cited = [c for c in state.retrieval_results if c.chunk_id in cited_ids]
        gold_docs = set(r["gold_document_ids"])
        top_docs = [c.doc_id for c in top]
        slots = r["required_evidence_slots"]
        sl_top = sum(1 for sl in slots if slot_hit(sl, top))
        sl_cit = sum(1 for sl in slots if slot_hit(sl, cited))
        ev_blob = sq("\n".join(e["text"] for e in s["evidence"]))
        top_blob = sq("\n".join(c.evidence_text for c in top))
        forms = [sq(f) for f in value_forms(r["expected_answer"].get("value"))]
        val_ev = any(f and f in ev_blob for f in forms)
        val_top = any(f and f in top_blob for f in forms)
        trap = r["expected_answerability"] != "SUPPORTED"
        entry = {
            "qid": r["question_id"], "type": r["question_type"], "mode": r["answer_mode"],
            "answerability": r["expected_answerability"], "difficulty": r["difficulty"],
            "doc_groups": r["doc_groups"], "question": r["question"],
            "corps_detected": sorted(state.conditions.corps), "years_detected": sorted(state.conditions.years),
            "n_retrieved": len(state.retrieval_results),
            "gold_docs": sorted(gold_docs), "top5_docs": top_docs[:5],
            "doc_in_top20": bool(gold_docs & set(top_docs)) if gold_docs else None,
            "doc_in_top5": bool(gold_docs & set(top_docs[:5])) if gold_docs else None,
            "n_slots": len(slots), "slots_top20": sl_top, "slots_cited": sl_cit,
            "value_forms": forms[:4], "value_in_evidence": val_ev, "value_in_top20": val_top,
            "n_evidence": len(s["evidence"]), "n_derived": len(s["derived"]),
            "warnings": s["warnings"], "validation": s["validation"]["status"],
            "confidence": s["confidence"]["score"], "uncertainty": s["uncertainty"],
            "answer_head": s["answer"][:160],
            "rule": s.get("answerability") or "",
            "trap": trap,
            "trap_ok": ((s.get("answerability") == r["expected_answerability"])
                        or (r["expected_answerability"] == "NOT_FOUND" and len(s["evidence"]) == 0)) if trap else None,
        }
        out.append(entry)
        print("%3d %-18s %-6s %-9s 문서@20=%-5s 슬롯@20=%d/%d 인용=%d/%d 값=%s/%s 계산=%d %s" % (
            i, entry["type"][:18], entry["mode"], entry["answerability"][:9], entry["doc_in_top20"],
            sl_top, len(slots), sl_cit, len(slots), int(val_ev), int(val_top), entry["n_derived"],
            ",".join(entry["warnings"])[:40]), flush=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")

    sup = [e for e in out if not e["trap"]]
    traps = [e for e in out if e["trap"]]
    def rate(xs, f): 
        xs = [x for x in xs if f(x) is not None]
        return "%d/%d=%.3f" % (sum(1 for x in xs if f(x)), len(xs), (sum(1 for x in xs if f(x)) / len(xs)) if xs else 0)
    print("\n=== 요약 (정답형 %d문항)" % len(sup))
    print("정답문서 상위20 :", rate(sup, lambda e: e["doc_in_top20"]))
    print("정답문서 상위5  :", rate(sup, lambda e: e["doc_in_top5"]))
    ts = sum(e["n_slots"] for e in sup)
    print("근거슬롯 상위20 : %d/%d=%.3f" % (sum(e["slots_top20"] for e in sup), ts, sum(e["slots_top20"] for e in sup)/ts))
    print("근거슬롯 인용   : %d/%d=%.3f" % (sum(e["slots_cited"] for e in sup), ts, sum(e["slots_cited"] for e in sup)/ts))
    print("정답값 인용근거 :", rate(sup, lambda e: e["value_in_evidence"]))
    print("정답값 상위20   :", rate(sup, lambda e: e["value_in_top20"]))
    print("함정 %d문항 방어 :" % len(traps), rate(traps, lambda e: e["trap_ok"]))
    for key in ("mode", "type", "difficulty"):
        print("--- by", key)
        for k, grp in sorted(collections.defaultdict(list, {k: [e for e in sup if e[key] == k] for k in {e[key] for e in sup}}).items()):
            t = sum(e["n_slots"] for e in grp)
            print("  %-20s n=%2d 문서@20=%s 슬롯@20=%d/%d 값@인용=%s" % (k, len(grp), rate(grp, lambda e: e["doc_in_top20"]),
                  sum(e["slots_top20"] for e in grp), t, rate(grp, lambda e: e["value_in_evidence"])))
    print("\n->", OUT)

if __name__ == "__main__":
    main()
