# Chunking contract v0.1

이 계약은 A DocumentIR과 C 실험 플랫폼 사이의 B 산출물이다. C의 요청 목록을
그대로 독립 전략으로 만들지 않고, 누적 설계에 따라 다음 세 전략을 비교한다.

1. `fixed-token`: 512/64 baseline
2. `section-aware-flat`: 계층 없는 section comparator
3. `document-type-hierarchical-parent-child`: 주력 전략 + 표 이중 표현

`PARAGRAPH_CHILD`, `TABLE_WHOLE`, `TABLE_ROW`는 독립 전략이 아니라 주력 전략의
chunk type이다.

## 텍스트 의미

- `raw_text`: 답변 근거로 제시할 source-faithful 텍스트 또는 결정론적 표 선형화
- `embed_text`: 기업·문서·섹션·chunk type을 앞에 붙인 검색 전용 텍스트
- `token_count`: `raw_text` 토큰 수
- `embed_token_count`: `embed_text` 토큰 수

Gold는 chunk ID를 정답으로 고정하지 않는다. `document_id + source_spans`를 근본
근거로 사용하고, chunk ID는 각 전략에서 파생한다.

## 품질 게이트

- `structured`: retrieval/fact 후보 허용
- sanitizer-only `partial`: retrieval/fact 후보 허용하되 warning 보존
- PDF+viewer `partial`: retrieval 허용, fact 자동 승격 금지
- `fallback`: 샘플은 생성하되 retrieval/fact 모두 금지
- zero-block parse failure: 청크 생성 금지

## 전략 설정

정확한 파라미터와 문서유형별 정책은 `strategy-configs.v0.1.json`이 유일한 기준이다.
실험에서 설정을 바꾸면 기존 config를 수정하지 않고 새 `chunking_config_id`를 만든다.

## Dedup과 예산

`chunk-budget-policy.v0.1.json`을 따른다. raw text가 같아도 기업·문서·섹션 문맥이나
parent가 다르면 청크를 합치지 않는다. `embed_text`까지 완전히 같은 경우에만 임베딩
계산 결과를 재사용하며, 각 chunk와 source locator는 별도로 유지한다. 서로 다른 문서의
동일 텍스트는 정정·기간·사건 버전일 수 있으므로 관계 확정 전에는 삭제하지 않는다.

```bash
node scripts/profile-chunk-budget.mjs \
  --chunk-dir work/chunk-handoff \
  --output work/chunk-handoff/chunk-budget-report.json
```
