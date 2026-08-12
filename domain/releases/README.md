# Seed release locks

`work/` 아래의 Seed 산출물은 대용량·로컬 작업 데이터라 Git에서 제외한다. 이 디렉터리의
manifest는 해당 산출물의 경로, 크기, 레코드 수, SHA-256과 교차 참조 불변식을 Git으로
추적한다.

Release lock은 데이터 자체의 외부 백업을 대신하지 않는다. 다음 두 조건을 모두 만족해야
복구 가능한 정본으로 취급한다.

1. manifest에 기록된 파일을 공유 저장소·Git LFS·immutable archive 중 하나에 보관한다.
2. 새 환경에서 `npm run seed:verify-release`가 성공한다.

`release_status=BLOCKED_FOR_E2E`는 바이트 정본이 잠겼지만 의미 검수·Fact Coverage·Flow A
등 E2E 선행 조건이 남았다는 뜻이다. 이를 `READY_FOR_E2E`나 최종 Gold로 해석하지 않는다.

