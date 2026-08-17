// Turn M2 item 6B: WITHHELD -> DISCLOSED-only-change detection. Purely
// data-driven over already-VERIFIED Facts/Events -- never keyed on
// question_id, company name, or a hardcoded field (e.g. "counterparty").
// Any metric_code can trigger this: the SHAPE is what matters --
//   1. within the SAME real event chain (Fact.event_id -> the real
//      Event's own chain_id -- never invented) for the SAME company,
//   2. exactly one metric_code has a WITHHELD-then-DISCLOSED pair
//      (2 Facts, one each value_status), and
//   3. EVERY OTHER metric_code present in that same chain is UNCHANGED
//      across its own occurrences (a metric_code appearing only once in
//      the chain was never revised at all, and trivially counts as
//      unchanged).
// When all three hold, the only thing that happened is a prior
// confidentiality lift, not an actual contract-terms change -- a
// distinct, real Answerability nuance from a genuine amendment.
function chainKeyOf(fact, eventsById) {
  const event = fact.event_id ? eventsById.get(fact.event_id) : null;
  const chainId = event?.chain_id ?? null;
  if (!chainId || typeof fact.corp_code !== "string" || fact.corp_code === "") return null;
  return `${fact.corp_code}|${chainId}`;
}

export function detectWithheldToDisclosedOnlyChanges(facts, events) {
  const eventsById = new Map((events ?? []).map((event) => [event.event_id, event]));
  const byChain = new Map();
  for (const fact of facts ?? []) {
    const key = chainKeyOf(fact, eventsById);
    if (!key) continue;
    const list = byChain.get(key) ?? [];
    list.push(fact);
    byChain.set(key, list);
  }

  const results = [];
  for (const chainFacts of byChain.values()) {
    const byMetric = new Map();
    for (const fact of chainFacts) {
      const list = byMetric.get(fact.metric_code) ?? [];
      list.push(fact);
      byMetric.set(fact.metric_code, list);
    }
    for (const [metricCode, occurrences] of byMetric) {
      if (occurrences.length !== 2) continue;
      const withheld = occurrences.find((f) => f.value_status === "WITHHELD");
      const disclosed = occurrences.find((f) => f.value_status === "DISCLOSED");
      if (!withheld || !disclosed) continue;
      const otherMetricsUnchanged = [...byMetric.entries()]
        .filter(([code]) => code !== metricCode)
        .every(([, list]) => new Set(list.map((f) => JSON.stringify(f.normalized_value))).size <= 1);
      if (!otherMetricsUnchanged) continue;
      results.push({
        corp_code: disclosed.corp_code ?? null,
        metric_code: metricCode,
        raw_label: disclosed.raw_label ?? withheld.raw_label ?? null,
        withheld_fact_id: withheld.fact_id,
        disclosed_fact_id: disclosed.fact_id,
      });
    }
  }
  return results;
}
