"""기업명 사전 — 질문에 등장하는 표기를 corp_name으로 되돌린다.

질문은 정식 법인명을 그대로 쓰지 않는다. universe.csv의 `corp_name` 하나만 보면
"KT가 결정한 자기주식 처분"에서 기업을 못 찾는다 — 코퍼스의 corp_name은 `케이티`다.
그래서 상장명(`listed_name`)과 종목코드까지 별칭으로 넣는다.

영문명(`corp_eng_name`)은 넣지 않는다. "SAMSUNG ..."처럼 여러 회사가 공유하는
선행 토큰이 있어 오검출이 더 크기 때문이다.
"""
from __future__ import annotations

import csv
import json
import re
from dataclasses import dataclass
from pathlib import Path

_ASCII_RE = re.compile(r"^[a-z0-9&.\-]+$")


def _norm(s: str) -> str:
    return "".join(s.split()).lower()


def _is_ascii_alias(key: str) -> bool:
    """한글이 없는 별칭. 부분문자열로 찾으면 오검출한다.

    실제로 걸렸던 예: 엔씨소프트의 상장명 `NC`가 `Salamanca` 안에서 잡혔다.
    """
    return bool(_ASCII_RE.match(key))


@dataclass(frozen=True)
class CorpDictionary:
    """별칭(정규화된 문자열) -> corp_name."""

    alias_to_corp: dict[str, str]

    @property
    def corp_names(self) -> set[str]:
        return set(self.alias_to_corp.values())

    # ---------- 생성 ----------
    @classmethod
    def from_rows(cls, rows: list[dict]) -> "CorpDictionary":
        alias: dict[str, str] = {}
        for r in rows:
            corp = (r.get("corp_name") or "").strip()
            if not corp:
                continue
            for raw in (corp, r.get("listed_name"), r.get("stock_code")):
                key = _norm(str(raw or ""))
                if len(key) < 2:
                    continue
                # 먼저 등록된 쪽을 유지한다 — corp_name이 항상 먼저 들어간다.
                alias.setdefault(key, corp)
        return cls(alias_to_corp=alias)

    @classmethod
    def from_universe_csv(cls, path: Path | str) -> "CorpDictionary":
        with Path(path).open(encoding="utf-8-sig", newline="") as f:
            return cls.from_rows(list(csv.DictReader(f)))

    @classmethod
    def from_manifest(cls, path: Path | str) -> "CorpDictionary":
        """universe.csv가 없을 때의 폴백 — manifest에도 corp_name/listed_name이 있다."""
        rows = []
        with Path(path).open(encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    rows.append(json.loads(line))
        return cls.from_rows(rows)

    # ---------- 조회 ----------
    def match(self, question: str) -> set[str]:
        """질문 문자열 안에 등장하는 기업을 전부 찾는다.

        - 한글이 섞인 별칭: 정규화 후 부분문자열 매칭(조사가 붙기 때문)
        - 순수 ASCII 별칭(KT, HMM, 종목코드): 단어 경계 매칭

        짧은 별칭이 긴 별칭의 부분문자열이면 짧은 쪽을 버린다 —
        "HD현대중공업"을 물었는데 "현대중공업"까지 같이 잡히면 안 된다.
        """
        q = _norm(question)
        q_ascii = question.lower()
        hit: set[str] = set()
        matched_keys: list[str] = []
        for key, corp in self.alias_to_corp.items():
            if _is_ascii_alias(key):
                found = re.search(rf"(?<![a-z0-9]){re.escape(key)}(?![a-z0-9])", q_ascii)
            else:
                found = key in q
            if found:
                hit.add(corp)
                matched_keys.append(key)
        if len(hit) <= 1:
            return hit
        drop: set[str] = set()
        for key in matched_keys:
            for other in matched_keys:
                if key != other and key in other:
                    drop.add(self.alias_to_corp[key])
        return {c for c in hit if c not in drop} or hit
