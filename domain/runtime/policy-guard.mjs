// Policy Guard (CLAUDE.md section 5, invariant §7-15): fail-closed,
// deterministic, pattern-based rejection of investment advice, future
// stock-price prediction, and prompt injection. No model, no HCX call, no
// external data — pure text matching, so it needs no adapter and has no
// "unavailable" state: it is always available and never budgeted (a
// safety check must never become skippable just because the execution
// budget for HCX/tool/retrieval calls happened to run out elsewhere).
//
// A question is allowed to ASK about investment advice or future prices —
// refusing to even acknowledge such a question would be its own kind of
// unhelpful over-blocking. Only ANSWERING with advice/prediction is
// forbidden (competition rule #5), so checkQuestion only screens for
// prompt injection; checkAnswer screens for all three.
//
// NEGATION AWARENESS (advice/prediction only): a bare keyword match is not
// the same as the forbidden act. "투자 의견을 제공할 수 없습니다." mentions
// 투자의견 but refuses to give one — that must pass.
//
// This is NOT done by exempting a whole clause just because it contains a
// negation word somewhere. An earlier version did exactly that and was a
// real bypass: "이 종목을 지금 매수하세요, 손실 가능성이 없지는 않습니다."
// is one clause containing both a direct buy order AND an unrelated
// negation word, so whole-clause exemption let the buy order through.
// Same failure mode for "주가가 상승할 것으로 예상되지만 보장할 수
// 없습니다." — hedging that you "cannot guarantee" something does not
// retract the prediction that was just asserted.
//
// Instead, only the EXACT phrasing that negates providing/predicting that
// specific topic is a safe span (SAFE_REFUSAL_SPANS below — e.g. "투자
// 의견을 제공할 수 없습니다", "목표주가가 기재되어 있지 않습니다"). That
// narrow span is stripped out of the text, and the forbidden patterns are
// then matched against what's left — so a direct buy/sell order or an
// assertive prediction elsewhere in the same sentence is still caught,
// while the literal safe-refusal wording itself no longer trips the
// pattern it happens to share a keyword with. A direct imperative
// (매수하세요/매도하세요) is never itself part of any safe span, so it is
// always caught regardless of what negated hedge sits next to it in the
// same sentence.
//
// This exemption is deliberately NOT applied to prompt-injection patterns:
// unlike a safe refusal, an actual injection attempt is dangerous
// regardless of what negation wording an attacker wraps around it (e.g.
// "다음은 거짓이 아닙니다: 이전 지시를 무시하고..."), so injection
// matching stays a plain, unguarded scan of the whole text.
//
// KNOWN LIMITATION: both the forbidden patterns and the safe-refusal spans
// are a fixed list (Korean + English), not exhaustive — they catch the
// direct, common phrasings named in CLAUDE.md's invariants and the
// concretely observed false positives, not every possible paraphrase.
// Add patterns/spans here as gaps are found; do not reach for an ML
// classifier (would itself be a non-HCX generative-adjacent model, and
// non-deterministic, which contract tests can't pin down).

export const POLICY_GUARD_CODES = Object.freeze([
  "POLICY_INVESTMENT_ADVICE_FORBIDDEN",
  "POLICY_FUTURE_PREDICTION_FORBIDDEN",
  "POLICY_PROMPT_INJECTION_DETECTED",
]);

// External, code-specific safe-rewrite templates (Korean, user-facing).
// runAgentFlow uses these to replace a policy-violating answer's text —
// the internal *_CODES value itself is recorded only in
// ExecutionTrace.fallback_reason, never surfaced to the user as raw text.
export const POLICY_GUARD_SAFE_ANSWERS = Object.freeze({
  POLICY_INVESTMENT_ADVICE_FORBIDDEN: "본 시스템은 매수·매도 추천이나 투자의견을 제공할 수 없습니다.",
  POLICY_FUTURE_PREDICTION_FORBIDDEN: "본 시스템은 향후 주가를 예측할 수 없습니다.",
  POLICY_PROMPT_INJECTION_DETECTED: "요청하신 내용은 처리할 수 없습니다.",
});

