# Disclosure Relation Review Rubric v0.1

## General rule

manifest 제목·날짜 근접성만으로 관계를 확정하지 않습니다. 모든 승격 관계는
검수자, 판정 시각, 판단 근거 Evidence를 가집니다.

## AMENDS

다음 중 하나를 만족해야 승인할 수 있습니다.

1. 원문이 이전 접수번호 또는 공시일·공시명을 명시적으로 참조함
2. 동일 사건 stable key와 정정 전/후 field delta가 함께 일치함
3. 정기공시는 기업·보고서종류·회계기간이 같고 정정 대상 section/field가 일치함

보고서명과 30/365일 근접성만 일치하면 `PENDING`을 유지합니다. Exchange의
field delta는 변경내용의 강한 근거지만 대상 원본문서 identity를 단독 확정하지
못할 수 있으므로 event key 또는 명시 참조와 결합합니다.

EXCHANGE 정정표의 `정정관련 공시서류제출일`은 강한 명시 참조입니다. 동일
corp_code와 접수일, 보고서 family가 유일하게 일치하면
`EXPLICIT_REFERENCE_MATCH_REVIEW`로 올리되 사람이 Evidence를 확인하기 전에는
`ACCEPTED`로 바꾸지 않습니다. 명시 날짜에 해당하는 manifest 문서가 없으면
`TARGET_OUTSIDE_CORPUS_REVIEW`로 구분합니다.

## TERMINATES

20개 `단일판매공급계약해지` 문서를 전수 검수합니다. 다음 항목 중 최소 2개와
명시적 해지 표현이 일치해야 합니다.

- 계약명/목적
- 계약상대방
- 계약금액 또는 정정 후 금액
- 계약기간
- 원계약 접수번호·공시일

원계약이 corpus 기간 밖이면 관계를 억지로 만들지 않고 `TARGET_OUTSIDE_CORPUS`로
기록합니다.

후보 생성 시 manifest subtype은 정확히 `단일판매공급계약체결`을 사용합니다.
계약명·상대방·금액·시작일·종료일 Fact로 후보를 순위화할 수 있지만, 추천 결과는
`HIGH_CONFIDENCE_REVIEW`일 뿐 `ACCEPTED`가 아닙니다. 검수자가 원문 Evidence와
명시적 해지 표현을 확인해야 관계 Gold로 승격됩니다.

## CONFIRMS

후속 문서가 이전 미확정 공시를 확정한다고 명시하고, 기업·사건 주체·핵심 내용이
같을 때 승인합니다. 단순히 비슷한 투자판단 공시가 후속 제출된 것은 부족합니다.

## SAME_EVENT_AS

정정·해지·확정 이외에도 동일 사건임이 확인되지만 방향성 관계를 특정할 수 없을
때 사용합니다. `SAME_EVENT_AS`로 AMENDS/TERMINATES 판정을 대신하지 않습니다.

## Review outcomes

- `ACCEPTED`: Evidence를 갖춘 관계 Gold
- `REJECTED`: 다른 사건임이 확인됨
- `PENDING`: 후보는 있으나 identity 근거가 부족함
- `TARGET_OUTSIDE_CORPUS`: 대상 사건은 확인되지만 원문서가 제공 범위 밖임
- `PARSE_BLOCKED`: 필요한 원문 영역을 파싱하지 못함
