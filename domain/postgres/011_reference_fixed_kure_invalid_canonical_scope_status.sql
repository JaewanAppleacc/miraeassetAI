-- Turn AC-VFINAL-ALIGNMENT-AND-DISCOVERY (post-hoc correction): adds ONE
-- new terminal status value, INVALID_DISCOVERY_CANONICAL_SCOPE, to 006's
-- disclosure_reference.fixed_kure_load_session_status enum.
--
-- WHY: runDiscoveryPass's pre-existing (v1, unmodified by this Turn) unique-
-- text tracking adds EVERY chunk's embed_text_sha256 to the canonical
-- queue regardless of that chunk's own retrieval_eligible flag, while
-- chunk_staging only ever stores retrieval_eligible=true chunks. For a
-- unique text that appears ONLY in retrieval_eligible=false chunks (e.g. a
-- fallback-tier document's DOCUMENT_FALLBACK/AUDIT_ONLY chunks) and never
-- in any eligible chunk, the canonical queue ends up with an "orphan" row
-- no eligible occurrence ever references -- inflating
-- discovered_unique_text_count/expected_unique_embeddable_count beyond the
-- true embedding target (distinct embed_text_sha256 referenced by >=1
-- retrieval_eligible=true occurrence). Measured on the real full-corpus
-- attempt: canonical_total=447225, eligible-referenced=441879,
-- orphan=5346 -- exactly matching total_chunks(447895) -
-- search_eligible(442549).
--
-- This status marks an attempt whose OWN discovered_unique_text_count/
-- expected_unique_embeddable_count fields are WRONG in this specific way --
-- terminal and immutable (a naive embedding-phase reader must never trust
-- those two fields on such a row), but the row's chunk_staging/
-- canonical_queue data is NOT deleted or altered (still a valid read-only
-- source for a correctly-scoped embedding-input manifest built on top of
-- it -- see scripts/p11f0-embedding-input-manifest.mjs). Also excluded
-- from the active-attempt uniqueness gate, like SUPERSEDED_ZERO_PROGRESS
-- and FAILED_DISCOVERY_RESOURCE_EXHAUSTED, so a corrected fresh attempt of
-- the same logical load may be created without colliding.
--
-- WHY ITS OWN MIGRATION FILE, SEPARATE FROM 012: same PostgreSQL rule as
-- 007/008/009/010 -- a freshly ALTER TYPE ... ADD VALUE'd enum label
-- cannot be referenced within the SAME transaction that added it.

BEGIN;

ALTER TYPE disclosure_reference.fixed_kure_load_session_status ADD VALUE IF NOT EXISTS 'INVALID_DISCOVERY_CANONICAL_SCOPE';

INSERT INTO disclosure_reference.schema_migrations (migration_id)
VALUES ('011_reference_fixed_kure_invalid_canonical_scope_status_v0.1')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
