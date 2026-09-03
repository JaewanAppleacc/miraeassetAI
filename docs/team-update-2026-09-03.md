# 팀 공유 업데이트 — 2026-09-03 (분담안·계약 문서에서 바뀐 것)

처음 공유한 `team-split.md`·`interfaces.md` 기준으로 **바뀐 것만** 모았다. 원본 문서도 같은 내용으로 갱신돼 있다.

## 전원 공통

1. **의역 세트 절차가 통째로 없어졌다.** 조건 사전 계산 결과 LOW가 20문항(vFINAL 기준 10 이상)이라
   LOW_UNDERPOWERED가 발동하지 않는다. → 내 의역 작성(내 5번), **팀원2의 독립 검수(팀원2 6번) 불필요**.
   단, 판정 중 16A 공통 제외로 LOW가 10 미만이 되면 되살아난다.
2. **예전 실측 숫자의 측정 범위 주의.** 내 예전 "슬롯 97%"는 정답 문서 106건만 청킹한 풀의 수치였다.
   전체 코퍼스(4,204건)에서 같은 코드는 Recall@10 0.605다. **팀원1의 "Fixed R@10 0.868(bounded)"도
   측정 범위(후보 풀이 전체였는지)를 킥오프에서 확인 필요.** 4-arm이 전체 코퍼스 위 첫 공정 비교다.
3. **B/D는 이미 실행·판정 완료(2-arm 잠정).** 전체 코퍼스·101문항 실측:
   | arm | R@10 | R@20 | LOW 전부발견 | 치명/경미/미해결 | p95 |
   |---|---|---|---|---|---|
   | B (LOW만 KURE 재정렬) | 0.6084 | 0.6818 | 12/19 | 0/0/0 | 19.7s |
   | D (BM25만) | 0.6049 | 0.6748 | 11/19 | 0/0/0 | 4.3s |
   판정 체인 결과 동률 집합 {B, D} → dense-off 우선 → **D = PROVISIONAL_WINNER**. A/C 결과가 오면
   4-arm으로 재판정한다. 재현 pin(코드·config·입력 SHA)은 `results/fourarm/*.run.json`.
4. **conditions 파일 확정**: `data/eval/devtune101_conditions.v1.jsonl`,
   SHA `6ff1b4fce45bb46db0179d79439a310bcbb95cb3c1e1b2e2ddb2acd165137cf5`. LOW 20 / HIGH 81.
   네 arm 모두 메타필터 입력은 이 파일만 쓴다(Gold 유래 정보 금지 — 위반 시 실험 INVALID).

## 팀원1 (A/C)

5. **러너 출력에 선택 필드 추가**(interfaces §1-1): `text`(청크 본문 — 채점 2순위 대조·UNRESOLVED 검토용,
   권장), `node_indices`(Fixed 청크가 node 경계를 넘을 때 걸친 node 전부), `segment` echo.
   채점기는 node 번호 일치를 1순위로 보므로 Gold locator 문자열을 흉내 낼 필요 없다.
6. **공용 채점기·판정 체인 완성**: `scripts/fourarm/score.py` (Recall@k·LOW 판정·locator 치명/경미/미해결·
   UNRESOLVED 패킷(arm-blind)·판정 체인 전 단계). A/C 결과 파일만 두면 `--arms A B C D`로 4-arm 판정이
   바로 나온다. 채점 정의는 interfaces §1-5에 동결.
7. **러너는 미커밋 코드로 돌면 실행을 거부한다**(재현성 — code SHA가 실행 코드를 pin해야 함).
   A/C 러너도 같은 원칙 권장: 결과 제출 시 코드 커밋 SHA·config SHA·입력 SHA를 함께.

## 팀원2 (배포·운영)

8. **qa_service가 부를 함수 확정·구현 완료**(interfaces §2-1): `answer_api.answer_ex(question_id, question,
   deadline_s=남은 초)` → (5필드 wire, meta). **meta.cacheable=False면 캐시에 넣지 말 것**(폴백·저하·
   시간부족 답). `readiness()`가 /ready와 pin(문서 SHA·프롬프트 지문) 제공. 어떤 내부 오류에도 예외 대신
   유효 5필드를 돌려주므로 qa_service는 감쌀 필요 없음.
9. **정책 게이트 내장**: 투자의견·예측·추천 거절, 질문 내 지시문 무력화, "현재/최근" 컷오프 해석 고지.
   qa_service에서 따로 만들 필요 없음.
10. **의역 검수 대신** 안전 세트 문항·별칭 점검에 시간을 쓰면 된다(위 1번).
11. **서빙 실측(LLM 없이, 101문항)**: 5필드 계약 위반 0 · p95 4.2초 · 문항당 최대 9초 — 290초 데드라인
    설계에 큰 여유. 세마포어 1 기준 무리 없음.

## 미결 (킥오프 결정 필요 — 변화 없음)

- Gold Owner 지정(DEV_CHECK one-shot 실행자·UNRESOLVED arm-blind 판정자)
- A/C 전체 인덱스 READY 컷오프와 미실행 arm 처리
- PG 호스팅 위치·비용
- CLOVA 크레딧 쿠폰 등록 확인 + 서비스앱 신청 여부
