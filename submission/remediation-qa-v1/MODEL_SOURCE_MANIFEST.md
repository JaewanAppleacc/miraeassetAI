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

## Runtime files — git blob SHA-1 at b5f9443f

Every path below was copied byte-for-byte from the commit above. The hash is
`git hash-object`'s blob SHA-1 (not this package's own SHA256SUMS, which hashes the
copies as they sit in this package — both should match; SHA256SUMS is the
independent, algorithm-different cross-check).

```
e69de29bb2d1d6434b8b29ae775ad8c2e48c5391  src/dart_corpus/__init__.py
fa72873b789f61107aa14538f631eddc8bb9230e  src/dart_corpus/retrieval/__init__.py
85360b782c56f7517eb0dd23b138de823e1a6343  src/dart_corpus/retrieval/chunk_index.py
7a8868fd163c1b36b531b9d4a3234ac46e875c43  src/dart_corpus/retrieval/conditions.py
3e8591130447ff646faaad6f31b68e7ce8ace0c3  src/dart_corpus/retrieval/corp_dictionary.py
0f611bdc6109762d0a9d2478369e2ad43275e56d  src/dart_corpus/retrieval/lexical.py
96fa7ede9a81d3191124ee4f2320a5ce43bebf0e  src/dart_corpus/retrieval/node_store.py
7f9ffaea654838b178f41dd646d89e98d9037a20  src/dart_corpus/retrieval/segments.py
c541e55facf4c6a17e7b582adf39141869fc82d2  src/dart_detective/__init__.py
74c28b4933449b45defe92e13760551814401a9e  src/dart_detective/agents/__init__.py
89c9711e15b0be21860892c0fbb5359265203a76  src/dart_detective/agents/calculator.py
568c979b00b00efd98cb7a9b366c878c309fe1a6  src/dart_detective/agents/confidence.py
040f3f1206bfe51fe6babf4f55bb2c87d15fc578  src/dart_detective/agents/qa_agent.py
e4183cf2ad78ca81258a12bf7b3452c50f9484b7  src/dart_detective/agents/tables.py
20509d60cd2586824a884cf904fd9e1ea6d54654  src/dart_detective/agents/validator.py
8a9c38f1a4d8a08a434577e4859c1cdfa8a27b5e  src/dart_detective/answer_api.py
8bd202f760668bb96b884464eaa7f34ece3e609c  src/dart_detective/answer_wire.py
9cabe334c393cbbba0f1cdc805094a25de73ef29  src/dart_detective/arm_a4_a3_live_adapter.py
86d487766f16095477b38577b1b5ab4c872b9972  src/dart_detective/arm_a4_a3_live_worker_client.py
e6296591219c2f53130aff715fabdfe2eda4ee64  src/dart_detective/arm_a4_a3_remediation_live_adapter.py
e7f3312e15a151ac041e99008254a58cead6ac70  src/dart_detective/arm_a4_a3_remediation_live_worker_client.py
277eb1195f8a98c9d98637316431ce974178c911  src/dart_detective/arm_a_adapter.py
8fa76b1a4705c93828e92e85eeb52e519053cb12  src/dart_detective/arm_a_live_adapter.py
877915e7348bd6928b18d65f9f7022c5dd72dfdc  src/dart_detective/arm_a_live_worker_client.py
9c44ac112612d4b7f849d15e1eb91b44b6eec5e0  src/dart_detective/arm_a_serving_bridge.py
a370de16b104c54537a1891f7442b591b4f4aa76  src/dart_detective/corpus_retriever.py
1471e845b3b5dc7132bf443736bc17c48c28f55c  src/dart_detective/fallback.py
71bbd063ae94729a2167f52e5c2ae5740466cbf7  src/dart_detective/grounded_answer.py
0e78565a4518f658c4279234d7bb68c99b47683c  src/dart_detective/llm.py
142f99346a889a6c3113c6719cb960b8cc46dcb0  src/dart_detective/ops_service.py
9b65ac6a04a6cf1bcba4f997aac3245a9de01e16  src/dart_detective/policy_gate.py
64ac500e340bc53f44d2c09f710b7ca81e382bec  src/dart_detective/retriever_adapter.py
d1a66506523153a1e60ccb2599fbe28d54941f92  src/dart_detective/routing.py
363f46594f45c964c921b2c04827eba250f44f0b  scripts/arm_a4_a3_remediation_live_worker.mjs
5921552f20951d0fa22a3f444295dc61387332b0  domain/agent-comparison/chunking-comparison/bm25.mjs
7e85fba4b801a44f1b6be1520a83989bb6134bc4  domain/agent-comparison/chunking-comparison/rrf.mjs
7dc7ce510e8c399c2de206870fb479ca1e9a506a  domain/agent-comparison/four-arm-ac/a3-evidence-contradiction-guard.mjs
eec7643c8792b1706df73c3678b2b0133e5700e1  domain/agent-comparison/four-arm-ac/a4-a3-remediation-candidate-legs.mjs
8e7d85348b5401623cf7fabd8e812035a56befdb  domain/agent-comparison/four-arm-ac/a4-a3-remediation-retrieval-pipeline.mjs
a0fa3c8a30321677c6769ef3e9f3aed741cbcf7a  domain/agent-comparison/four-arm-ac/a4-a3-retrieval-pipeline.mjs
ded8ac0535f2958fb1357b336f0348a32dada03a  domain/agent-comparison/four-arm-ac/a4-reranker-configs.v1.json
bb7e735d6444fe79fdc22b2e1a6d3ad97684b317  domain/agent-comparison/four-arm-ac/a4-reranker-engine.mjs
205fda1c2760b79bb408bf169a6dff7d857c45b5  domain/agent-comparison/four-arm-ac/a4-reranker-features.mjs
fedcfcbbafca5cdc873b5c32ec691419b144d4d7  domain/agent-comparison/four-arm-ac/a4-wide-candidate-pool.mjs
4b62a723201ac7da71f72509de3a6fa0aa4a6fde  domain/agent-comparison/four-arm-ac/arm-retriever-adapter.mjs
31acad25f5b4944dc4c07efc3af786e6e3c7c7c1  domain/agent-comparison/four-arm-ac/conditions-fixture.mjs
91cb4749d7093b6d6fa4b7a16f6aa1248ac7908e  domain/agent-comparison/four-arm-ac/four-arm-conditions-to-filter-mapper.mjs
8d2eec153a2434851dcde5728f2ed4164a011eee  domain/agent-comparison/four-arm-ac/four-arm-retrieval-policy.mjs
5a313e5932fc934cad182883811ce63c48eeed84  domain/agent-comparison/four-arm-ac/locator-provenance.mjs
9fa0fc1d709a8034d5d4621dcb3e2a19d94e5f31  domain/agent-comparison/four-arm-ac/qa-condition-mapper.mjs
4d1bc42183307b540e37ca38738914d0600450b4  domain/agent-comparison/retrieval/contracts.mjs
0131ccda37a7a621b6c70a5ce3e89e7d8d4e9eeb  domain/agent-comparison/retrieval/embedding-adapter.mjs
7818dbb5047414c6cd396e424fef7efde2bb86bb  domain/agent-comparison/retrieval/fake-deterministic-embedding-adapter.mjs
a9dca408fd88b7fe13d0590d82591d4a10d0db83  domain/agent-comparison/retrieval/fixed-kure-bm25-index.mjs
24d7c4c31273a6c5f0dc1275a0f9798d87ad9d2c  domain/agent-comparison/retrieval/fixed-kure-hybrid-retriever-adapter.mjs
496fb4d6ad7e743d6e27b1080aabe88d8411a820  domain/chunking/chunker.mjs
497484f50b58cb3b0070331f07191ec82165bb79  domain/contracts.mjs
0251d4cea991d76c4d074494579b96c01c00c159  domain/postgres/reference-vector-retrieval-repository.mjs
41e03bcf482ff1c0bc21bcc548ca75e9a62b02f0  domain/retrieval/metadata-filter.mjs
ae480010b7cfc6da65d3a10b3406ad8f59fd62b8  domain/runtime/abortable.mjs
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
