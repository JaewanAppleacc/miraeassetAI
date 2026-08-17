# Parse Recovery Overlay

이 계층은 A DocumentIR을 교체하지 않고, 구조화 파싱에 실패한 source file만 복구 후보로
추가한다. Recovery Node는 canonical `node_id`를 재사용하지 않으며 공식 검색·Fact·Gold에
자동 승격되지 않는다.

## 대상과 방법

- A `fallback` 79건: C의 `TOLERANT_XML` 결과를 후보로 변환한다.
- `PDF_VIEWER_EMPTY_NO_TABLES` 2건: 원본 PDF text layer를 `pdftotext -layout`으로 페이지별
  추출한다. text layer가 비어 있을 때만 별도 OCR 단계를 검토한다.

## 실행

```bash
node --max-old-space-size=4096 scripts/build-parse-recovery-overlay.mjs \
  --a-document-ir "$A_DOCUMENT_IR_DIR/periodic-001.jsonl" \
  --parse-audit work/a-document-ir/parse-audit.full.jsonl \
  --c-zip "$C_DOCUMENT_IR_ZIP" \
  --corpus-root "$CORPUS_ROOT/raw" \
  --manifest "$CORPUS_ROOT/manifest.jsonl" \
  --output-dir work/parse-recovery

node scripts/validate-parse-recovery-overlay.mjs \
  work/parse-recovery/parse-recovery-overlay.candidate.jsonl
```

## 승격 조건

`HUMAN_REVIEW_REQUIRED`는 성공 판정이 아니다. 문서별로 다음 조건을 확인하고 검수자가
`VERIFIED`로 바꾼 결과만 downstream에 사용한다.

1. 원문과 텍스트가 일치한다.
2. 표 행·열 또는 PDF 페이지 locator가 실제 원문에서 해소된다.
3. 중복 Node가 검색 결과를 오염시키지 않는다.
4. 같은 입력을 재실행했을 때 Overlay SHA-256이 동일하다.
5. 기존 A `document_id`, `node_id`, `source_locator`가 바뀌지 않는다.

승격 후에도 새 Processing Snapshot을 발급하고, 해당 81건에 대해서만 Chunk·Embedding·
Index·Evidence·Gold를 다시 검증한다.
