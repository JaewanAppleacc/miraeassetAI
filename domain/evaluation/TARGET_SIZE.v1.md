# Evaluation Target Size — CURRENT (Turn N4.0)

**상태: CURRENT.** `domain/evaluation/README.md`의 "Dataset roles" 표(500 설계)는
**HISTORICAL**로 표시됐다 — 삭제하거나 몰래 덮어쓰지 않았고, 그 문서의 나머지
내용(split-before-authoring 금지, PROVISIONAL_UNTIL_CHAIN_CLOSURE 등 usage freeze
규칙, critical slice 목록, CONFLICTING_EVIDENCE 정책, two-person review)은 여전히
유효하며 이 문서가 대체하지 않는다. 이 문서는 **오직 목표 규모(500 vs 300)**만
`PROJECT_NEXT_STEPS.md`(최신)를 기준으로 정정한다. 두 작업자(A/B) 150/150 분담
정책은 별도 [`AUTHOR_ALLOCATION.v1.md`](./AUTHOR_ALLOCATION.v1.md)(Turn N4.0.1)를
참고한다.

## 충돌 정리

| 항목 | 과거 (`domain/evaluation/README.md`, HISTORICAL) | 현재 (`PROJECT_NEXT_STEPS.md`, CURRENT) |
|---|---:|---:|
| 최종 Gold 총합 | 500 (DEV_TUNE 250 / DEV_CHECK 100 / HOLDOUT 150) | **300** (DEV_TUNE 150 / DEV_CHECK 50 / HOLDOUT 100) |
| Candidate Pool | 명시 없음 | **300~500** |
| Anchor Gold | 명시 없음 | **120~150** |
| Challenge | 명시 없음 (REGRESSION만 언급) | **별도 50~80** |
| Regression | 500과 별도 동적 suite | 실제 결함에서만 동적 추가 (변경 없음) |

## 확정 숫자 (CURRENT, Turn N4.0 기준)

```text
Candidate Pool 목표     : 300~500
Anchor 상호검수 목표    : 120~150   (Candidate Pool의 부분집합)
최종 공식 Gold          : 300
  DEV_TUNE  150
  DEV_CHECK 50
  HOLDOUT   100
Challenge (별도)        : 50~80
Regression              : 실제 결함에서만 동적으로 추가 (사전 목표 수 없음)
```

**Seed 25와 Retrieval Seed 5는 위 어떤 숫자에도 포함되지 않는다.** 각각 배선·회귀
검증과 인터페이스 smoke 전용이며, Candidate Pool/Anchor/Gold/Challenge/Regression의
모집단이 아니다.

## 근거

- `PROJECT_NEXT_STEPS.md` Phase 2 "평가 데이터 확대"의 체크리스트가 이미 이
  숫자들을 선언하고 있다 (300~500 / 120~150 / 300 / 150·50·100 / 50~80).
- CLAUDE.md 11절("Evaluation lifecycle")도 동일한 숫자를 확정 문서로 명시한다.
- `domain/evaluation/README.md`의 500 설계는 그보다 이전 revision이며, 이후
  숫자가 갱신됐다는 근거(PROJECT_NEXT_STEPS.md, CLAUDE.md)가 명확하므로 최신
  기준을 따른다. README 자체는 삭제하지 않고 HISTORICAL 배너만 추가했다
  (아래 "README.md 변경" 참고).

## `domain/evaluation/README.md`에 추가한 것

파일 최상단에 다음 배너만 추가했다(기존 181줄 내용은 전혀 수정하지 않음):

```markdown
> **STATUS: HISTORICAL (목표 규모만).** 아래 "Dataset roles" 표의 500 목표는
> `TARGET_SIZE.v1.md`(CURRENT)의 300 목표로 대체됐다. 이 문서의 나머지 내용
> (split-before-authoring 금지, PROVISIONAL_UNTIL_CHAIN_CLOSURE 등 usage freeze
> 규칙, critical slice 목록, CONFLICTING_EVIDENCE 정책, two-person review)은
> 여전히 CURRENT다 — 목표 규모 숫자만 아래를 대체 참고한다.
```

## 이 문서가 하지 않는 것

- `evaluation-gold.v0.2.schema.json`을 변경하지 않는다(계약 결함 없음).
- 공식 Gold를 승인·lock하지 않는다(전부 CANDIDATE/PROVISIONAL/NOT_STARTED).
- Anchor 120~150 작성을 시작하지 않는다 — 이 문서는 숫자 정리일 뿐이다.
