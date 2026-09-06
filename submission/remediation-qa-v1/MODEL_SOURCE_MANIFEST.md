# Model Source Manifest — ARM_A4_A3_REMEDIATION_LIVE

## Source

```
repository (dev): origin=github.com/JaewanAppleacc/miraeassetAI, demo-ai-festival=github.com/jiyoung04lee/demo_ai_fesfival
branch:  codex/a4-a3-remediation-integration-v01
commit:  b5f9443f7ca3ec2d57c2d17453070ab23c4a6341
```

Verified identical (`git ls-remote`) on both remotes at packaging time (2026-09-06).
A later commit on the same branch, `16289e2a516da98d9badec01a63a2da698157b53`
("docs: ARM_A4_A3_LIVE vs ARM_A4_A3_REMEDIATION_LIVE full QA(HCX) comparison"), adds only
`docs/reports/A4_A3_QA_HCX_COMPARISON_V1.md` — the comparison report that selected this
model. That file is evaluation output and is intentionally **not** part of this package;
this manifest pins the runtime source commit that precedes it.

## 런타임 파일 — 패키지 사본의 git blob SHA-1

아래 파일들은 위 커밋에서 복사한 뒤, 제출용 주석 정리(주석 한국어화·내부 작업 흔적
제거)만 적용했다. 동작 코드는 수정하지 않았다. 해시는 이 패키지에 실제 들어 있는 사본의
git blob SHA-1(`git hash-object`)이며, SHA256SUMS는 같은 사본에 대한 알고리즘이 다른
독립 교차검증이다.

