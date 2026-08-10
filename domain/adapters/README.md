# A DocumentIR adapter

A의 `parser_version=1.0.0`, `schema_version=1.0` JSONL은 변경하지 않고 보존한다.
이 디렉터리의 어댑터는 이를 B의 `document-ir.schema.json` 계약으로 변환한다.

## 경계

- A 원본은 source-faithful parsing artifact다.
- B Canonical DocumentIR은 안정적 ID, 파일 역할, locator, coverage 상태를 파생한다.
- 표의 원본 행과 정규화 행을 모두 보존한다.
- `TABLE_ROW` 청크, Fact, Event, 관계는 이 어댑터가 만들지 않는다.
- `fallback` 또는 실제 parse failure가 포함된 문서는 자동 검수 Fact의 입력으로 쓰지 않는다.
- A snapshot의 provenance, warning 의미, 79+2 실패 분리는 `A_HANDOFF_SNAPSHOT.md`와
  `a-warning-policy.v1.0.json`을 따른다.

## 로컬 실행

대용량 입력은 Git 밖에 두고 환경변수나 절대 경로로 지정한다.

```bash
node scripts/adapt-a-document-ir.mjs \
  --input-dir "$A_DOCUMENT_IR_DIR" \
  --target-corpus-snapshot-id corpus_04750795e1a2d5c3 \
  --validate-only \
  --audit-output work/a-document-ir/parse-audit.jsonl
```

대표 표본을 실제 변환하려면 `--limit`과 `--output`을 사용한다.

```bash
node scripts/adapt-a-document-ir.mjs \
  --input-dir "$A_DOCUMENT_IR_DIR" \
  --target-corpus-snapshot-id corpus_04750795e1a2d5c3 \
  --limit 11 \
  --output work/a-document-ir/canonical.sample.jsonl \
  --audit-output work/a-document-ir/parse-audit.sample.jsonl
```
