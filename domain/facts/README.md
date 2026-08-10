# Fact Ontology v0.1

## Purpose

공시 원문 라벨을 그대로 DB 컬럼으로 만들지 않고, 질문·계산에 필요한 의미를
안정적인 `metric_code`로 통일합니다. 원문 라벨은 alias로 보존하며 ontology에
없는 항목은 버리지 않고 generic Fact로 저장합니다.

## Extraction boundary

- 담당자 A는 `DocumentIR`에서 표·필드·원문 locator를 손실 없이 제공합니다.
- 담당자 B는 metric mapping, scope, period, certainty, version과 검수 상태를 확정합니다.
- 규칙 또는 모델이 만든 값은 `CANDIDATE`이며 Evidence 검수 전 `VERIFIED`가 아닙니다.
- 담당자 C는 검수된 Fact와 candidate Fact를 분리하여 평가합니다.

## Required normalization

수치 Fact는 다음 세 값을 함께 보존합니다.

1. `raw_value_text`: 원문 그대로의 값
2. `raw_unit_text`: 표 머리글·주석의 원문 단위
3. `normalized_value`: scale과 currency를 적용한 계산용 값

연결/별도, 분기/누계, 정정 전/후가 하나라도 불명확하면 값을 추정하지 않고
해당 dimension을 `UNKNOWN`으로 남긴 뒤 검수 대상으로 보냅니다.

## Initial scope

v0.1은 평가 가능성이 높고 결정론적 계산에 직접 필요한 핵심 지표를 우선합니다.
ontology 외 필드는 `GENERIC_FACT_WITH_RAW_LABEL`로 수용한 뒤 오류 분석을 통해
정식 metric으로 승격합니다.
