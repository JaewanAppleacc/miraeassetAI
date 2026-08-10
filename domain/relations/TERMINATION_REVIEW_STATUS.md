# TERMINATES review status

manifest subtype 오류를 수정해 `단일판매공급계약해지` 20건의 선행
`단일판매공급계약체결` 후보를 다시 생성했다. 계약명·상대방·금액·시작일·종료일
Fact를 대조해 순위를 매겼지만 모든 `review_status`는 `PENDING`으로 유지한다.

## 현재 분포

- `HIGH_CONFIDENCE_REVIEW`: 8건
- `MANUAL_DISAMBIGUATION_REQUIRED`: 11건
- `NO_TARGET_IN_MANIFEST_CANDIDATES`: 1건

고신뢰 검수 후보:

| 해지 문서 | 추천 원계약 | identity score | 일치 필드 수 |
|---|---|---:|---:|
| `exchange_20251217800800` | `exchange_20241015800258` | 0.80 | 4 |
| `exchange_20250618800387` | `exchange_20240612800459` | 0.90 | 4 |
| `exchange_20250618800388` | `exchange_20240612800468` | 0.90 | 4 |
| `exchange_20260316801038` | `exchange_20260203800709` | 0.90 | 4 |
| `exchange_20241128800504` | `exchange_20240618800188` | 1.00 | 5 |
| `exchange_20250508800712` | `exchange_20241104800041` | 1.00 | 5 |
| `exchange_20240603800359` | `exchange_20230331802739` | 0.90 | 4 |
| `exchange_20250402800768` | `exchange_20250123800469` | 0.70 | 3 |

`exchange_20230227800485`는 제공 기간 안에 더 이른 계약체결 문서 후보가 없다.
원문에서 원계약 공시일·접수번호를 확인한 뒤에만 `TARGET_OUTSIDE_CORPUS`로 판정한다.

## 검수 방법

1. 해지 문서에 명시적 해지 표현이 있는지 확인한다.
2. 추천 원계약과 계약명·상대방·금액·기간 중 최소 두 항목을 원문 Evidence로 확인한다.
3. 정정 공시가 있으면 latest-effective 금액·기간을 사용한다.
4. 검수자와 시각, source/target Evidence ID를 기록한 뒤 `ACCEPTED`로 승격한다.

점수가 높아도 자동 승인하지 않는다. 점수 0인 후보는 extractor 실패일 수도 있으므로
관계 부재로 간주하지 않고 원문 표와 명시 참조를 직접 확인한다.

## AMENDS 선행 의존성

고신뢰 8건 중 비정정 원계약 2건은 `READY_FOR_HUMAN_REVIEW`다. 나머지 6건은
추천 대상이 정정공시이므로 `BLOCKED_UNTIL_TARGET_AMENDS_CHAIN_CLOSURE`로 둔다.

정정표의 명시 제출일을 추출한 결과:

- corpus 내부 원공시 정확 매칭: 2건
  - `exchange_20260203800709` → `exchange_20230602800079`
  - `exchange_20250123800469` → `exchange_20231006800130`
- 명시 원공시가 corpus 기간 밖: 4건
  - 참조일: 2021-10-18, 2020-11-23, 2020-02-27, 2022-04-27

각 AMENDS 항목을 사람이 `ACCEPTED` 또는 `TARGET_OUTSIDE_CORPUS`로 검수한 뒤에만
해당 TERMINATES 패킷의 차단을 해제한다.
