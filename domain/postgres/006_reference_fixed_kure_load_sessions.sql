-- Resumable Bounded-Memory Fixed-512-o64 x KURE-v1 Hybrid Retrieval Loader
-- (Turn P11-F0)
--
-- ADDITIVE ONLY: creates NEW objects alongside 001_core.sql,
-- 002_reference_release.sql, 003_reference_vector_retrieval.sql,
-- 004_reference_dedup_retrieval_index.sql, and
-- 005_reference_dedup_load_sessions.sql. Does not alter, drop, or rename
-- anything any of those migrations created. This migration's own tables
-- are loader-internal staging/session state, mirroring
-- 005_reference_dedup_load_sessions.sql's exact pattern (four-phase
-- resumable load: DISCOVERY -> EMBEDDING -> MATERIALIZING -> READY) but
-- for a DIFFERENT target: this loader's finished output lands in
-- 003_reference_vector_retrieval.sql's EXISTING, unmodified
-- reference_retrieval_indexes / reference_retrieval_chunks tables under
-- source_kind = 'DOCUMENT_CHUNK' (that source_kind's own comment in 003
-- already reserved it for exactly this future full-corpus chunking
-- pipeline) -- 004/005's dedup-specific tables are never read or written
-- by this migration's tables or by the loader that uses them.
--
-- WHY A SEPARATE unique-text QUEUE, KEYED ON embed_text (not raw_text):
-- domain/chunking/chunker.mjs's own embed_text field (company/document/
-- chunk-type/section context prepended to raw_text) is what actually gets
-- embedded (see scripts/p10.2-stage2-embedding-grid.mjs's own
-- embedRoleCached call sites) -- two chunks can share identical raw_text
-- (duplicate_group_id) while still needing SEPARATE embedding calls
-- because their embed_text context header differs (different document_id/
-- section). This loader's canonical queue therefore dedups on
-- sha256(embed_text), never sha256(raw_text).
--
-- WHY per-source-file discovery progress as jsonb (not a single byte
-- offset, unlike 005's dedup loader): the real corpus this loader streams
-- is FOUR separate source files (exchange/major/holding/periodic-001),
-- not one -- domain/agent-comparison/chunking-comparison/
-- full-corpus-streamer.mjs's own CORPUS_SOURCE_FILES order. A crash
-- mid-file needs its own (byte_offset, line_number) per file, not one
-- shared cursor.

BEGIN;

CREATE SCHEMA IF NOT EXISTS disclosure_reference;

DO $$
BEGIN
  CREATE TYPE disclosure_reference.fixed_kure_load_session_status AS ENUM (
    'CREATED', 'DISCOVERING', 'DISCOVERY_COMPLETE', 'EMBEDDING', 'MATERIALIZING', 'READY', 'PAUSED', 'FAILED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE disclosure_reference.fixed_kure_queue_status AS ENUM ('PENDING', 'LEASED', 'EMBEDDED', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ONE row per resumable load attempt. load_session_id is deterministic --
-- the SAME (corpus_snapshot_id, chunking_policy, embedding_config) tuple
-- always yields the SAME load_session_id (mirrors
-- computeDedupLoadSessionId's own determinism, Turn P8), which is exactly
-- what lets a second invocation of the same loader command RESUME rather
-- than duplicate or restart. Always identical to the eventual 003
-- retrieval_index_id this session materializes into.
CREATE TABLE IF NOT EXISTS disclosure_reference.reference_fixed_kure_load_sessions (
  load_session_id text PRIMARY KEY,
  retrieval_index_id text NOT NULL,
  release_id text NOT NULL REFERENCES disclosure_reference.releases(release_id) ON DELETE RESTRICT,
  corpus_snapshot_id text NOT NULL,
  corpus_manifest_sha256 text NOT NULL CHECK (corpus_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  chunking_policy_id text NOT NULL,
  chunking_policy_sha256 text NOT NULL CHECK (chunking_policy_sha256 ~ '^[0-9a-f]{64}$'),
  embedding_config_sha256 text NOT NULL CHECK (embedding_config_sha256 ~ '^[0-9a-f]{64}$'),
  embedding_provider text NOT NULL,
  embedding_model text NOT NULL,
  embedding_revision text NOT NULL,
  embedding_dimension integer NOT NULL CHECK (embedding_dimension > 0),
  distance_metric text NOT NULL CHECK (distance_metric IN ('cosine', 'l2', 'inner_product')),
  batch_size integer NOT NULL CHECK (batch_size > 0),
  discovery_batch_size integer NOT NULL CHECK (discovery_batch_size > 0),
  max_retry_attempts integer NOT NULL CHECK (max_retry_attempts >= 0),
  lease_duration_ms integer NOT NULL CHECK (lease_duration_ms > 0),
  code_revision text NOT NULL,
  status disclosure_reference.fixed_kure_load_session_status NOT NULL DEFAULT 'CREATED',
  -- Per-source-file streaming cursor: { "<filename>": {"byte_offset": n, "line_number": n, "done": bool}, ... }
  source_files_progress jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(source_files_progress) = 'object'),
  discovery_pass_number integer NOT NULL DEFAULT 0 CHECK (discovery_pass_number IN (0, 1, 2)),
  pass1_chunk_stream_sha256 text CHECK (pass1_chunk_stream_sha256 IS NULL OR pass1_chunk_stream_sha256 ~ '^[0-9a-f]{64}$'),
  pass2_chunk_stream_sha256 text CHECK (pass2_chunk_stream_sha256 IS NULL OR pass2_chunk_stream_sha256 ~ '^[0-9a-f]{64}$'),
  expected_document_count integer,
  expected_total_chunk_count integer,
  expected_search_eligible_count integer,
  expected_unique_embeddable_count integer,
  discovered_document_count integer NOT NULL DEFAULT 0,
  discovered_total_chunk_count integer NOT NULL DEFAULT 0,
  discovered_search_eligible_count integer NOT NULL DEFAULT 0,
  discovered_unique_text_count integer NOT NULL DEFAULT 0,
  embedded_unique_text_count integer NOT NULL DEFAULT 0,
  materialized_chunk_count integer NOT NULL DEFAULT 0,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status = 'READY' AND last_error_code IS NULL)
    OR status <> 'READY'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS reference_fixed_kure_load_sessions_index_idx
  ON disclosure_reference.reference_fixed_kure_load_sessions (retrieval_index_id);

-- Mirrors 005's guard_dedup_load_session_transition exactly (same
-- DISCOVERING/DISCOVERY_COMPLETE/EMBEDDING/MATERIALIZING/READY/PAUSED/
-- FAILED state machine, same "identity/pin columns are immutable" rule),
-- applied to this loader's own column set.
CREATE OR REPLACE FUNCTION disclosure_reference.guard_fixed_kure_load_session_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  allowed boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reference fixed/kure load session % cannot be deleted', OLD.load_session_id;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IN ('READY', 'FAILED') THEN
      RAISE EXCEPTION 'reference fixed/kure load session % is immutable once %', OLD.load_session_id, OLD.status;
    END IF;

    IF NEW.status = OLD.status THEN
      allowed := true; -- progress within the same step (checkpoint/counter updates)
    ELSIF OLD.status = 'CREATED' AND NEW.status IN ('DISCOVERING', 'FAILED') THEN
      allowed := true;
    ELSIF OLD.status = 'DISCOVERING' AND NEW.status IN ('DISCOVERY_COMPLETE', 'PAUSED', 'FAILED') THEN
      allowed := true;
    ELSIF OLD.status = 'DISCOVERY_COMPLETE' AND NEW.status IN ('EMBEDDING', 'FAILED') THEN
      allowed := true;
    ELSIF OLD.status = 'EMBEDDING' AND NEW.status IN ('MATERIALIZING', 'PAUSED', 'FAILED') THEN
      allowed := true;
    ELSIF OLD.status = 'MATERIALIZING' AND NEW.status IN ('READY', 'PAUSED', 'FAILED') THEN
      allowed := true;
    ELSIF OLD.status = 'PAUSED' AND NEW.status IN ('DISCOVERING', 'EMBEDDING', 'MATERIALIZING', 'FAILED') THEN
      allowed := true; -- resume back into a step, or give up
    END IF;

    IF NOT allowed THEN
      RAISE EXCEPTION 'reference fixed/kure load session %: illegal status transition % -> %', OLD.load_session_id, OLD.status, NEW.status;
    END IF;

    IF NEW.status = 'READY' AND NEW.last_error_code IS NOT NULL THEN
      RAISE EXCEPTION 'reference fixed/kure load session %: cannot transition to READY with a last_error_code set', NEW.load_session_id;
    END IF;

    IF NEW.load_session_id IS DISTINCT FROM OLD.load_session_id
       OR NEW.retrieval_index_id IS DISTINCT FROM OLD.retrieval_index_id
       OR NEW.corpus_snapshot_id IS DISTINCT FROM OLD.corpus_snapshot_id
       OR NEW.corpus_manifest_sha256 IS DISTINCT FROM OLD.corpus_manifest_sha256
       OR NEW.chunking_policy_sha256 IS DISTINCT FROM OLD.chunking_policy_sha256
       OR NEW.embedding_config_sha256 IS DISTINCT FROM OLD.embedding_config_sha256
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'reference fixed/kure load session %: identity and pin columns are immutable', OLD.load_session_id;
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fixed_kure_load_sessions_transition_guard ON disclosure_reference.reference_fixed_kure_load_sessions;
CREATE TRIGGER fixed_kure_load_sessions_transition_guard
BEFORE UPDATE OR DELETE ON disclosure_reference.reference_fixed_kure_load_sessions
FOR EACH ROW EXECUTE FUNCTION disclosure_reference.guard_fixed_kure_load_session_transition();

-- DB-BACKED UNIQUE-EMBEDDABLE-TEXT QUEUE, keyed on sha256(embed_text) --
-- not an in-process Map -- exactly mirroring 005's own
-- reference_dedup_canonical_queue dedup discipline (ON CONFLICT DO
-- NOTHING at INSERT time does the O(1)-per-row dedup work; the loader
-- process never holds more than one discovery batch in memory).
CREATE TABLE IF NOT EXISTS disclosure_reference.reference_fixed_kure_canonical_queue (
  load_session_id text NOT NULL REFERENCES disclosure_reference.reference_fixed_kure_load_sessions(load_session_id) ON DELETE CASCADE,
  embed_text_sha256 text NOT NULL CHECK (embed_text_sha256 ~ '^[0-9a-f]{64}$'),
  embed_text text NOT NULL CHECK (length(embed_text) > 0),
  char_length integer NOT NULL CHECK (char_length > 0),
  status disclosure_reference.fixed_kure_queue_status NOT NULL DEFAULT 'PENDING',
  embedding vector,
  lease_owner text,
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code text,
  materialized boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (load_session_id, embed_text_sha256),
  CHECK ((status = 'EMBEDDED') = (embedding IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS reference_fixed_kure_canonical_queue_lease_idx
  ON disclosure_reference.reference_fixed_kure_canonical_queue (load_session_id, status, lease_expires_at);
CREATE INDEX IF NOT EXISTS reference_fixed_kure_canonical_queue_unmaterialized_idx
  ON disclosure_reference.reference_fixed_kure_canonical_queue (load_session_id, materialized)
  WHERE materialized = false;

CREATE OR REPLACE FUNCTION disclosure_reference.touch_fixed_kure_queue_row()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fixed_kure_canonical_queue_touch ON disclosure_reference.reference_fixed_kure_canonical_queue;
CREATE TRIGGER fixed_kure_canonical_queue_touch
BEFORE UPDATE ON disclosure_reference.reference_fixed_kure_canonical_queue
FOR EACH ROW EXECUTE FUNCTION disclosure_reference.touch_fixed_kure_queue_row();

CREATE OR REPLACE FUNCTION disclosure_reference.check_fixed_kure_queue_dimension()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_dim integer;
  actual_dim integer;
BEGIN
  IF NEW.embedding IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT embedding_dimension INTO expected_dim
  FROM disclosure_reference.reference_fixed_kure_load_sessions
  WHERE load_session_id = NEW.load_session_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'reference_fixed_kure_canonical_queue: unknown load_session_id %', NEW.load_session_id;
  END IF;

  actual_dim := vector_dims(NEW.embedding);
  IF actual_dim IS DISTINCT FROM expected_dim THEN
    RAISE EXCEPTION 'reference_fixed_kure_canonical_queue: embedding dimension % does not match session %''s pinned embedding_dimension %',
      actual_dim, NEW.load_session_id, expected_dim;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fixed_kure_queue_dimension_check ON disclosure_reference.reference_fixed_kure_canonical_queue;
CREATE TRIGGER fixed_kure_queue_dimension_check
BEFORE INSERT OR UPDATE ON disclosure_reference.reference_fixed_kure_canonical_queue
FOR EACH ROW EXECUTE FUNCTION disclosure_reference.check_fixed_kure_queue_dimension();

-- ONE row per ORIGINAL chunk (full canonical digest -- CLAUDE.md Turn
-- P11-F0 section C's own list: chunk_id, document_id, chunk index,
-- raw_text sha, token_count, source spans/locators, corp_code, doc_group,
-- receipt date, section metadata, search eligibility, chunking policy
-- ID/version). Batch-inserted during DISCOVERY, copied into 003's
-- reference_retrieval_chunks (source_kind='DOCUMENT_CHUNK') during
-- MATERIALIZATION, using the matching canonical_queue row's embedding for
-- embed_text_sha256. Never holds more than one discovery batch in the
-- Node process -- this staging TABLE is the durable holding area.
CREATE TABLE IF NOT EXISTS disclosure_reference.reference_fixed_kure_chunk_staging (
  load_session_id text NOT NULL REFERENCES disclosure_reference.reference_fixed_kure_load_sessions(load_session_id) ON DELETE CASCADE,
  chunk_id text NOT NULL CHECK (chunk_id ~ '^chunk_[0-9a-f]{24}$'),
  document_id text NOT NULL,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  -- domain/retrieval/retrieval-result.schema.json's own results[].chunk_type
  -- enum -- Fixed-512-o64 (a FLAT policy, no hierarchy/adaptive-table) only
  -- ever produces FIXED_WINDOW or DOCUMENT_FALLBACK (fallback-tier parse),
  -- and parent_chunk_id is always null for this policy, but both are
  -- carried through unchanged from chunker.mjs's own output rather than
  -- assumed here.
  chunk_type text NOT NULL,
  parent_chunk_id text CHECK (parent_chunk_id IS NULL OR parent_chunk_id ~ '^chunk_[0-9a-f]{24}$'),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  -- The chunk's VERBATIM source text (chunker.mjs's own raw_text) -- this
  -- is what 003's reference_retrieval_chunks.text_content /
  -- RetrieverResult.raw_text must carry (text_provenance=SOURCE_VERBATIM),
  -- NEVER embed_text (which has a synthesized company/document/section
  -- context header prepended -- see envelope note in
  -- reference-fixed-kure-load-session-repository.mjs's own header).
  raw_text text NOT NULL CHECK (length(raw_text) > 0),
  embed_text_sha256 text NOT NULL CHECK (embed_text_sha256 ~ '^[0-9a-f]{64}$'),
  token_count integer NOT NULL CHECK (token_count > 0 AND token_count <= 512),
  corp_code text CHECK (corp_code IS NULL OR corp_code ~ '^[0-9]{8}$'),
  doc_group text NOT NULL,
  receipt_date text,
  section_path jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(section_path) = 'array'),
  source_locator text NOT NULL,
  source_spans jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(source_spans) = 'array'),
  chunking_policy_id text NOT NULL,
  chunking_policy_version text NOT NULL,
  retrieval_eligible boolean NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  materialized boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (load_session_id, chunk_id)
);

CREATE INDEX IF NOT EXISTS reference_fixed_kure_chunk_staging_unmaterialized_idx
  ON disclosure_reference.reference_fixed_kure_chunk_staging (load_session_id, materialized)
  WHERE materialized = false;
CREATE INDEX IF NOT EXISTS reference_fixed_kure_chunk_staging_document_idx
  ON disclosure_reference.reference_fixed_kure_chunk_staging (load_session_id, document_id);
CREATE INDEX IF NOT EXISTS reference_fixed_kure_chunk_staging_embed_text_idx
  ON disclosure_reference.reference_fixed_kure_chunk_staging (load_session_id, embed_text_sha256);

INSERT INTO disclosure_reference.schema_migrations (migration_id)
VALUES ('006_reference_fixed_kure_load_sessions_v0.1')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
