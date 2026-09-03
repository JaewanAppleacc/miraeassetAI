# 배포 절차 — NCP 서버에 스켈레톤 띄우기 (콘솔 담당자용)

콘솔에서 서버(Ubuntu 22.04) + 공인 IP + ACG(TCP 22, 80 인바운드)까지 만든 다음,
서버에 SSH로 접속해 아래를 순서대로 붙여넣으면 끝. 약 5분.

## 1. 코드·의존성

```bash
sudo apt-get update && sudo apt-get install -y python3-pip python3-venv git
git clone -b share/dart-qa-handoff https://github.com/jiyoung04lee/demo_ai_fesfival.git dart-qa
cd dart-qa
python3 -m venv .venv
.venv/bin/pip install fastapi "uvicorn[standard]" pydantic certifi numpy
```

정본 브랜치는 `share/dart-qa-handoff`다(standalone은 뒤처짐). certifi는 CLOVA HTTPS
인증서 검증용 — 코드가 certifi CA를 쓰도록 되어 있어 빠지면 실 호출이 실패할 수 있다.

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
**주의: 코드는 `.env`를 자동으로 읽지 않는다.** 실물 엔진(CLOVA 키·데이터 경로)을 붙일 때는
`[Service]`에 `EnvironmentFile=/home/ubuntu/dart-qa/.env` 한 줄을 추가한다(스켈레톤 단계엔 불필요).
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

## 데이터·스펙 (에이전트 층 확인 — 2026-09-03 밤)

### 서버 스펙 권장
- **Ubuntu 22.04 · 2vCPU · RAM 8GB · 디스크 50GB** (크레딧 20만원 내에서 여유).
- 실측 근거: D arm 서빙 peak RSS 1.24GB(101문항 E2E). RAM 4GB도 돌지만 캐시·여유분으로 8GB 권장.
  잠정 승자 D는 KURE(임베딩 모델)를 안 쓰므로 GPU·대용량 RAM 불필요. (B로 뒤집히면 +2.5GB RAM.)
- 디스크 내역: DocumentIR 8GB + 색인 23MB + venv ~1.2GB + 코드/로그.

### DocumentIR 8GB 올리기 (재파싱 금지 — 로컬 산출물 그대로)
로컬에 압축본이 이미 있다(`~/Desktop/document_ir.zip`, 649MB). 서버에서:
```bash
# 로컬에서: scp ~/Desktop/document_ir.zip ubuntu@<IP>:~/
unzip ~/document_ir.zip -d ~/document_ir            # → ~/document_ir/{exchange,holding,major,periodic}.jsonl
cd ~/dart-qa
DART_QA_DOCUMENT_IR_DIR=~/document_ir PYTHONIOENCODING=utf-8 .venv/bin/python scripts/build_index.py
# 133초. 출력의 파일별 SHA-256이 data/index/index_manifest.json 기대값과 같은지 확인:
#   exchange 80000c1c… · holding fd88d83c… · major 5c58da7a… · periodic 0aee5463…
```
systemd/실행 환경변수에 `DART_QA_DOCUMENT_IR_DIR=/home/ubuntu/document_ir` 추가.

### 주최측 발신 IP
2026-09-02 공지 스냅샷 기준 "**주최측 발신 IP 대역은 추후 공지 예정**"(docs/CONTEXT.md). 공지 전까지는
80 전체 오픈으로 가고, 대역이 공지되면 리허설 때 ACG를 조인다 — 평가 당일 차단이 최악이라는 판단에 동의.
