# Seed v0.20-r3 Candidate — Owner 최종 검수

상태: **PENDING**
이 문서는 검수를 돕는 요약이며 승인 결정 자체가 아닙니다. 아래 항목을 사람이 모두 확인하기 전에는 release를 승인하거나 production Runtime을 전환하지 않습니다.

## 검수할 5개 항목

- [ ] **Clean Plan 계보**: bundle의 Thin Plan은 `v0.13.clean.candidate`이며, `v0.12.clean`을 거쳐 공식 Plan v0.6 clean 계보로 연결되고 `sub_request_authority` 연구 계보를 포함하지 않는다.
- [ ] **Q18 정보한계**: `54,495주`와 `주당 40,350원`은 표시하지만 `2,198,873,250원`을 직접 공시된 발행총액이라고 주장하지 않는다.
- [ ] **Turn M10.1 변경 7건**: Q02/Q10/Q13/Q15/Q17/Q20/Q24의 변화가 중복 제거·시간순 정렬·자연스러운 조사·단독 투자금액 일반 렌더링에 한정된다.
- [ ] **예상 밖 회귀 없음**: r14→r16에서 위 7건 외 18문항은 무변화이며, Q02는 r13 답변으로 바이트 동일 복귀, Q06·Q25는 무변화다.
- [ ] **승인 데이터 결합**: Owner batch decision과 병합 Owner decision v0.10, Fact v0.8, Coverage v0.7, Evidence v0.9, Company Directory v0.2가 동일 bundle closure로 결합됐다.

## 기계 검증 근거

- 실제 bundle manifest SHA-256: `5158b001df5c2a2119f66f1b00fbdf92ac79311a9a73c4ef7013981f86640726`
- Turn M10.1 closure report SHA-256: `cf45066a8e2db40883eacd3ec8d62766f3d95c9e9c48fb63797a1502db6be84d`
- 격리 bundle `/ready`: PASS
- 격리 bundle 25문항 `/answer`: 25/25 HTTP 200, Wire schema PASS, 빈 답변 0
- 전체 계약 테스트: 1,599 PASS / 0 FAIL / 기존 SKIP 3
- schema:validate: PASS (13 pairs)
- typecheck: clean
- build: PASS
- git diff --check: clean

## 승인 후에만 수행할 작업

1. 별도 APPROVED Owner decision 생성 및 위 bundle SHA pin
2. stage/commit 후 official clean-clone 재현 시험
3. clean-clone 성공 후 production Runtime 결합
4. 최종 v0.20 release 승인 및 필요 시 push

현재는 위 작업을 수행하지 않았습니다.
