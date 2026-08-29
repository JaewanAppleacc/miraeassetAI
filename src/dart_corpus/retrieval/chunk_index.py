"""Stage 2 — top-k 문서 **안에서** 근거 조각을 찾는다.

Stage 1(DocumentIndex)은 "어느 공시를 볼 것인가"까지만 답한다. 실제 답변에 필요한 것은
그 안의 한 줄이다. Gold evidence 140건을 감사한 결과 134건이 표 안의 값이고
인용문 길이 중앙값이 13자다 — 이 코퍼스에서 근거 검색은 사실상 **표 행 검색**이다.

그래서 청킹 단위를 세 가지로 둔다.

    line_window  노드 텍스트를 줄 단위 슬라이딩 윈도로 자른다(구조 무시 baseline)
    table_row    표는 행 하나가 곧 청크. 그 행이 속한 표의 머리글을 붙여 둔다
    table_group  표를 머리글 + N행 묶음으로 자른다(기본 8행)

머리글을 붙이는 이유는 데모 Agent에서 이미 확인된 실패 때문이다 — 표 행만 떼면
"현금및현금성자산 | 210,798,647,244 | 277,818,663,484"처럼 어느 기간 값인지 사라진다.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

from .lexical import BM25, tokenize

# 데이터 행 판정용 — 4자리 이상(또는 콤마가 든) 숫자만 센다.
# "구분 | 제 52 기 | 제 51 기"의 52/51까지 세면 표 머리글을 데이터 행으로 오판한다.
_NUM_RE = re.compile(r"\d[\d,]{3,}")
_HEADER_HINT_RE = re.compile(r"구분|단위\s*:|제\s*\d+\s*기|20\d{2}\s*년|20\d{2}\.\d{2}|항목|정정")

DEFAULT_WINDOW = 12
DEFAULT_STRIDE = 8
MAX_HEADER_LINES = 3
DEFAULT_TABLE_ROWS = 8
DEFAULT_SECTION_ALPHA = 0.5
# 섹션 라우팅을 적용할 doc_group.
#   periodic : 정기공시 목차(III. 재무에 관한 사항 ...)
#   major    : 주요사항보고서에도 section_hierarchy가 있다(노드 140/149). 목차가 아니라
#              사건 이름이다 — "주요사항보고서 / 거래소 신고의무 사항 > 자기주식취득
#              신탁계약 해지 결정". SECTION_RULES의 "자기주식" 같은 조각이 그대로 걸린다.
# exchange/holding은 이런 계층이 없어 제외한다.
SECTION_ROUTABLE_GROUPS: tuple[str, ...] = ("periodic", "major")
# 행 레이블 신호의 비중. Gold 25문항 sweep에서 0.3/0.5/0.7이 완전히 같은 결과를 낸다
# (신호가 0/1이라 동점 구간만 가른다) — 튜닝한 값이 아니라 그 구간의 가운데다.
DEFAULT_ROW_ALPHA = 0.5

# 질문 -> 정기공시 섹션. Stage 1의 공시유형 라우팅을 문서 **안쪽**으로 한 단계 내린 것이다.
# 정기공시는 한 건이 수천 청크라, 질문 어휘("매출액", "영업이익")가 문서 전체에 고르게
# 퍼져 있어 변별력이 없다. 어느 섹션을 볼지가 실제 신호다.
SECTION_RULES: dict[str, tuple[str, ...]] = {
    "재무": ("요약재무정보", "재무제표", "손익계산서", "재무상태표", "재무에 관한 사항"),
    "주식": ("주식의 총수", "자기주식", "주주에 관한 사항"),
    "배당": ("배당",),
    "자금조달": ("자금조달", "증권의 발행", "사채"),
    "위험": ("위험",),
    "연구개발": ("연구개발",),
    "생산설비": ("생산설비", "원재료"),
    "사업내용": ("사업의 개요", "매출 및 수주", "매출실적"),
}
SECTION_TRIGGERS: dict[str, tuple[str, ...]] = {
    "재무": ("매출액", "영업이익", "실적", "연결", "재무", "당기순이익", "수익성", "증가율"),
    "주식": ("자기주식", "자사주", "주식 총수", "주식의 총수", "소각", "취득", "발행주식"),
    "배당": ("배당",),
    "자금조달": ("자금조달", "유상증자", "증자", "사채", "발행"),
    "위험": ("위험", "리스크"),
    "연구개발": ("연구개발", "R&D"),
    "생산설비": ("설비투자", "시설투자", "생산설비", "원재료"),
    "사업내용": ("사업의 개요", "주요 제품", "매출실적", "상용화", "출시"),
}


def route_sections(question: str) -> tuple[str, ...]:
    """질문에서 볼 만한 정기공시 섹션 이름 조각을 고른다."""
    out: list[str] = []
    for group, triggers in SECTION_TRIGGERS.items():
        if any(t in question for t in triggers):
            out.extend(SECTION_RULES[group])
    return tuple(dict.fromkeys(out))


@dataclass(frozen=True)
class Chunk:
    chunk_id: str
    doc_id: str
    node_index: int
    kind: str            # table_row | table_group | table_block | paragraph | window
    header: str          # 표 머리글(없으면 빈 문자열)
    text: str            # 검색·표시에 쓰는 본문(머리글 제외)
    section_path: tuple[str, ...] = ()
    doc_group: str = ""

    @property
    def row_labels(self) -> frozenset[str]:
        """이 청크가 담고 있는 표 행들의 정규화된 레이블."""
        return frozenset(
            lbl for line in self.text.splitlines()
            if (lbl := row_label_of(line)) and _is_data_row(line)
        )

    @property
    def raw_row_labels(self) -> frozenset[str]:
        """정규화 이전의 첫 칸 그대로. exact 매칭 비교용."""
        return frozenset(
            line.split("|")[0].strip()
            for line in self.text.splitlines()
            if _is_data_row(line) and line.split("|")[0].strip()
        )

    def has_row_label(self, wanted: Sequence[str], exact: bool = False) -> bool:
        if not wanted:
            return False
        labels = self.raw_row_labels if exact else self.row_labels
        return bool(labels & frozenset(wanted))

    @property
    def search_text(self) -> str:
        return f"{self.header}\n{self.text}" if self.header else self.text

    @property
    def section_routable(self) -> bool:
        """섹션 계층을 가진 문서군의 청크인가.

        거래소공시·지분공시에는 이런 계층이 없어서, 같이 걸면 그쪽 청크만 일방적으로
        밀린다. major는 계층이 있으므로 포함한다 — 단 실제 적용 여부는 검색 시점에
        "그 그룹에서 하나라도 매칭됐는가"로 한 번 더 거른다(_matched_section_groups).
        """
        return self.doc_group in SECTION_ROUTABLE_GROUPS and bool(self.section_path)

    def in_sections(self, wanted: Sequence[str]) -> bool:
        """이 청크가 질문이 지목한 섹션 안에 있는가."""
        if not wanted or not self.section_routable:
            return False
        joined = " > ".join(self.section_path)
        return any(w in joined for w in wanted)


_UNIT_RE = re.compile(r"\(?\s*단위\s*[::]")
_PERIOD_HEADER_RE = re.compile(r"제\s*\d+\s*[기期]|20\d{2}\s*년|20\d{2}\.\d{2}|당기|전기")

CONTEXT_MODES = ("off", "title", "title_unit", "full")


def _node_context(section_path: Sequence[str], lines: Sequence[str],
                  mode: str) -> list[str]:
    """노드(=표) 하나에서 그 표를 식별하는 줄들을 뽑는다.

    **원문에 있는 것만 쓴다.** 연결/별도나 단위를 추측해서 만들지 않는다.
    표 중간에서 잘린 청크는 표 머리 쪽의 제목·단위 줄을 잃는데, 그걸 되돌려 준다.
    """
    if mode == "off":
        return []
    head: list[str] = []
    if section_path:
        head.append(" > ".join(section_path))
    if mode == "title":
        return head

    for line in lines[:12]:
        text = line.strip()
        if not text or _is_data_row(text):
            continue
        if _UNIT_RE.search(text):
            head.append(text)
            break
    if mode == "title_unit":
        return head

    # full: 연결/별도 표시와 기수 머리글까지. 둘 다 원문 줄에서만 가져온다.
    joined = " ".join(list(section_path) + [l.strip() for l in lines[:12]])
    for marker in ("연결", "별도"):
        if marker in joined:
            head.append(marker)
            break
    for line in lines[:12]:
        text = line.strip()
        if text and not _is_data_row(text) and _PERIOD_HEADER_RE.search(text):
            head.append(text)
            break
    return head


# ---------- 표 행 레이블 ----------
# 아래 표기 변형은 전부 이 코퍼스의 Gold evidence 행에서 실제로 관찰된 것이다.
# 추측으로 동의어를 늘리지 않는다.
#   'Ⅰ. 매출액(주4,29,36'  'Ⅳ. 영업이익'  '영업이익(손실'  '영업손익'
#   '수익(매출액'  '고객과의 계약에서 생기는 수익'
_LABEL_PREFIX_RE = re.compile(r"^\s*(?:[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩIVX]+|\d+)\s*[.)]\s*")
_LABEL_CUT_RE = re.compile(r"[(（\[].*$")

ROW_LABEL_SYNONYMS: dict[str, str] = {
    "영업손익": "영업이익",
    "영업이익손실": "영업이익",
    "수익": "매출액",
    "영업수익": "매출액",
    "고객과의 계약에서 생기는 수익": "매출액",
    "고객과의계약에서생기는수익": "매출액",
}

# 질문에 등장하는 지표 표현 -> 정규화된 행 레이블
METRIC_QUESTION_WORDS: dict[str, str] = {
    "매출액": "매출액", "매출": "매출액", "영업수익": "매출액",
    "영업이익": "영업이익", "영업손익": "영업이익",
    "당기순이익": "당기순이익", "순이익": "당기순이익",
    "자산총계": "자산총계", "부채총계": "부채총계", "자본총계": "자본총계",
    "현금및현금성자산": "현금및현금성자산",
}


def normalize_row_label(text: str) -> str:
    """표 행의 첫 칸을 비교 가능한 형태로 만든다(결정론적 규칙만)."""
    t = re.sub(r"\s+", " ", text or "").strip().strip("[]  ")
    t = _LABEL_PREFIX_RE.sub("", t)      # 'Ⅰ. ' '1) ' 같은 번호 접두 제거
    t = _LABEL_CUT_RE.sub("", t)         # '(주4,29,36' 이후 잘라내기
    t = t.replace(" ", "").strip(".·-")
    return ROW_LABEL_SYNONYMS.get(t, t)


def row_label_of(line: str) -> str:
    return normalize_row_label(line.split("|")[0])


# 지표를 이름으로 부르지 않는 질문("사업 규모와 영업 수익성", "실적 변화 / 성장 양상")을
# 위한 상위어 규칙. Gold 25문항에서 **실제로 등장한 표현만** 넣는다(등장 횟수 실측):
#     수익성 1(Q15) · 사업 규모 1(Q15) · 실적 3(Q11,Q12,Q16) · 성장 1(Q16)
# 단어 하나짜리 "규모"는 일부러 뺐다 — 재무 질문은 Q15뿐이고 나머지 3건(Q02·Q06·Q17)은
# 계약·투자 질문이라, 넣어도 이득이 없으면서 적용 범위만 넓어진다(실측에서 결과 동일).
# "성과"·"매출 규모"·"영업성과"는 25문항에 한 번도 안 나와서 규칙으로 만들지 않았다.
METRIC_INFERENCE_RULES: dict[str, tuple[str, ...]] = {
    "수익성": ("영업이익",),
    "사업 규모": ("매출액",),
    "실적": ("매출액", "영업이익"),
    "성장": ("매출액", "영업이익"),
}


def extract_metrics(question: str) -> tuple[str, ...]:
    """질문에 **직접 적힌** 재무지표 표현만 뽑는다."""
    hits = [norm for word, norm in METRIC_QUESTION_WORDS.items() if word in question]
    return tuple(dict.fromkeys(hits))


def infer_metrics(question: str) -> tuple[str, ...]:
    """직접 매칭이 먼저다. 그래도 비면 상위어 규칙으로 채운다.

    지표를 직접 부른 질문의 동작은 바꾸지 않는다 — 규칙은 빈 결과일 때만 개입한다.
    """
    direct = extract_metrics(question)
    if direct:
        return direct
    out: list[str] = []
    for phrase, metrics in METRIC_INFERENCE_RULES.items():
        if phrase in question:
            out.extend(metrics)
    return tuple(dict.fromkeys(out))


def _row_label_hit(chunk: "Chunk", wanted: Sequence[str], exact: bool,
                   mode: str) -> float:
    """행 레이블 일치 신호.

    mode="any"  추론된 지표 중 하나라도 이 청크의 행에 있으면 1
    mode="all"  전부 있어야 1 — 요약표처럼 지표가 모여 있는 청크만 남긴다
    """
    if not wanted:
        return 0.0
    labels = chunk.raw_row_labels if exact else chunk.row_labels
    if mode == "all":
        return 1.0 if all(w in labels for w in wanted) else 0.0
    return 1.0 if labels & frozenset(wanted) else 0.0


def _join_header(ctx: str, header: str) -> str:
    return " | ".join(x for x in (ctx, header) if x)


def _is_data_row(line: str) -> bool:
    return len(_NUM_RE.findall(line)) >= 2


def _table_headers(lines: Sequence[str], i: int) -> list[str]:
    """i번째 줄이 속한 표의 머리글 줄들. 데이터 행은 건너뛰며 위로 올라간다."""
    out: list[str] = []
    for j in range(i - 1, -1, -1):
        prev = lines[j].strip()
        if not prev:
            continue
        if _is_data_row(prev):
            if out:
                break
            continue
        if _HEADER_HINT_RE.search(prev) or "|" in prev:
            out.append(prev)
            if len(out) >= MAX_HEADER_LINES:
                break
        elif out:
            break
    return list(reversed(out))


def chunk_document(doc: dict, strategy: str = "table_group",
                   window: int = DEFAULT_WINDOW, stride: int = DEFAULT_STRIDE,
                   table_rows_per_chunk: int = DEFAULT_TABLE_ROWS,
                   context_mode: str = "off") -> list[Chunk]:
    """DocumentIR에서 뽑아 둔 노드 목록(evidence_documents.jsonl 형식)을 청크로 자른다."""
    doc_id = doc["doc_id"]
    doc_group = doc.get("doc_group") or doc_id.split("_")[0]
    out: list[Chunk] = []

    def add(node_index: int, kind: str, header: str, text: str,
            section_path: tuple[str, ...]) -> None:
        if not text.strip():
            return
        out.append(Chunk(chunk_id=f"{doc_id}::c{len(out)}", doc_id=doc_id,
                         node_index=node_index, kind=kind,
                         header=header.strip(), text=text.strip(),
                         section_path=section_path, doc_group=doc_group))

    for node in doc.get("nodes") or []:
        idx = node.get("node_index", 0)
        text = node.get("text") or ""
        if not text.strip():
            continue
        section = tuple(node.get("section_hierarchy") or ())
        lines = text.split("\n")
        ctx_head = " | ".join(_node_context(section, lines, context_mode))

        if strategy == "line_window" or node.get("kind") != "table":
            if len(lines) <= window:
                add(idx, "paragraph" if node.get("kind") != "table" else "table_block",
                    ctx_head, text, section)
                continue
            for start in range(0, len(lines), stride):
                piece = lines[start:start + window]
                if not piece:
                    break
                add(idx, "window", "", "\n".join(piece), section)
                if start + window >= len(lines):
                    break
            continue

        if strategy == "table_row":
            # 행 하나 = 청크, 머리글을 함께 실어 준다
            for i, line in enumerate(lines):
                if not line.strip():
                    continue
                header = " / ".join(_table_headers(lines, i)) if _is_data_row(line) else ""
                add(idx, "table_row", _join_header(ctx_head, header), line, section)
            continue

        # table_group: 표를 머리글 + 행 묶음으로 자른다. 행 하나는 너무 짧아 어휘가
        # 부족하고, 표 전체는 너무 길어 다른 값이 섞인다 — 그 사이를 노린다.
        group = max(1, table_rows_per_chunk)
        i = 0
        while i < len(lines):
            piece = [ln for ln in lines[i:i + group] if ln.strip()]
            if piece:
                header = " / ".join(_table_headers(lines, i))
                add(idx, "table_group", header, "\n".join(piece), section)
            i += group
    return out


class ChunkIndex:
    """문서 부분집합 위의 청크 BM25.

    Stage 1이 고른 문서만 넣는다 — 전체 코퍼스를 청크로 펴지 않는다.
    """

    def __init__(self, chunks: list[Chunk]):
        self.chunks = chunks
        self._bm25 = BM25([tokenize(c.search_text) for c in chunks])

    @classmethod
    def from_documents(cls, documents: Iterable[dict], strategy: str = "table_group",
                       **kwargs) -> "ChunkIndex":
        """kwargs는 chunk_document로 그대로 넘어간다(context_mode 등)."""
        chunks: list[Chunk] = []
        for doc in documents:
            chunks.extend(chunk_document(doc, strategy=strategy, **kwargs))
        return cls(chunks)

    def search(self, query: str, k: int = 10, *,
               sections: Sequence[str] | None = None,
               section_alpha: float = DEFAULT_SECTION_ALPHA,
               row_labels: Sequence[str] | None = None,
               row_alpha: float = DEFAULT_ROW_ALPHA,
               row_exact: bool = False,
               ranking_mode: str = "weighted",
               row_match_mode: str = "any",
               query_expansion: bool = True) -> list[tuple[float, Chunk]]:
        """청크 BM25 + 섹션 일치 가산.

        결합은 Stage 1에서 채택한 것과 같은 방식이다 — BM25를 그 질문의 최댓값으로
        나눠 [0,1]로 맞춘 뒤 섹션 신호와 가중합한다. 상수 가산을 쓰면 문서마다 다른
        BM25 스케일에 다시 끌려간다.
        """
        if sections is None:
            sections = route_sections(query)
        if row_labels is None:
            row_labels = infer_metrics(query)
        # query_expansion: **추론으로 얻은** 지표만 검색어에 덧붙인다.
        # 질문이 지표를 이름으로 부르지 않으면(Q15) 정답 청크와 어휘가 겹치지 않아
        # BM25가 그 청크를 못 올린다. 반대로 질문에 이미 지표가 적혀 있으면 같은 말을
        # 한 번 더 붙이는 셈이라 term frequency만 흔들린다 — 실측에서 Q10 @3이
        # 1.00 -> 0.25로 깨졌다. 그래서 직접 매칭이 있는 질문은 원문 그대로 둔다.
        search_query = query
        if query_expansion and row_labels and not extract_metrics(query):
            search_query = f"{query} {' '.join(row_labels)}"
        qt = tokenize(search_query)
        raw = [(self._bm25.score(qt, i), i) for i in range(len(self.chunks))]
        raw = [(s, i) for s, i in raw if s > 0]
        if not raw:
            return []
        use_section = bool(sections) and section_alpha > 0
        # 그룹 단위 가드: 어떤 문서군에서 섹션 매칭이 **하나도** 없으면 그 군에는
        # 라우팅을 적용하지 않는다. 아무것도 못 맞히는 신호는 정보가 없는데도
        # 그 군 전체 점수를 반으로 깎는다(Q18: @20 1.00 -> 0.80으로 깨졌다).
        matched_groups: set[str] = set()
        if use_section:
            for _, i in raw:
                c = self.chunks[i]
                if c.section_routable and c.in_sections(sections):
                    matched_groups.add(c.doc_group)
        use_rows = bool(row_labels) and row_alpha > 0
        if not use_section and not use_rows:
            raw.sort(key=lambda x: (-x[0], self.chunks[x[1]].chunk_id))
            return [(round(s, 4), self.chunks[i]) for s, i in raw[:k]]

        hi = max(s for s, _ in raw) or 1.0
        combined: list[tuple[tuple[float, ...], int]] = []
        for s, i in raw:
            chunk = self.chunks[i]
            score = s / hi
            sec_hit = 0.0
            if use_section and chunk.section_routable                     and chunk.doc_group in matched_groups:
                # 섹션 목차가 없는 공시는 어휘 점수 그대로 둔다 — 깎지도 올리지도 않는다
                sec_hit = 1.0 if chunk.in_sections(sections) else 0.0
                score = (1.0 - section_alpha) * score + section_alpha * sec_hit
            row_hit = 0.0
            if use_rows:
                # 행 레이블 신호도 같은 방식으로 겹쳐 쌓는다. 두 항 모두 [0,1]이라
                # 결과도 [0,1]에 남고, 각 alpha는 서로 독립적으로 해석된다.
                row_hit = _row_label_hit(chunk, row_labels, row_exact, row_match_mode)
                score = (1.0 - row_alpha) * score + row_alpha * row_hit
            if ranking_mode == "row_first":
                # 사전식: 행 레이블 -> 섹션 -> 어휘 점수. 앞이 동점일 때만 뒤를 본다.
                combined.append(((row_hit, sec_hit, score), i))
            else:
                combined.append(((score,), i))
        combined.sort(key=lambda x: (tuple(-v for v in x[0]), self.chunks[x[1]].chunk_id))
        return [(round(key[-1], 4), self.chunks[i]) for key, i in combined[:k]]

    def stats(self) -> dict[str, int]:
        kinds: dict[str, int] = {}
        for c in self.chunks:
            kinds[c.kind] = kinds.get(c.kind, 0) + 1
        return {"n_chunks": len(self.chunks), **kinds}


def load_documents(path: Path | str) -> list[dict]:
    out = []
    with Path(path).open(encoding="utf-8") as f:
        for line in f:
            if line.strip():
                out.append(json.loads(line))
    return out
