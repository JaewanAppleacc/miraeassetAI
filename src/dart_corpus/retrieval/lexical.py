"""어휘 검색 원자재 — 토크나이저 + BM25.

`dart_detective.retriever`에 있던 구현을 그대로 옮겨 온 것이다. 데모 Agent와
코퍼스 규모 Retriever가 **같은 토크나이저**를 써야 실험 결과를 서로 비교할 수 있어서
한 곳으로 모았다. `dart_detective.retriever`는 여기서 re-export한다.
"""
from __future__ import annotations

import math
import re
from collections import Counter
from typing import Iterable

_WORD_RE = re.compile(r"[A-Za-z]+|[0-9][0-9,\.]*")
_HANGUL_RE = re.compile(r"[가-힣]+")


def tokenize(text: str) -> list[str]:
    """한국어 형태소 분석기 없이 쓰는 경량 토크나이저.

    - 영문/숫자는 단어 단위
    - 한글은 음절 bigram(+ 1음절 어절은 그대로) — 조사 변화에 견디는 값싼 방법
    """
    text = text.lower()
    tokens: list[str] = [m.group() for m in _WORD_RE.finditer(text)]
    for m in _HANGUL_RE.finditer(text):
        w = m.group()
        if len(w) == 1:
            tokens.append(w)
            continue
        tokens.extend(w[i:i + 2] for i in range(len(w) - 1))
    return tokens


class BM25:
    """의존성 없는 최소 BM25. 데모 규모(수백 chunk)에서는 이걸로 충분하다."""

    def __init__(self, corpus_tokens: list[list[str]], k1: float = 1.5, b: float = 0.75):
        self.k1, self.b = k1, b
        self.docs = corpus_tokens
        self.n = len(corpus_tokens)
        self.doc_len = [len(t) for t in corpus_tokens]
        self.avgdl = (sum(self.doc_len) / self.n) if self.n else 0.0
        self.tf: list[Counter] = [Counter(t) for t in corpus_tokens]
        df: Counter = Counter()
        for t in corpus_tokens:
            df.update(set(t))
        self.idf = {
            term: math.log(1 + (self.n - c + 0.5) / (c + 0.5))
            for term, c in df.items()
        }

    def score(self, query_tokens: Iterable[str], index: int) -> float:
        tf = self.tf[index]
        dl = self.doc_len[index] or 1
        total = 0.0
        for term in query_tokens:
            f = tf.get(term)
            if not f:
                continue
            idf = self.idf.get(term, 0.0)
            total += idf * (f * (self.k1 + 1)) / (f + self.k1 * (1 - self.b + self.b * dl / self.avgdl))
        return total
