# Portable DocumentIR Retrieval Snapshot (Turn P5)

Builds a portable, deterministic, chunk-level snapshot of A's full
4,204-document DocumentIR corpus (domain/HANDOFF.md) so Turn P4's
pgvector-backed retrieval infrastructure can eventually index real document
chunks (`source_kind = 'DOCUMENT_CHUNK'`) instead of only VERIFIED Evidence.
This Turn does **not** call a real embedding API and does **not** write to
PostgreSQL -- it only produces the snapshot files and proves (via a pure
adapter + a fake embedding adapter) that a future loader could consume them.

## Why a manifest join is required

DocumentIR itself (`domain/interfaces/document-ir.schema.json`, produced by
the existing, unmodified `domain/adapters/a-document-ir.mjs`) never carries
`corp_code`, `doc_group`, `doc_subtype`, or `rcept_dt` -- only
`document_id` (`doc_group_rcept_no`) and structural blocks. Those fields
come from the corpus's own `manifest.jsonl` (one row per `doc_id`, joined
here 1:1 by `doc_id`). A `document_id` with no manifest row is a
fail-closed error, never a guess.

## Pipeline (`build-snapshot.mjs`)

1. Verify every one of the 4 source JSONL files' sha256 against
   `inventory.json` -- BEFORE any document is processed.
2. Load `manifest.jsonl` into a small in-memory join map (document
   metadata, not DocumentIR content -- bounded regardless of corpus size).
3. Stream each source file, one line (one document) at a time:
   `domain/adapters/a-document-ir.mjs`'s `adaptADocumentIR` +
   `mapCoverageState` (unmodified, reused) -> `chunking-policy.mjs`'s pure
   `chunkBlocks` -> `document-record.mjs`'s `buildDocumentRecord` /
   `buildChunkRecords` -> `snapshot-writer.mjs`'s atomic, streaming JSONL
   writers.
4. Fail-closed, whole-corpus invariant checks (document/group/coverage
   counts) before any of the 10 output files is finalized.

## Files

| File | Role |
|---|---|
| `contracts.mjs` | ids, hashing, canonicalization, path-portability guard |
| `chunking-policy.mjs` | pure, DocumentIR-node-first deterministic chunker |
| `document-record.mjs` | pure assembly of one document-record + its chunk rows |
| `snapshot-writer.mjs` | bounded-memory, atomic-rename JSONL/JSON writers |
| `p4-document-chunk-adapter.mjs` | pure bridge to Turn P4's DOCUMENT_CHUNK row shape |
| `build-snapshot.mjs` | the one module that touches the filesystem for the real corpus |

`scripts/build-document-retrieval-snapshot-v01.mjs` is the CLI: `run` does
one build pass (also used as the spawned child process for the
determinism-rebuild check); `full` runs the official build, the independent
rebuild-and-compare, the P4 compatibility check, and the fake-embedding
feasibility smoke, then writes `gate-status.v0.1.json`.

## What this Turn deliberately does NOT do

- No real embedding API call anywhere (`FAKE_DETERMINISTIC` only, and only
  as a feasibility smoke over a small sample -- no vector is ever written
  into a snapshot file).
- No PostgreSQL connection, no write to `reference_retrieval_chunks`.
- No re-indexing or change to Turn P4's already-loaded 219
  VERIFIED_EVIDENCE rows.
- A chunk is a *candidate for search only* -- `p4-document-chunk-adapter.mjs`
  never sets `citation_authority` or otherwise claims a chunk is a verified
  Fact. Grounding still requires `services.validator.validateEvidence`,
  exactly as `../pgvector-retriever-adapter.mjs`'s own README states.

## Output location

Real corpus output is written to `work/domain-seed/document-retrieval-snapshot-v0.1/`
(gitignored, per this repo's existing `/work/` policy -- see
domain/postgres/README.md's own "원본·전체 Canonical 복제본은 Git에 넣지
않고 `work/`에서 관리한다" convention). Only this module's code, contracts,
and tests are committed.
