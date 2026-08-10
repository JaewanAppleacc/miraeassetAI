# DART Corpus Viewer

공시 Agent 전체 설계·진행 상태·Claude Code 인수인계는 `CLAUDE.md`를 먼저 확인합니다.

미래에셋증권 AI Festival 제공 공시 코퍼스를 원본 변경 없이 열람하는
로컬 뷰어입니다.

## 실행

```bash
npm install
npm run viewer
```

브라우저에서 `http://localhost:3000`을 엽니다.

기본 코퍼스 위치:

```text
/Users/jaewan/Downloads/3.공시/corpus
```

다른 위치를 사용하려면 실행 전에 환경변수를 지정합니다.

```bash
DISCLOSURE_CORPUS_ROOT="/새로운/corpus/경로" npm run viewer
```

## 기능

- `manifest.jsonl`을 이용한 보고서명·접수일·정정 여부 표시
- exchange, holding, major, periodic 문서군 탐색
- 기업·접수번호·보고서명 검색
- 실제 HTML/XML 형식 자동 판별
- 잘못된 HTML charset 선언 자동 교정
- DART XML의 제목·문단·표를 읽기 쉬운 HTML로 주문형 변환
- periodic 다중 첨부 파일 전환
- 렌더링 보기와 원문 보기

원본 `raw` 파일은 읽기만 하며 수정하거나 복제하지 않습니다.