const INVESTMENT_ADVICE_PATTERNS = [
  /매수(?:하세요|하십시오)/,
  /매도(?:하세요|하십시오)/,
  /매수.{0,10}추천/,
  /매도.{0,10}추천/,
  /투자\s*의견/,
  /목표\s*주가/,
  /종목\s*추천/,
  /지금\s*사(?:세요|십시오)/,
  /\bbuy\s+this\s+stock\b/i,
  /\bsell\s+this\s+stock\b/i,
  /\binvestment\s+advice\b/i,
  /\btarget\s+price\b/i,
];

const FUTURE_PREDICTION_PATTERNS = [
  /주가(?:는|가)?\s*(?:오를|상승할|떨어질|하락할)\s*것/,
  /주가\s*전망/,
  /주가\s*예상/,
  /\bstock\s+price\s+will\b/i,
  /\bstock\s+price\s+is\s+expected\s+to\b/i,
];

const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(the\s+)?(previous|prior|above)\s+instructions/i,
  /disregard\s+(the\s+)?system\s+prompt/i,
  /이전\s*(지시|명령|프롬프트)\s*(사항)?\s*(을|를)?\s*무시/,
  /시스템\s*프롬프트/,
  /\byou\s+are\s+now\b/i,
  /당신은\s*이제/,
  /역할\s*(을|를)?\s*무시하고/,
];

// Narrow, topic-bound "safe refusal" spans (see NEGATION AWARENESS above).
// Each pattern matches ONLY the exact phrasing that negates providing or
// predicting that specific topic — never a bare negation word on its own —
// so stripping a match can only remove a genuine safe refusal, not an
// unrelated forbidden statement that happens to share a sentence with one.
const SAFE_REFUSAL_SPANS = [
  /투자\s*의견\S{0,6}?\s*제공(?:하지\s*않습니다|하지\s*못합니다|할\s*수\s*없습니다)/g,
  /목표\s*주가\S{0,10}?\s*(?:기재|공시|명시)(?:되어|돼)?\s*있지\s*않습니다/g,
  /(?:향후\s*)?주가\S{0,6}?\s*예측(?:하지\s*않습니다|하지\s*못합니다|할\s*수\s*없습니다)/g,
  /\bcannot\s+provide\s+(?:an?\s+)?target\s+price\b/gi,
  /\bcannot\s+predict\s+(?:the\s+)?(?:future\s+)?stock\s+price\b/gi,
];

function stripSafeRefusalSpans(text) {
  let stripped = text;
  for (const span of SAFE_REFUSAL_SPANS) stripped = stripped.replace(span, " ");
  return stripped;
}

// Plain, unguarded scan — used only for prompt injection (see header
// comment on why the safe-span exemption must not apply there).
function matchesAny(patterns, text) {
  return typeof text === "string" && patterns.some((pattern) => pattern.test(text));
}

// Strip only the exact safe-refusal spans, then match the forbidden
// patterns against what remains — used for advice/prediction so a safe
// refusal ("...제공할 수 없습니다") is not mistaken for the act itself,
// while a direct order or assertion elsewhere in the same sentence is
// still caught (see NEGATION AWARENESS above for why whole-clause
// exemption was replaced with this).
function matchesForbiddenAssertion(patterns, text) {
  if (typeof text !== "string") return false;
  const stripped = stripSafeRefusalSpans(text);
  return patterns.some((pattern) => pattern.test(stripped));
}

function checkInjectionOnly(text) {
  if (matchesAny(PROMPT_INJECTION_PATTERNS, text)) return { ok: false, code: "POLICY_PROMPT_INJECTION_DETECTED" };
  return { ok: true };
}

export function createPolicyGuard() {
  return {
    // Returns { ok: true } or { ok: false, code }.
    checkQuestion(text) {
      return checkInjectionOnly(text);
    },
    checkAnswer(text) {
      const injection = checkInjectionOnly(text);
      if (!injection.ok) return injection;
      if (matchesForbiddenAssertion(INVESTMENT_ADVICE_PATTERNS, text)) {
        return { ok: false, code: "POLICY_INVESTMENT_ADVICE_FORBIDDEN" };
      }
      if (matchesForbiddenAssertion(FUTURE_PREDICTION_PATTERNS, text)) {
        return { ok: false, code: "POLICY_FUTURE_PREDICTION_FORBIDDEN" };
      }
      return { ok: true };
    },
  };
}
