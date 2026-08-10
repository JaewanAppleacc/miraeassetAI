# A DocumentIR snapshot acceptance note

## 생성 provenance

- source snapshot: `snap_7484a10220422056`
- manifest SHA-256: `04750795e1a2d5c35f73e4bb7766ebede02ff3512d33c382bd4c3a51daba3364`
- universe SHA-256: `96560165c836b10e315cb253ab96a99b369478c3f71a0415d16b7b6fadbfa1dc`
- parser version: `1.0.0`
- parser config hash: `52b37a07da4cb420cb607183fb2e1f088634eb003b69435748b0670eb366bfe1`
- generation commit: `e4a417c280aa0bfb437f8c15c60a36c3b777798d`

이후 저장소 커밋은 `document_metadata.jsonl`을 추가했으나, 전달받은 전체
DocumentIR의 provenance는 반드시 위 generation commit으로 기록한다.

## Parse coverage 판정

| 집합 | 건수 | 내용 보존 | B coverage | 검색·Fact 정책 |
|---|---:|---|---|---|
| 정상/허용 partial | 4,123 | 노드 존재 | `PRESENT` | warning별 gate 적용 |
| malformed XML fallback | 79 | raw text 최대 20,000자 | `PARTIAL_PARSE_FAILURE` | 자동 검색·Fact 금지, 복구 후보 |
| PDF viewer empty | 2 | 노드 0, 보존율 0.0 | `PARSE_FAILED` | 청크 생성 금지, 정보한계 응답 |

빈 PDF viewer 문서:

- `periodic_20260619000667` / `20260619000667_viewer.html`
- `periodic_20240514001522` / `20240514001522_viewer.html`

두 문서는 원본 PDF 본문을 현재 파서가 읽지 않고 viewer HTML에도 `<table>`이 없어
완전히 누락됐다. reason code는 `PDF_VIEWER_EMPTY_NO_TABLES`로 고정한다. 복구하려면
별도 PDF text parser 또는 OCR이 필요하다. 외부 코퍼스를 추가하는 것이 아니라 제공된
원본 PDF를 재처리하는 작업이므로 대회 데이터 범위 안에서 수행할 수 있다.

## Warning 의미

정확한 기계 판정은 `a-warning-policy.v1.0.json`을 따른다. 다음 네 경고는 원문
텍스트 손실을 뜻하지 않는다.

- `unknown_section_depth`: 제목 계층 불확실성
- `table_merged_cell_ignored`: 실제로는 병합셀을 확장하며 warning 이름만 부정확
- `table_shape_mismatch`: raw row 보존, 열 정렬 불확실성
- `table_metadata_uncertain`: 표 내용 보존, 제목·단위·기간 metadata 불확실성

## 재현성 상태

node ID와 locator는 `doc_id + rel_path + order_index` 및 고정 traversal 순서로
결정론적으로 생성되도록 구현돼 있다. canonical hash 검증 코드도 존재한다. 그러나
4,204건 전체를 동일 환경에서 두 번 실행해 hash를 비교한 실측은 아직 없다.

따라서 현재 snapshot은 개발 입력으로 승인하되, 최종 index snapshot 동결 전에는
전수 2회 재실행 또는 기존 hash manifest와의 semantic hash 비교를 acceptance gate로
남긴다. byte-for-byte 재현성까지 검증됐다고 표현하지 않는다.
