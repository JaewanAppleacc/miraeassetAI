# Thin Flow A v0.3 / Seed v0.15 independent review handoff

## Review objective

Confirm that the Seed Thin Flow proves the trusted Runtime/API wiring without
loading Gold answers or pretending that deterministic listing is a complete
answer generator.

## Files in scope

- `domain/flows/thin-structured-flow.mjs`
- `domain/runtime/seed-thin-runner.mjs`
- `domain/adapters/seed-question-plan-store.mjs`
- `domain/adapters/seed-runtime-service-adapters.mjs`
- `domain/adapters/seed-structured-query-adapter.mjs`
- `scripts/build-seed-thin-flow-plans.mjs`
- `app/answer/route.ts`
- `app/ready/route.ts`
- matching `tests/seed-*.test.mjs`

## Required trust-boundary checks

1. Runtime plan JSONL contains no `expected_answer`, `scoring_spec`, or
   `required_evidence_slots` material.
2. A plan is selected only when both `question_id` and the exact question
   SHA-256 match. Swapping either must return `EARLY_EXIT` without facts.
3. Q3 and Q22 are present in the pinned v0.3 plan/Coverage/Fact/Evidence set,
   return `STRUCTURED` through the real GET route, and do not reuse an
   Evidence identity across different table cells. Q22 must expose the full
   15-document correction history and preserve the distinction between the
   DART-declared reference and the effective predecessor.
4. Every returned Evidence is revalidated through EvidenceStore,
   DocumentStore, locator, verbatim quote, and quote hash before appearing in
   `selected_evidence`.
5. Fact/Event/Relation/Evidence and plan manifests are hash/snapshot pinned;
   missing roles or cross-snapshot combinations fail closed.
6. The API emits exactly the organizer's five string fields and never leaks
   the internal `execution_trace`.
7. Unknown questions and missing deployment artifacts use the honest no-flow
   fallback; they must never broaden into a corpus-wide query.
8. `/ready` must be 200 only after the exact artifact bundle used by `/answer`
   has initialized. It must return a stable safe code, never a path or stack.
9. Calculator-derived values must be backed by a request-scoped Validator
   proof. Facts with different unit, scope, or scale must not be compared.
   For unit comparison only, the closed aliases `KRW`/`원`,
   `PERCENT`/`%`, and `SHARES`/`주` denote the same unit. The Calculator
   never rewrites `CalculationRequest.inputs`, the proof subject, or the
   `CalculationResult.inputs`; unknown or cross-dimension unit pairs remain
   `UNIT_MISMATCH`. This is a backward-compatible acceptance expansion at
   validation time only: it does not add a formula, change arity, alter the
   `CalculationResult` shape, or introduce a derived-value capability.

## Commands

```bash
npm run seed:promote-structured-artifacts
npm run seed:build-thin-flow-plans
npm run seed:review-fact-normalization-v02
npm run seed:promote-fact-normalization-v02
npm run seed:build-thin-flow-plans-v02
npm run seed:build-q3-q22-v015
npm run seed:build-thin-flow-plans-v03
npm run seed:audit-runtime-v02-release
node --test tests/seed-structured-query-adapter.test.mjs \
  tests/seed-runtime-service-adapters.test.mjs \
  tests/seed-thin-flow.test.mjs \
  tests/seed-answer-api-e2e.test.mjs
npm run verify:contracts
npm run build
git diff --check
```

## Known limitations (must not be reported as completed)

- The 25-question API E2E currently proves transport, snapshot binding,
  trusted lookup, citation validation, and safe serialization.
- Q3 now uses four cell-qualified locators for the before/after count and
  ratio, and explicitly answers `변화 없음`. Q22 now uses the 15-document
  correction history and reports the latest effective terms. Both remain
  subject to the same Harness answer-quality metrics as the other 23.
- This is a wiring/grounding baseline, not a release score. Transport success
  does not override metric failures, `NOT_SCORED`, or `REVIEW_REQUIRED`.
- It does **not** yet prove final answer accuracy. The Flow exposes verified
  raw values and a small set of same-scale Calculator results, but still lacks
  complete question-specific recipes, ranking, and multi-event narrative
  synthesis.
- Unknown/private evaluation questions still intentionally `EARLY_EXIT`; general
  Company Resolver, Retriever, and HCX answer generation are not connected.
- The ignored `work/domain-seed` artifacts must be packaged immutably for a
  real deployment. A build succeeding on the developer machine is not proof
  those files exist on the public server. `SEED_RUNTIME_ROOT` and the four
  `SEED_*_PATH` overrides permit a mounted immutable bundle, but packaging and
  public-server verification remain release tasks.
- `/health` remains liveness-only. `/ready` is the artifact-aware readiness
  endpoint and must be used by deployment checks.
- Sixteen periodic Facts have an owner-directed canonical review and a v0.2
  normalization revision. Canonical KRW arithmetic is now proof-bound while
  the exact table-disclosed value and scale remain in migration provenance.
  No human second reviewer participated; that limitation is explicit in the
  decision/audit artifacts and must not be relabeled as dual human review.
- The configured application runtime now targets the v0.15/v0.3 artifact set,
  but the release remains DRAFT until the relevant source and immutable
  artifacts are packaged, committed, and the Harness is rerun against that
  exact Git SHA. A dirty-tree E2E cannot promote a release.
- The current artifact-backed submission server is Node (`npm run
  start:agent`). Vinext/Cloudflare Workers have no local filesystem for the
  large immutable Seed bundle; using the Worker route without moving those
  artifacts to an object store remains unsupported and must fail readiness.
