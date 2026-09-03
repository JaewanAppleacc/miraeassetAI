# 배포 절차 — NCP 서버에 스켈레톤 띄우기 (콘솔 담당자용)

콘솔에서 서버(Ubuntu 22.04) + 공인 IP + ACG(TCP 22, 80 인바운드)까지 만든 다음,
서버에 SSH로 접속해 아래를 순서대로 붙여넣으면 끝. 약 5분.

## 1. 코드·의존성

```bash
sudo apt-get update && sudo apt-get install -y python3-pip python3-venv git
git clone -b qa/dart-qa-standalone https://github.com/jiyoung04lee/demo_ai_fesfival.git dart-qa
cd dart-qa
python3 -m venv .venv
.venv/bin/pip install fastapi "uvicorn[standard]" pydantic
```

## 2. 동작 확인 (포그라운드)

```bash
PYTHONPATH=src PYTHONIOENCODING=utf-8 \
  .venv/bin/uvicorn dart_detective.ops_service:app --host 0.0.0.0 --port 80 --workers 1
```

다른 창(또는 본인 노트북)에서:

```bash
curl "http://<공인IP>/health"     # {"status":"ok"}
curl "http://<공인IP>/ready"      # ready:true (스켈레톤 모드)
curl "http://<공인IP>/answer?question_id=t1&question=%ED%85%8C%EC%8A%A4%ED%8A%B8"
# → question_id/question/retrieved_context/think_trace/answer 5개 문자열 JSON
```

포트 80은 root 권한이 필요하다. 위 명령이 권한 오류면 `sudo -E` 를 앞에 붙이거나
아래 systemd(3번)로 바로 간다.

## 3. 자동 재기동 (crash 대응 — 운영 계약 항목)

```bash
sudo tee /etc/systemd/system/dart-qa.service > /dev/null <<'UNIT'
[Unit]
Description=DART QA answer server
After=network.target

[Service]
User=root
WorkingDirectory=/home/ubuntu/dart-qa
Environment=PYTHONPATH=/home/ubuntu/dart-qa/src
Environment=PYTHONIOENCODING=utf-8
Environment=DART_QA_DEADLINE_S=290
Environment=DART_QA_CACHE_DIR=/home/ubuntu/dart-qa/.cache
ExecStart=/home/ubuntu/dart-qa/.venv/bin/uvicorn dart_detective.ops_service:app --host 0.0.0.0 --port 80 --workers 1
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now dart-qa
systemctl status dart-qa --no-pager | head -5
```

경로가 다르면(`/home/ubuntu`가 아니면) WorkingDirectory·Environment·ExecStart 세 줄만 바꾼다.
죽여도 3초 안에 살아나는지 확인: `sudo systemctl kill dart-qa && sleep 4 && curl -s localhost/health`.

## 4. 나중에 실물 엔진 연결될 때 (지금 아님)

에이전트 층이 `src/dart_detective/answer_api.py`를 만들면, 서버에서
`git pull && sudo systemctl restart dart-qa` 만 하면 된다 — ops_service는 자동으로
실물에 연결된다. 그때는 `.env`(CLOVA 키)와 데이터 파일(`DART_QA_*` 환경변수)도
systemd Environment에 추가한다. **키는 절대 커밋하지 않는다.**

## 5. 로그 보기

```bash
journalctl -u dart-qa -f       # 실시간
```
질문 원문과 API 키는 로그에 남지 않는다(길이·캐시 여부·소요시간만).
