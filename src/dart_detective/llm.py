"""LLM provider 추상화.

의미 판단이 필요한 곳(Evidence Agent의 자유질문 해석, Tutor의 힌트 문장)에서만 쓴다.
버튼으로 구분되는 행동에는 LLM을 부르지 않는다.

자격증명이 없으면 `get_llm()`이 None을 반환하고, 각 Agent는 결정론적 fallback으로
동작한다 — 데모가 네트워크/키 없이도 끝까지 돌아가야 하기 때문이다.
강제로 끄려면 환경변수 `DART_DETECTIVE_LLM=off`.

provider:
    clova      HyperCLOVA X (제출 요건상 **평가에 쓸 수 있는 유일한 provider**).
               `CLOVA_API_KEY`가 있으면 자동 선택된다.
    anthropic  개발 중 참고용. 평가 대상이 아니므로 기본값이 아니고,
               `DART_DETECTIVE_LLM_PROVIDER=anthropic`을 명시해야만 쓰인다.

모든 provider는 `LLMClient` 프로토콜(complete_json)만 만족하면 되고, Agent는
provider를 모른다 — 테스트는 FakeLLM을 주입한다.
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

# HyperCLOVA X. 모델/엔드포인트는 계정별로 다를 수 있어 환경변수로 덮어쓴다.
CLOVA_DEFAULT_MODEL = "HCX-005"
# 속도 제한(429)만 재시도한다. 재시도는 1회로 끝 — 실패해도 fallback이 답을 만든다.
RETRY_STATUS = 429
MAX_RETRIES = 1
RETRY_WAIT_SECONDS = 3.0
CLOVA_DEFAULT_ENDPOINT = "https://clovastudio.stream.ntruss.com/v3/chat-completions"
# Claude 모델 ID는 날짜 접미사 없이 그대로 쓴다. 평가용이 아니라 개발 참고용이다.
ANTHROPIC_DEFAULT_MODEL = "claude-opus-5"
DEFAULT_PROVIDER = "clova"


@dataclass
class LLMResult:
    data: dict[str, Any]
    provider: str
    model: str
    latency_ms: int
    raw_text: str = ""
    usage: dict[str, Any] = field(default_factory=dict)


class LLMUnavailable(RuntimeError):
    """호출 가능한 LLM이 없다."""


@runtime_checkable
class LLMClient(Protocol):
    """Agent가 아는 LLM의 전부. provider를 갈아끼워도 Agent는 바뀌지 않는다."""

    provider: str

    def complete_json(self, system: str, user: str,
                      schema: dict[str, Any], *,
                      max_tokens: int | None = None) -> "LLMResult":
        """max_tokens: 호출별 출력 상한(v4 §7 예산). None이면 클라이언트 기본값."""
        ...


class AnthropicLLM:
    """Anthropic Messages API + Structured Outputs.

    JSON 스키마를 `output_config.format`으로 강제하므로 파싱 실패를 걱정하지 않는다.
    """

    provider = "anthropic"

    def __init__(self, model: str = ANTHROPIC_DEFAULT_MODEL, effort: str = "low",
                 max_tokens: int = 4000):
        import anthropic  # 지연 import — 패키지가 없어도 rule-based 경로는 살아야 한다

        self._anthropic = anthropic
        self.client = anthropic.Anthropic()
        self.model = model
        self.effort = effort
        self.max_tokens = max_tokens

    def complete_json(self, system: str, user: str, schema: dict[str, Any], *,
                      max_tokens: int | None = None) -> LLMResult:
        t0 = time.perf_counter()
        response = self.client.messages.create(
            model=self.model,
            max_tokens=max_tokens or self.max_tokens,
            system=system,
            output_config={
                "effort": self.effort,
                "format": {"type": "json_schema", "schema": schema},
            },
            messages=[{"role": "user", "content": user}],
        )
        latency_ms = int((time.perf_counter() - t0) * 1000)

        if response.stop_reason == "refusal":
            raise LLMUnavailable("모델이 요청을 거절했다(stop_reason=refusal)")

        text = next((b.text for b in response.content if b.type == "text"), "")
        return LLMResult(
            data=json.loads(text),
            provider=self.provider,
            model=response.model,
            latency_ms=latency_ms,
            raw_text=text,
            usage={
                "input_tokens": response.usage.input_tokens,
                "output_tokens": response.usage.output_tokens,
            },
        )


def _balanced_objects(text: str) -> list[str]:
    """문자열 리터럴을 존중하면서 최상위 {...} 후보를 전부 찾는다.

    첫 `{`부터 마지막 `}`까지 통째로 자르면 오브젝트가 둘 이상일 때 둘을 하나로
    이어붙여 버린다 — 그러면 어느 쪽이 답인지 알 수 없다. 균형 잡힌 덩어리를
    따로 모아 두고, 개수 판단은 호출자가 한다.
    """
    out: list[str] = []
    depth = start = 0
    in_string = escaped = False
    for i, ch in enumerate(text):
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}" and depth:
            depth -= 1
            if depth == 0:
                out.append(text[start:i + 1])
    return out


def extract_json(text: str) -> dict[str, Any]:
    """모델 출력에서 JSON 오브젝트를 꺼낸다.

    HyperCLOVA X에는 Anthropic의 structured output 같은 스키마 강제가 없다. 그래서
    프롬프트로 JSON만 내라고 지시하고, 코드펜스나 앞뒤 설명이 섞여 나오는 경우까지
    여기서 걷어낸다. 그래도 못 읽으면 LLMUnavailable을 던져 Agent가 fallback한다.

    복구하는 것은 **포장이 잘못된 경우**뿐이다. 깨진 JSON을 의미로 고쳐 쓰거나,
    오브젝트가 여러 개일 때 하나를 임의로 고르는 일은 하지 않는다 — 그건 모델이
    틀린 것이고, 틀린 답을 통과시키는 것보다 fallback이 낫다.
    """
    text = (text or "").strip()
    fence = re.search(r"```(?:json)?\s*(.+?)```", text, re.S)
    if fence:
        text = fence.group(1).strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        pass
    else:
        if isinstance(data, dict):
            return data
        raise LLMUnavailable("JSON 오브젝트가 아니다")

    parsed: list[dict[str, Any]] = []
    last_error: json.JSONDecodeError | None = None
    for chunk in _balanced_objects(text):
        try:
            data = json.loads(chunk)
        except json.JSONDecodeError as exc:
            last_error = exc
            continue
        if isinstance(data, dict):
            parsed.append(data)
    if len(parsed) == 1:
        return parsed[0]
    if len(parsed) > 1:
        raise LLMUnavailable(f"JSON 오브젝트가 {len(parsed)}개 — 어느 것이 답인지 모호하다")
    if last_error is not None:
        raise LLMUnavailable(f"JSON 파싱 실패: {last_error}")
    raise LLMUnavailable("응답에서 JSON을 찾지 못했다")


class ClovaLLM:
    """HyperCLOVA X (CLOVA Studio chat-completions).

    표준 라이브러리 urllib만 쓴다 — 제출 환경에 새 의존성을 추가하지 않기 위해서다.
    스키마는 API가 강제해 주지 않으므로 프롬프트로 요구하고 `extract_json`으로 읽는다.
    """

    provider = "clova"

    def __init__(self, api_key: str | None = None, model: str | None = None,
                 endpoint: str | None = None, *, max_tokens: int = 2048,
                 temperature: float = 0.0, timeout: int = 60):
        self.api_key = api_key or os.environ.get("CLOVA_API_KEY", "")
        if not self.api_key:
            raise LLMUnavailable("CLOVA_API_KEY가 없다")
        self.model = model or os.environ.get("CLOVA_MODEL", CLOVA_DEFAULT_MODEL)
        self.endpoint = (endpoint or os.environ.get("CLOVA_ENDPOINT")
                         or CLOVA_DEFAULT_ENDPOINT).rstrip("/")
        self.max_tokens = max_tokens
        self.temperature = temperature
        self.timeout = timeout
        self.last_retries = 0          # 직전 _post에서 429로 다시 보낸 횟수(0 또는 1)

    @property
    def url(self) -> str:
        return f"{self.endpoint}/{self.model}"

    @staticmethod
    def _ssl_context():
        """macOS 프레임워크 Python은 시스템 CA를 못 찾아 SSL 검증이 실패한다(실측 2026-09-03).
        certifi가 있으면 그 CA 묶음을 쓴다 — 배포 서버에서도 동일하게 동작한다."""
        try:
            import ssl
            import certifi
            return ssl.create_default_context(cafile=certifi.where())
        except ImportError:
            return None

    def _post(self, payload: dict[str, Any]) -> dict[str, Any]:
        """한 번 보낸다. 429(속도 제한)일 때만 딱 한 번 더 보낸다.

        429는 모델이 틀린 게 아니라 우리가 너무 빨리 부른 것이므로 재시도가 정당하다.
        그 외 오류(4xx/5xx, 연결 실패)는 재시도하지 않는다 — 같은 요청을 다시 보내도
        같은 답이고, 호출 비용만 는다.
        """
        self.last_retries = 0
        attempt = 0
        while True:
            request = urllib.request.Request(
                self.url,
                data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "X-NCP-CLOVASTUDIO-REQUEST-ID": uuid.uuid4().hex,
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                method="POST",
            )
            try:
                with urllib.request.urlopen(request, timeout=self.timeout,
                                            context=self._ssl_context()) as response:
                    return json.loads(response.read().decode("utf-8"))
            except urllib.error.HTTPError as exc:  # 4xx/5xx는 fallback 대상이다
                if exc.code == RETRY_STATUS and attempt < MAX_RETRIES:
                    attempt += 1
                    self.last_retries = attempt
                    time.sleep(RETRY_WAIT_SECONDS)
                    continue
                try:
                    detail = exc.read().decode("utf-8", "replace")[:400]
                except Exception:  # noqa: BLE001
                    detail = ""
                raise LLMUnavailable(f"CLOVA HTTP {exc.code}: {detail}") from exc
            except urllib.error.URLError as exc:
                raise LLMUnavailable(f"CLOVA 연결 실패: {exc.reason}") from exc

    def complete_tool(self, system: str, user: str, tool: dict[str, Any], *,
                      max_tokens: int | None = None) -> LLMResult:
        """Native v3 Function Calling(v4 §12) — tool 스키마가 곧 검증 계약이다.

        모델이 toolCalls 대신 평문/JSON을 돌려주면 **계약 실패**다(LLM 문제로 분류, §12).
        content에서 JSON 복구를 시도하되, 그마저 없으면 LLMUnavailable을 던져
        호출자(qa_agent)의 폴백 경로로 보낸다. temperature·seed는 §12 고정값
        (env DART_QA_FC_TEMPERATURE/DART_QA_SEED로 덮어쓸 수 있다 — 실험 전용)."""
        requested = max_tokens or self.max_tokens
        t0 = time.perf_counter()
        # 실측(2026-09-03, 서비스앱): tools와 출력 길이 파라미터(maxTokens·maxCompletionTokens)는
        # 함께 보낼 수 없다(40001). temperature·seed는 호환. 출력 상한을 못 거니 FC 호출의 TPM
        # 소모는 응답 usage로만 확인한다 — v4 §7 예산의 max_tokens는 JSON 경로·수리 호출에만 적용.
        payload = {
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "tools": [{"type": "function", "function": tool}],
            "toolChoice": {"type": "function", "function": {"name": tool["name"]}},
            "temperature": float(os.environ.get("DART_QA_FC_TEMPERATURE", "0.1")),
            "seed": int(os.environ.get("DART_QA_SEED", "42")),
        }
        # 40009(간헐 "Unsupported function")는 여기서 재시도하지 않는다 — qa_agent가 즉시 JSON
        # 경로로 대체한다(2중 안전망). 재시도를 끼우면 문항당 최악 LLM 호출이 3회(FC→FC→JSON)가
        # 되어 서버 응답이 120초를 넘는 사례가 나왔다(리허설 실측: 재시도 3문항이 전부 이 꼴).
        # 60초 안팎을 넘는 무통신 응답은 중간 경로에서 끊길 위험이 있어 최악 시간을 줄이는 쪽을 택한다.
        fc_retried = False
        body = self._post(payload)
        latency_ms = int((time.perf_counter() - t0) * 1000)
        result = body.get("result") or {}
        message = result.get("message") or {}
        usage = dict(result.get("usage") or {})
        usage.setdefault("max_tokens_requested", requested)
        if fc_retried:
            usage["fc_40009_retried"] = True
        stop_reason = result.get("stopReason") or result.get("finishReason")
        if stop_reason:
            usage["stop_reason"] = stop_reason
            if stop_reason in {"length", "stop_before", "max_tokens"}:
                usage["truncated"] = True
        calls = message.get("toolCalls") or []
        data: dict[str, Any] | None = None
        raw_text = message.get("content") or ""
        for call in calls:
            fn = (call or {}).get("function") or {}
            if fn.get("name") != tool["name"]:
                continue
            args = fn.get("arguments")
            if isinstance(args, str):                      # 계정에 따라 문자열로 온다
                try:
                    args = json.loads(args)
                except json.JSONDecodeError:
                    continue
            if isinstance(args, dict):
                data = args
                raw_text = json.dumps(args, ensure_ascii=False)
                break
        if data is None:
            usage["fc_contract_failure"] = True            # §12: 계약 실패 = LLM 문제
            if raw_text:
                data = extract_json(raw_text)              # 복구 시도 — 실패 시 예외 → 폴백
            else:
                raise LLMUnavailable("CLOVA FC 계약 실패: toolCalls도 content도 없다")
        return LLMResult(data=data, provider=self.provider, model=self.model,
                         latency_ms=latency_ms, raw_text=raw_text, usage=usage)

    def complete_json(self, system: str, user: str,
                      schema: dict[str, Any], *,
                      max_tokens: int | None = None) -> LLMResult:
        # 호출별 상한(v4 §7 실행 매트릭스). TPM 한도는 입력 + maxTokens로 계산되므로
        # 질문 유형에 맞게 낮춰 주면 같은 한도로 더 많이 부를 수 있다.
        requested = max_tokens or self.max_tokens
        instruction = (
            f"{system}\n\n"
            "출력은 반드시 아래 JSON 스키마를 만족하는 JSON 오브젝트 하나여야 한다. "
            "설명 문장, 코드펜스, 주석을 붙이지 마라.\n"
            f"{json.dumps(schema, ensure_ascii=False)}"
        )
        t0 = time.perf_counter()
        body = self._post({
            "messages": [
                {"role": "system", "content": instruction},
                {"role": "user", "content": user},
            ],
            "maxTokens": requested,
            "temperature": self.temperature,
        })
        latency_ms = int((time.perf_counter() - t0) * 1000)
        result = body.get("result") or {}
        message = result.get("message") or {}
        text = message.get("content") or ""
        if not text:
            raise LLMUnavailable(f"CLOVA 응답이 비어 있다: {body.get('status')}")
        # usage 키 이름은 계정/모델에 따라 다를 수 있어 **그대로** 들고 간다.
        # 여기서 이름을 정규화하면 실제 청구 단위와 어긋날 수 있다.
        usage = dict(result.get("usage") or {})
        stop_reason = result.get("stopReason") or result.get("finishReason")
        if stop_reason:
            usage["stop_reason"] = stop_reason
        if stop_reason in {"length", "stop_before", "max_tokens"}:
            # 출력이 상한에서 잘렸다 — JSON이 깨져 파싱이 실패할 수 있다.
            usage["truncated"] = True
        usage.setdefault("max_tokens_requested", requested)
        return LLMResult(
            data=extract_json(text),
            provider=self.provider,
            model=self.model,
            latency_ms=latency_ms,
            raw_text=text,
            usage=usage,
        )


def _has_credentials() -> bool:
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        return True
    # `ant auth login`으로 저장된 프로파일이 있으면 SDK가 자동으로 집어간다.
    config_dir = os.environ.get("ANTHROPIC_CONFIG_DIR")
    candidates = [Path(config_dir)] if config_dir else [
        Path.home() / ".config" / "anthropic",
        Path(os.environ.get("APPDATA", "")) / "Anthropic" if os.environ.get("APPDATA") else None,
    ]
    for base in candidates:
        if base and (base / "credentials").exists():
            return True
    return False


def get_llm(model: str | None = None) -> LLMClient | None:
    """호출 가능한 LLM이 있으면 반환, 없으면 None(= 결정론적 fallback 사용).

    provider 선택 순서:
      1. `DART_DETECTIVE_LLM=off` 이면 무조건 None
      2. `DART_DETECTIVE_LLM_PROVIDER`가 지정돼 있으면 그 provider만 시도
      3. 아니면 CLOVA_API_KEY가 있을 때만 HyperCLOVA X
    Anthropic은 제출 요건상 평가 대상이 아니라 자동 선택되지 않는다.
    """
    if os.environ.get("DART_DETECTIVE_LLM", "").lower() in {"off", "0", "false"}:
        return None
    provider = (os.environ.get("DART_DETECTIVE_LLM_PROVIDER") or "").lower()
    if provider == "anthropic":
        if not _has_credentials():
            return None
        try:
            return AnthropicLLM(model=model or ANTHROPIC_DEFAULT_MODEL)
        except Exception:  # SDK 미설치, 클라이언트 생성 실패 등
            return None
    if provider and provider != DEFAULT_PROVIDER:
        return None
    try:
        return ClovaLLM(model=model)
    except LLMUnavailable:      # 키 없음 — 결정론적 경로로 간다
        return None
