"""QA Agent End-to-End 실행기 — 질문셋 하나를 끝까지 돌리고 결과를 채점한다.

    질문 -> 조건 추출 -> Stage 1/2 검색 -> evidence 선택 -> LLM(또는 fallback)
    -> Validator -> 답변 + 근거

질문셋(--set):
    smoke  3문항 — 단일 문서 숫자 / 일반 재무 / 다중 문서. 배선 확인용.
    demo   시연용 5문항 (data/eval/demo_questions.json)
    multi  gold25 중 여러 문서가 필요한 문항
    all    gold25 전 문항

문항마다 확인하는 것:
    · Retrieval 후보가 나왔는가
    · 근거가 붙었는가, provenance(doc_id/chunk_id/section_path)가 남는가
    · 근거가 원문 그대로인가(발췌가 후보 청크의 부분문자열인가)
    · Validator 판정 (UNSUPPORTED = 근거 없는 수치/인용 -> 실패)
    · gold 문항이면 gold 문서/근거를 실제로 집었는가(evidence_hit)
    · LLM을 실제로 썼는지 / fallback으로 내려갔는지

CLOVA_API_KEY가 있으면 HyperCLOVA X를 실제로 부르고, 없으면 결정론적 fallback으로 같은
검사를 한다. 키가 없다고 임의 호출하거나 가짜 키를 만들지 않는다.

크레딧을 쓰는 순서(권장):
    1) --set demo            5문항 — 연결·형식 확인 (프롬프트 약 4만자)
    2) --set demo --limit 1  한 문항만 더 좁게 보고 싶을 때
    3) --set all             25문항 (프롬프트 합계 약 18만자)
    4) 실패한 문항만 --qids Q08,Q17 로 재실행 — 전체를 다시 돌리지 않는다

실행:
    PYTHONIOENCODING=utf-8 python scripts/qa_e2e.py --set smoke
    PYTHONIOENCODING=utf-8 python scripts/qa_e2e.py --set all --out work/qa_e2e_all.json
    PYTHONIOENCODING=utf-8 python scripts/qa_e2e.py --set demo --url http://localhost:8000
    PYTHONIOENCODING=utf-8 python scripts/qa_e2e.py --set all --qids Q08,Q17
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))

from dart_detective import qa_service  # noqa: E402
from dart_detective.agents import qa_agent  # noqa: E402
from dart_detective.llm import get_llm  # noqa: E402

GOLD_QA = REPO / "data" / "eval" / "gold25_qa.jsonl"
DEMO = REPO / "data" / "eval" / "demo_questions.json"

SMOKE = [
    {"qid": "SMOKE-1", "label": "단일 문서 숫자",
     "question": "신한지주의 2025년 반기보고서에 나온 자기주식 소각 주식수는?"},
    {"qid": "SMOKE-2", "label": "일반 재무/공시",
     "question": "HMM의 2025년 연결 매출액과 영업이익은 얼마인가?"},
    {"qid": "SMOKE-3", "label": "다중 문서",
     "question": "에스엠의 자기주식취득 신탁계약이 체결부터 소각까지 어떻게 진행됐는지 설명해줘."},
]


def load_gold_qa() -> list[dict]:
    if not GOLD_QA.exists():
        raise SystemExit(f"{GOLD_QA} 없음 — scripts/build_gold25_qa.py를 먼저 실행하라")
    return [json.loads(l) for l in GOLD_QA.open(encoding="utf-8") if l.strip()]


def question_set(name: str) -> list[dict]:
    if name == "smoke":
        return SMOKE
    gold = {g["qid"]: g for g in load_gold_qa()}
    if name == "all":
        return [{"qid": g["qid"], "label": g["cell"], "question": g["question"],
                 "gold": g} for g in gold.values()]
    if name == "multi":
        return [{"qid": g["qid"], "label": "다중 문서", "question": g["question"],
                 "gold": g} for g in gold.values() if g["multi_document"]]
    if name == "demo":
        if not DEMO.exists():
            raise SystemExit(f"{DEMO} 없음 — --set all을 먼저 돌려 선정하라")
        picked = json.loads(DEMO.read_text(encoding="utf-8"))["questions"]
        return [{"qid": p["qid"], "label": p["label"], "question": p["question"],
                 "gold": gold.get(p["qid"])} for p in picked]
    raise SystemExit(f"모르는 질문셋: {name}")


def score(item: dict, result: dict) -> dict:
    problems: list[str] = []
    evidence = result.get("evidence") or []
    if not evidence:
        problems.append("근거 없음")
    for ev in evidence:
        if not (ev.get("doc_id") and ev.get("chunk_id")):
            problems.append("provenance 누락")
    status = (result.get("validation") or {}).get("status")
    if status == "UNSUPPORTED":
        problems.append("validator=UNSUPPORTED")
    if not result.get("answer"):
        problems.append("답변 없음")

    gold = item.get("gold")
    gold_stats: dict = {}
    if gold:
        picked_docs = {ev["doc_id"] for ev in evidence}
        gold_docs = set(gold["expected_documents"])
        blob = "\n".join(ev["text"] for ev in evidence)
        hit = [g for g in gold["expected_evidence"] if g["quote"] and g["quote"] in blob]
        gold_stats = {
            "gold_documents": len(gold_docs),
            "documents_used": len(picked_docs),
            "gold_document_hit": len(picked_docs & gold_docs),
            "gold_evidence_total": len(gold["expected_evidence"]),
            "gold_evidence_hit": len(hit),
        }
        # LLM에 실제로 넘어가는 발췌에 gold 근거가 들어 있는지 — 답변 품질의 상한이다.
        # HTTP 응답에는 retrieval 본문이 없다(응답 스키마 고정). 그때는 재지 않는다 —
        # 0으로 적으면 "회수 못 함"과 "못 잼"이 구분되지 않는다.
        if result.get("retrieval") is not None:
            context_ids = set(result.get("llm_context") or [])
            context_blob = "\n".join(
                c["evidence_text"] for c in result["retrieval"]
                if c["chunk_id"] in context_ids)
            gold_stats["gold_evidence_in_llm_context"] = sum(
                1 for g in gold["expected_evidence"]
                if g["quote"] and g["quote"] in context_blob)
            gold_stats["llm_context_chunks"] = len(context_ids)
    llm = result.get("llm") or {}
    timings = result.get("timings") or {}
    return {"ok": not problems, "problems": problems, "validation": status,
            "llm_used": llm.get("used"), "llm_provider": llm.get("provider"),
            "llm_model": llm.get("model"), "llm_degraded": llm.get("degraded"),
            "llm_degraded_reason": llm.get("degraded_reason"),
            "llm_error": llm.get("error"), "usage": llm.get("usage"),
            "prompt_version": result.get("prompt_version"),
            "prompt_chars": result.get("prompt_chars") or llm.get("prompt_chars"),
            "retrieval_ms": timings.get("retrieval_ms"),
            "llm_ms": timings.get("llm_ms"), "total_ms": timings.get("total_ms"),
            "n_evidence": len(evidence), **gold_stats}


def run_local(question: str, llm, k: int | None) -> dict:
    return qa_agent.answer_question(question, qa_service.get_retriever(),
                                    llm=llm, k=k).to_dict()


def run_http(url: str, question: str, k: int | None) -> dict:
    import urllib.request
    body = {"question": question}
    if k:
        body["k"] = k
    req = urllib.request.Request(
        f"{url.rstrip('/')}/qa", data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=300) as res:
        return json.loads(res.read().decode("utf-8"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", dest="qset", default="smoke",
                    choices=("smoke", "demo", "multi", "all"))
    ap.add_argument("--limit", type=int, default=0,
                    help="앞에서 N문항만 — 크레딧을 조금씩 쓰며 확인할 때")
    ap.add_argument("--qids", default="",
                    help="쉼표로 구분한 문항만 재실행(실패 케이스만 다시 돌릴 때)")
    ap.add_argument("--url", default="", help="지정하면 HTTP로 POST /qa를 부른다")
    ap.add_argument("--k", type=int, default=None, help="Stage 2에서 볼 청크 수")
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--quiet", action="store_true", help="문항별 근거 출력 생략")
    args = ap.parse_args()

    items = question_set(args.qset)
    if args.qids:
        wanted = {q.strip() for q in args.qids.split(",") if q.strip()}
        items = [i for i in items if i["qid"] in wanted]
        if not items:
            raise SystemExit(f"해당 문항이 이 질문셋에 없다: {sorted(wanted)}")
    if args.limit:
        items = items[:args.limit]
    llm = get_llm()
    provider = getattr(llm, "provider", None)
    print(f"질문셋 {args.qset} · {len(items)}문항 · "
          f"LLM {provider or 'none (결정론적 fallback)'}"
          f"{' · HTTP ' + args.url if args.url else ''}")
    if not args.url and qa_service.missing_paths():
        print(f"코퍼스 인덱스 없음: {qa_service.missing_paths()}", file=sys.stderr)
        return 2

    rows, failed = [], 0
    for item in items:
        result = (run_http(args.url, item["question"], args.k) if args.url
                  else run_local(item["question"], llm, args.k))
        card = score(item, result)
        failed += 0 if card["ok"] else 1
        head = f"[{item['qid']}] {'OK' if card['ok'] else 'FAIL ' + ', '.join(card['problems'])}"
        gold_note = ""
        if "gold_evidence_hit" in card:
            ctx = (f"/문맥 {card['gold_evidence_in_llm_context']}"
                   if "gold_evidence_in_llm_context" in card else "")
            gold_note = (f" gold근거 답변 {card['gold_evidence_hit']}{ctx}"
                         f"/전체 {card['gold_evidence_total']}"
                         f" 문서 {card['gold_document_hit']}/{card['gold_documents']}")
        print(f"\n{head}  validation={card['validation']} "
              f"evidence={card['n_evidence']} llm={card['llm_used']}"
              f"{' degraded=' + str(card['llm_degraded_reason']) if card.get('llm_degraded') else ''}"
              f" {card['total_ms']}ms(검색 {card['retrieval_ms']}"
              f"{' · LLM ' + str(card['llm_ms']) if card.get('llm_ms') is not None else ''})"
              f"{gold_note}")
        print(f"  {item['question'][:96]}")
        if not args.quiet:
            for ev in (result.get("evidence") or [])[:3]:
                path = " > ".join(ev.get("section_path") or [])
                print(f"    - {ev['doc_id']}{(' · ' + path) if path else ''}")
                print(f"      {ev['text'][:100]}")
        rows.append({"qid": item["qid"], "label": item.get("label"),
                     "question": item["question"], **card, "result": result})

    total_gold = sum(r.get("gold_evidence_total", 0) for r in rows)
    hit_gold = sum(r.get("gold_evidence_hit", 0) for r in rows)
    measured_ctx = [r for r in rows if "gold_evidence_in_llm_context" in r]
    ctx_gold = sum(r["gold_evidence_in_llm_context"] for r in measured_ctx)
    print(f"\n{len(items) - failed}/{len(items)} passed")

    def stat(key: str) -> str:
        vals = sorted(r[key] for r in rows if r.get(key) is not None)
        if not vals:
            return "-"
        return (f"중앙값 {vals[len(vals) // 2]}ms · 최대 {vals[-1]}ms")
    print(f"latency — 전체 {stat('total_ms')} / 검색 {stat('retrieval_ms')} "
          f"/ LLM {stat('llm_ms')}")
    degraded = [r["qid"] for r in rows if r.get("llm_degraded")]
    errored = [r["qid"] for r in rows if r.get("llm_error")]
    if degraded:
        print(f"LLM 답변 폐기(근거 불일치/빈 답): {degraded}")
    if errored:
        print(f"LLM 호출 실패 → fallback: {errored}")
    if degraded or errored:
        print(f"  재실행: --set {args.qset} --qids "
              f"{','.join(sorted(set(degraded) | set(errored)))}")

    # usage는 provider가 준 키를 그대로 합산한다 — 이름을 우리가 정하지 않는다.
    usage_total: dict[str, Any] = {}
    for r in rows:
        for key, value in (r.get("usage") or {}).items():
            if isinstance(value, (int, float)):
                usage_total[key] = usage_total.get(key, 0) + value
            elif value is True:
                usage_total[key] = usage_total.get(key, 0) + 1
    if usage_total:
        print("usage 합계 — " + " · ".join(f"{k} {v:,}" for k, v in
                                          sorted(usage_total.items())))
    truncated = [r["qid"] for r in rows if (r.get("usage") or {}).get("truncated")]
    if truncated:
        print(f"출력 잘림(maxTokens 상한): {truncated}")
    versions = {r.get("prompt_version") for r in rows}
    chars = [r["prompt_chars"] for r in rows if r.get("prompt_chars")]
    if chars:
        # 크레딧 견적용 — 한국어는 대략 1토큰 ≈ 1.5자로 잡고 하한을 본다.
        print(f"프롬프트 크기 — 중앙값 {sorted(chars)[len(chars) // 2]:,}자 · "
              f"최대 {max(chars):,}자 · 합계 {sum(chars):,}자 "
              f"(대략 {sum(chars) // 1500:,}K 토큰 규모)")
    print(f"prompt_version {versions.pop() if len(versions) == 1 else versions}")
    if total_gold:
        ctx_note = (f"LLM 발췌에 포함 {ctx_gold}/{total_gold} ({ctx_gold / total_gold:.3f})"
                    if measured_ctx else "LLM 발췌 포함률 — HTTP 응답으로는 측정 불가")
        print(f"gold 근거 — {ctx_note} · slot으로 지목 {hit_gold}/{total_gold}")
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(rows, ensure_ascii=False, indent=2),
                            encoding="utf-8")
        print(f"-> {args.out}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
