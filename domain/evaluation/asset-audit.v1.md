# Evaluation Asset Audit (Turn N4.0)

기계적으로 측정한 스냅샷이다. 판단·결정은 여기 담지 않는다 — 숫자만 기록한다.
전체 데이터는 [`asset-audit.v1.json`](./asset-audit.v1.json)에 있다.

## 자산별 실제 역할과 건수

| 자산 | 역할 | 건수 | 공식 Gold 여부 |
|---|---:|---:|---|
| Seed 25 | 배선·회귀 전용 | 25 | 아니오 |
| Retrieval Seed 5 | 인터페이스 smoke 전용 | 5 | 아니오 |
| 평가 작성 큐(150) | 작성 후보(계획), Gold 아님 | 150 | 아니오 |
| 공식 승인 Gold | 없음 | 0 | — |
| AMENDS 관계 후보 | 미검수(PENDING) | 1,004 | — |
| TERMINATES 관계 후보 | 미검수(PENDING) | 20 | — |
| CONFIRMS 관계 후보 | 아직 없음 | 0 | — |

`domain/HANDOFF.md`가 이미 명시한다: "현재 큐는 Gold가 아니라 작성 계획입니다."
이번 Turn은 이 경계를 다시 정확히 확인했을 뿐, 바꾸지 않았다.

## 4,204 corpus 문서유형별 (실측)

| doc_group | 총 문서 | is_correction=true |
|---|---:|---:|
| periodic | 1,054 | 159 |
| major | 598 | 173 |
| exchange | 1,469 | 631 |
| holding | 1,083 | 41 |
| **합계** | **4,204** | **1,004** |

## parse 상태별 문서 수 (실측)

| 상태 | 문서 수 |
|---|---:|
| PRESENT | 4,123 |
| PARTIAL_PARSE_FAILURE | 79 |
| PARSE_FAILED | 2 |
| **합계** | **4,204** |

## 근거 파일

- `domain/evaluation/README.md` (HISTORICAL — 500 설계, 아래 target-size 문서 참고)
- `domain/evaluation/evaluation-gold.v0.2.schema.json` (미변경)
- `domain/evaluation-harness/README.md`
- `scripts/build-evaluation-authoring-queue.mjs` → `work/domain-seed/evaluation-authoring-queue.jsonl`(150)
- `domain/retrieval/retrieval-evaluation-seed.v0.1.jsonl`(5)
- `PROJECT_NEXT_STEPS.md` (CURRENT — 300 설계)
- `domain/HANDOFF.md`
- `work/domain-seed/relation-review-queue.jsonl`(AMENDS 1,004 + TERMINATES 20)
- `work/domain-seed/document-parse-coverage.jsonl`
- 실제 4,204문서 corpus `manifest.jsonl`, `universe.csv` (Git 미포함, pin만 참고 — `TARGET_SIZE.v1.md` 참고)
