#!/usr/bin/env python3
"""최소 배포 가능성 프로브 — vFINAL 19번 그대로.

배포된 서버가 "진짜"인지 기계적으로 검사한다:
  1. /ready 통과
  2. 설정 지문(pins)이 frozen pin 파일과 일치
  3. mock/fake/fallback 모드 아님 (readiness.mode == "real")
  4. 고정 synthetic probe로 /answer 계약 통과 (5필드 전부 문자열 · echo 일치)
  5. 응답·헤더에 secret 비노출
  6. retrieved_context의 locator가 해석 가능

사용:
    python scripts/deploy_probe.py http://<공인IP>                # 검사만
    python scripts/deploy_probe.py http://<공인IP> --pins pins.json  # pin 대조 포함
    python scripts/deploy_probe.py http://<공인IP> --allow-skeleton  # 스켈레톤 단계용(3번 완화)

종료 코드 0 = 전부 통과. 실패 항목은 줄 단위로 출력.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.parse
import urllib.request

SYNTHETIC = [
    ("probe-echo-1", "프로브 질문입니다. 그대로 처리해 주세요."),
    ("probe-echo-2", "HMM의 2023년 공급계약 금액은 얼마인가?"),
]
WIRE_KEYS = ("question_id", "question", "retrieved_context", "think_trace", "answer")
SECRET_RE = re.compile(r"(nv-[A-Za-z0-9]{20,}|CLOVA_API_KEY|api[_-]?key\s*[:=]\s*\S{8,})",
                       re.IGNORECASE)
LOCATOR_RE = re.compile(r"([a-z]+_\d{14})/(\d{14})\.xml#node=(\d+)")


def get(base: str, path: str, params: dict | None = None, timeout: float = 60.0):
    url = base.rstrip("/") + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=timeout) as r:  # noqa: S310 — 팀 서버 주소
        return r.status, r.read().decode("utf-8"), dict(r.headers)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("base", help="예: http://1.2.3.4")
    ap.add_argument("--pins", help="frozen pin JSON 파일 — readiness().pins와 대조")
    ap.add_argument("--allow-skeleton", action="store_true",
                    help="스켈레톤 단계: mode=real 요구를 건너뛴다")
    args = ap.parse_args()
    fails: list[str] = []
    ok = lambda name: print(f"PASS {name}")  # noqa: E731
    bad = lambda name, why: (print(f"FAIL {name}: {why}"), fails.append(name))  # noqa: E731

    # 1·2·3 — /ready + pins + mode
    try:
        status, body, _ = get(args.base, "/ready")
        ready = json.loads(body)
        if status == 200 and ready.get("ready"):
            ok("ready")
        else:
            bad("ready", f"status={status} body={body[:120]}")
        if args.pins:
            frozen = json.load(open(args.pins, encoding="utf-8"))
            if ready.get("pins") == frozen:
                ok("pins-match")
            else:
                bad("pins-match", f"server={ready.get('pins')} frozen={frozen}")
        if ready.get("mode") == "real":
            ok("mode-real")
        elif args.allow_skeleton:
            print(f"SKIP mode-real (스켈레톤 단계, mode={ready.get('mode')})")
        else:
            bad("mode-real", f"mode={ready.get('mode')} — mock/degraded 배포 금지")
    except Exception as exc:  # noqa: BLE001
        bad("ready", f"{type(exc).__name__}: {exc}")

    # 4·5·6 — synthetic /answer
    for qid, question in SYNTHETIC:
        name = f"answer[{qid}]"
        try:
            status, body, headers = get(args.base, "/answer",
                                        {"question_id": qid, "question": question})
            if status != 200:
                bad(name, f"status={status}")
                continue
            data = json.loads(body)
            if set(data) != set(WIRE_KEYS):
                bad(name, f"필드 불일치: {sorted(data)}")
                continue
            if not all(isinstance(v, str) for v in data.values()):
                bad(name, "문자열이 아닌 필드 존재")
                continue
            if data["question_id"] != qid or data["question"] != question:
                bad(name, "echo 불일치")
                continue
            blob = body + json.dumps(headers, ensure_ascii=False)
            if SECRET_RE.search(blob):
                bad(name, "응답에 secret 패턴 노출")
                continue
            ok(name)
            for m in LOCATOR_RE.finditer(data["retrieved_context"]):
                if m.group(1).split("_", 1)[1] != m.group(2):
                    bad("locator", f"doc_id와 접수번호 불일치: {m.group(0)}")
                    break
            else:
                if LOCATOR_RE.search(data["retrieved_context"]):
                    ok("locator")
        except Exception as exc:  # noqa: BLE001
            bad(name, f"{type(exc).__name__}: {exc}")

    # 잘못된 파라미터는 400이어야 한다
    try:
        status, _, _ = get(args.base, "/answer", {"question_id": "x"})
        (ok if status == 400 else lambda n: bad(n, f"status={status}"))("param-400")
    except urllib.error.HTTPError as e:  # noqa: F821 — urllib.error는 urllib.request가 로드
        (ok if e.code == 400 else lambda n: bad(n, f"status={e.code}"))("param-400")

    print("\n결과:", "전부 통과" if not fails else f"실패 {len(fails)}건 {fails}")
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
