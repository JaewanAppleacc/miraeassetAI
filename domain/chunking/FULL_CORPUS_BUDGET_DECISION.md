# Full-corpus chunk budget decision

대상은 `corpus_04750795e1a2d5c3`의 DocumentIR 4,204건이다. 실제 청크 JSONL이나
임베딩을 생성하지 않고 동일 chunker를 전수 실행해 규모를 계측했다.

## 결과

| 전략 | 검색 청크 | 기준선 대비 | embed token | 기준선 대비 | 동일 embed_text 캐시 후 예상 호출 |
|---|---:|---:|---:|---:|---:|
| Fixed 512/64 | 442,549 | 1.00× | 239,315,835 | 1.000× | 약 437,610 |
| Section-aware Flat | 516,806 | 1.17× | 238,765,841 | 0.998× | 약 493,695 |
| Hierarchical v0.2 | 1,516,186 | 3.43× | 242,067,984 | 1.012× | 약 1,408,582 |

Hierarchical v0.2 검색 청크 구성:

- `TABLE_ROW`: 1,286,936
- `PARAGRAPH_CHILD`: 219,163
- `FIELD_GROUP_CHILD`: 10,087
- PERIODIC: 1,437,312 (전체 검색 청크의 약 94.8%)

문서별 검색 청크는 p50 27, p90 1,318, p99 3,311, 최대 6,788이다. 전체 raw text
기준 전역 완전 중복률은 약 39.0%지만, 기업·문서·섹션 문맥까지 같은 `embed_text`
재사용으로 줄일 수 있는 API 호출은 약 107,604건이다. raw text가 같다는 이유로
나머지를 삭제하면 정정·기간·parent·locator 정보가 손실될 수 있다.

## 결정

1. Hierarchical v0.2는 최종 승자가 아니라 `BUDGET_REVIEW_REQUIRED` 후보이다.
2. 세 전략×세 임베딩 모델의 전량 임베딩은 실행하지 않는다.
3. 대표 표본과 Gold 검색에서 청킹 후보를 먼저 2개 이하로 줄인다.
4. 동일 `embed_text`는 임베딩 계산만 캐시하고 인덱스의 chunk/source locator는 유지한다.
5. PERIODIC 검색은 전역 top-k가 아니라 company×period×topic metadata filter와
   evidence-slot quota를 선행한다.
6. raw repeated section은 hard delete하지 않고 RRF 이후 감점 규칙을 ablation한다.
7. Hierarchical이 Evidence Slot Recall 또는 nDCG@10에서 절대 2%p 이상 개선하지
   못하면 Section-aware Flat 또는 Fixed를 채택한다.

## 다음 실험 순서

1. C가 대표 11건에 BM25를 연결해 세 전략의 결과 형식을 검증한다.
2. B가 검색 평가 Gold를 확장하고 source-span recall을 확정한다.
3. 세 청킹 전략을 BM25로 비교한 뒤 상위 2개만 Dense 실험으로 넘긴다.
4. KURE-v1/BGE-M3/PIXIE-Rune 비교는 같은 최종 청크 후보와 고정 split에서 수행한다.
5. 승자 조합만 전체 corpus 청크·임베딩·인덱스를 생성한다.

상세 수치는 로컬 생성물 `work/chunk-profile/full-corpus-chunk-budget.json`에 있다.
전역 cardinality는 HyperLogLog p=14 근사치이며 청크 수·토큰 수·문서군별 수치는
정확한 전수 합계다.