```
e69de29bb2d1d6434b8b29ae775ad8c2e48c5391  src/dart_corpus/__init__.py
fa72873b789f61107aa14538f631eddc8bb9230e  src/dart_corpus/retrieval/__init__.py
85360b782c56f7517eb0dd23b138de823e1a6343  src/dart_corpus/retrieval/chunk_index.py
7a8868fd163c1b36b531b9d4a3234ac46e875c43  src/dart_corpus/retrieval/conditions.py
3e8591130447ff646faaad6f31b68e7ce8ace0c3  src/dart_corpus/retrieval/corp_dictionary.py
0f611bdc6109762d0a9d2478369e2ad43275e56d  src/dart_corpus/retrieval/lexical.py
96fa7ede9a81d3191124ee4f2320a5ce43bebf0e  src/dart_corpus/retrieval/node_store.py
70d7eaeffc095fe36869e3a8913a3188fa6c7dd2  src/dart_corpus/retrieval/segments.py
c541e55facf4c6a17e7b582adf39141869fc82d2  src/dart_detective/__init__.py
74c28b4933449b45defe92e13760551814401a9e  src/dart_detective/agents/__init__.py
b8ec0cd4c74524871058a658652b6724820d558d  src/dart_detective/agents/calculator.py
568c979b00b00efd98cb7a9b366c878c309fe1a6  src/dart_detective/agents/confidence.py
04276ad1d358a56e67004ac1ab72a53e1a6839cf  src/dart_detective/agents/qa_agent.py
dc4727ed1ba4f3131d9394b157dfe14eb76846bf  src/dart_detective/agents/tables.py
20509d60cd2586824a884cf904fd9e1ea6d54654  src/dart_detective/agents/validator.py
4bcdbcb94a98b51b9ee68106aa8dc4af2807afa3  src/dart_detective/answer_api.py
9689bbf8af5c11bc4444b194851aeee67d2ea5b7  src/dart_detective/answer_wire.py
812248d062b15e9b9b9924c4a09db4e09d787db3  src/dart_detective/arm_a4_a3_live_adapter.py
e23634d25d916bb0b690e1fff4b634af988a35dc  src/dart_detective/arm_a4_a3_live_worker_client.py
09568fdcfaa15439d363f491cb1239a66b143fa8  src/dart_detective/arm_a4_a3_remediation_live_adapter.py
4dbe917969d128a95a447a569db7ea2407d2dcdf  src/dart_detective/arm_a4_a3_remediation_live_worker_client.py
1b81f37b5eafeb6337877094d69f47235cda8467  src/dart_detective/arm_a_adapter.py
baaf1787c844f94a38ab1915802ba3b7b9cc473a  src/dart_detective/arm_a_live_adapter.py
d2348c0be1a8adbc8ee499c12913f7b0534700b0  src/dart_detective/arm_a_live_worker_client.py
1199d007c22fd8983e8e2b7c6a12d15aeeaa3251  src/dart_detective/arm_a_serving_bridge.py
a370de16b104c54537a1891f7442b591b4f4aa76  src/dart_detective/corpus_retriever.py
1471e845b3b5dc7132bf443736bc17c48c28f55c  src/dart_detective/fallback.py
e69dcc02c1b45724d114f88c53257fe5050a7599  src/dart_detective/grounded_answer.py
0e78565a4518f658c4279234d7bb68c99b47683c  src/dart_detective/llm.py
8019667d3717e469e06cef9d8d004f80406254f0  src/dart_detective/ops_service.py
d2d1b69e996803601ecca01618c09d55dc83da17  src/dart_detective/policy_gate.py
0d213fd78dc72c7a06e08d549c131316380dd08b  src/dart_detective/retriever_adapter.py
d1a66506523153a1e60ccb2599fbe28d54941f92  src/dart_detective/routing.py
35bcd3d0c8536fa92ad3ead896c4888657aa1023  scripts/arm_a4_a3_remediation_live_worker.mjs
eabcc82822ec3f6fc74937b2590d6af46f370f57  domain/agent-comparison/chunking-comparison/bm25.mjs
46d7e7ccb769331fd1b80f15c14c085fabf1d8c4  domain/agent-comparison/chunking-comparison/rrf.mjs
601c0470b1e40d6e01932c776b13008e75ecb815  domain/agent-comparison/four-arm-ac/a3-evidence-contradiction-guard.mjs
b96e9a21eaafe6d2efd8e584f04432f2a6ea6ad8  domain/agent-comparison/four-arm-ac/a4-a3-remediation-candidate-legs.mjs
61c8e204ca5641b2ac4a12b646d14a6fe1f8c6c5  domain/agent-comparison/four-arm-ac/a4-a3-remediation-retrieval-pipeline.mjs
7e8fc1bc9aba6edd4dd2669ec1fe2809a56788fd  domain/agent-comparison/four-arm-ac/a4-a3-retrieval-pipeline.mjs
ded8ac0535f2958fb1357b336f0348a32dada03a  domain/agent-comparison/four-arm-ac/a4-reranker-configs.v1.json
1e5fa04e6e34f6cc4ec5d65892d1651e2af186da  domain/agent-comparison/four-arm-ac/a4-reranker-engine.mjs
fcb5c5e167788e9ef97068b9fe62f0f7061f53e5  domain/agent-comparison/four-arm-ac/a4-reranker-features.mjs
38d8fbf9163c71e10ebe4faed568dc38b5cd0e10  domain/agent-comparison/four-arm-ac/a4-wide-candidate-pool.mjs
bd57d2b7d0cca3bd5aa515d012b58c2e3224761f  domain/agent-comparison/four-arm-ac/arm-retriever-adapter.mjs
6137513a0801d7412dd541fd27923ed00c743424  domain/agent-comparison/four-arm-ac/conditions-fixture.mjs
c1edb64c7fd2203344595b1244f47327bed86e00  domain/agent-comparison/four-arm-ac/four-arm-conditions-to-filter-mapper.mjs
109df5350e5cb64ca4605b51121dd15c343d43c1  domain/agent-comparison/four-arm-ac/four-arm-retrieval-policy.mjs
2e7fc350dd9465cca837b96b12cde8fa5423a407  domain/agent-comparison/four-arm-ac/locator-provenance.mjs
01dcc328ef845be79519ce883a5c87c4f2975cc6  domain/agent-comparison/four-arm-ac/qa-condition-mapper.mjs
4ffafcb3534231c0c03f93a5d09be69ce66dadf6  domain/agent-comparison/retrieval/contracts.mjs
2bea635b57e6f7d6e85c2f2dd063b9b698236168  domain/agent-comparison/retrieval/embedding-adapter.mjs
65a1d81a988c16587dfac5dda4db4e942241e25f  domain/agent-comparison/retrieval/fake-deterministic-embedding-adapter.mjs
f6f9c5aeb7dfc074d434d46118b0f6a9ab1bd809  domain/agent-comparison/retrieval/fixed-kure-bm25-index.mjs
682173ee8af6e1ff79369ff47610fbb7fa140f04  domain/agent-comparison/retrieval/fixed-kure-hybrid-retriever-adapter.mjs
496fb4d6ad7e743d6e27b1080aabe88d8411a820  domain/chunking/chunker.mjs
08d111d697b6e87ba5cb0fa66c567a6f0c5fa9cc  domain/contracts.mjs
b0985ae9182b239e8125c676d289108c8e52cdff  domain/postgres/reference-vector-retrieval-repository.mjs
79f2f9a8a4aef99def075a9731246fe71ab8d41f  domain/retrieval/metadata-filter.mjs
052fae8223b5c7199fc86982f5425aa8bae4bdcc  domain/runtime/abortable.mjs
1d643168e6997580fc8b54fae35bc35505c01428  package.json
fb9377e22581be42845ad5759f933167e06adac6  package-lock.json
6ddd97dad040f27dbb2026937cf85b8f9eeb43aa  data/corpus/manifest.jsonl
5f7bbebcb95c8607286e9a32fefa8b6512892cf7  data/corpus/universe.csv
eee9cb7bf2e807726d9cfbea028c257da417420c  data/corpus/corp_aliases.v1.json
de3d2cfe68dbf968d0c8ee0d7625791f800c057c  scripts/build_index.py
02f1ed20fb31d6a3d63e9fc78cfb617d758eb989  scripts/deploy_probe.py
0d76160329bee605b8edfef234e754b84310f17b  scripts/qa_preflight.py
```

## Files authored for this package (not from the dev repo)

These four files did not exist in the dev repo at b5f9443f. They contain no retrieval,
reranking, guard, remediation, or QA logic of their own — only environment
documentation and a thin composition script that calls two already-public functions
(`build_arm_a4_a3_remediation_live_serving_retriever()`, `answer_api.reset()`) to select
the default backend. See README.md "Known limitations" for why `run_server.py` exists.

- `README.md`
- `requirements.txt`
- `.env.example`
- `scripts/run_server.py`

## Excluded by design

Gold/DEV_TUNE/DEV_CHECK/HOLDOUT data, `results/`, `work/`, `check/`, `config/`
(judge/final-v1 summaries), `data/eval/`, `data/artifacts/`, test files and test-only
dependencies (pytest, jsonschema), the legacy `qa_api.py`/`qa_service.py` module pair
(superseded by `answer_api.py`/`ops_service.py`), the optional dense-rerank arm B code
(`dense_rerank.py`, unused by this backend), `.env`, any API key, any DB dump, `.git`
history, local development-tool configuration, and every other worktree on this machine.
