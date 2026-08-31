-- Resumable Bounded-Memory Dedup Embedding Loader (Turn P8)
--
-- ADDITIVE ONLY: creates NEW objects alongside 001_core.sql,
-- 002_reference_release.sql, 003_reference_vector_retrieval.sql, and
-- 004_reference_dedup_retrieval_index.sql. Does not alter, drop, or rename
-- anything any of those migrations created. 004's own
-- reference_dedup_indexes / reference_dedup_canonical_texts /
-- reference_dedup_occurrences remain the ONLY production-facing tables a
-- Retriever ever reads -- this migration's tables are loader-internal
-- staging/session state, never queried by reference-dedup-retrieval-
-- repository.mjs.
--
-- WHY separate staging tables (not just a bigger in-process Map): the
-- entire point of this Turn is to stop holding 723,875 embeddings / a
-- 1,874,688-row occurrence set in process memory. Discovery, embedding,
-- and materialization each need their own durable, resumable checkpoint --
-- a crash between any two steps must be recoverable by re-querying rows
-- already written here, never by re-deriving state that only ever lived in
-- a Node process's heap.

BEGIN;

CREATE SCHEMA IF NOT EXISTS disclosure_reference;

DO $$
BEGIN
  CREATE TYPE disclosure_reference.dedup_load_session_status AS ENUM (
    'CREATED', 'DISCOVERING', 'DISCOVERY_COMPLETE', 'EMBEDDING', 'MATERIALIZING', 'READY', 'PAUSED', 'FAILED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE disclosure_reference.dedup_queue_status AS ENUM ('PENDING', 'LEASED', 'EMBEDDED', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ONE row per resumable load attempt. load_session_id is deterministic --
-- the SAME (snapshot_id, embedding_config) pair always yields the SAME
-- load_session_id (see computeDedupLoadSessionId in
-- reference-dedup-resumable-loader.mjs), which is exactly what lets a
-- second run of the same command RESUME rather than duplicate. It is
-- always identical to the 004 retrieval_index_id this session is building
-- toward (both are hashes of the same identity tuple) -- kept as a
-- separate column (rather than reusing retrieval_index_id as this table's
-- own PK name) only because a session can legitimately exist (CREATED /
-- DISCOVERING) before any 004 reference_dedup_indexes row does.
CREATE TABLE IF NOT EXISTS disclosure_reference.reference_dedup_load_sessions (
  load_session_id text PRIMARY KEY,
  retrieval_index_id text NOT NULL,
  release_id text NOT NULL REFERENCES disclosure_reference.releases(release_id) ON DELETE RESTRICT,
  snapshot_id text NOT NULL,
  snapshot_manifest_sha256 text NOT NULL CHECK (snapshot_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  document_chunks_sha256 text NOT NULL CHECK (document_chunks_sha256 ~ '^[0-9a-f]{64}$'),
  embedding_config_sha256 text NOT NULL CHECK (embedding_config_sha256 ~ '^[0-9a-f]{64}$'),
  embedding_provider text NOT NULL,
  embedding_model text NOT NULL,
  embedding_revision text NOT NULL,
  embedding_dimension integer NOT NULL CHECK (embedding_dimension > 0),
  distance_metric text NOT NULL CHECK (distance_metric IN ('cosine', 'l2', 'inner_product')),
  chunking_policy_id text NOT NULL,
  chunking_policy_sha256 text NOT NULL CHECK (chunking_policy_sha256 ~ '^[0-9a-f]{64}$'),
  batch_size integer NOT NULL CHECK (batch_size > 0),
  discovery_batch_size integer NOT NULL CHECK (discovery_batch_size > 0),
  max_retry_attempts integer NOT NULL CHECK (max_retry_attempts >= 0),
  lease_duration_ms integer NOT NULL CHECK (lease_duration_ms > 0),
  code_revision text NOT NULL,
  status disclosure_reference.dedup_load_session_status NOT NULL DEFAULT 'CREATED',
  source_line_count integer,
  source_byte_offset bigint NOT NULL DEFAULT 0,
  source_line_number integer NOT NULL DEFAULT 0,
  expected_canonical_count integer,
  expected_occurrence_count integer,
  discovered_canonical_count integer NOT NULL DEFAULT 0,
  discovered_occurrence_count integer NOT NULL DEFAULT 0,
  embedded_canonical_count integer NOT NULL DEFAULT 0,
  materialized_canonical_count integer NOT NULL DEFAULT 0,
  materialized_occurrence_count integer NOT NULL DEFAULT 0,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status = 'READY' AND last_error_code IS NULL)
    OR status <> 'READY'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS reference_dedup_load_sessions_index_idx
  ON disclosure_reference.reference_dedup_load_sessions (retrieval_index_id);

-- Only the LOADING -> {READY|FAILED} style monotone walk is legal, plus the
-- PAUSED "off-ramp" any of DISCOVERING/EMBEDDING/MATERIALIZING may take
-- (an operator-requested or lease/retry-exhaustion pause) and its own
-- resume back into the SAME step it paused from. FAILED and READY are both
-- terminal -- neither may transition again.
CREATE OR REPLACE FUNCTION disclosure_reference.guard_dedup_load_session_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  allowed boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reference dedup load session % cannot be deleted', OLD.load_session_id;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IN ('READY', 'FAILED') THEN
      RAISE EXCEPTION 'reference dedup load session % is immutable once %', OLD.load_session_id, OLD.status;
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
      RAISE EXCEPTION 'reference dedup load session %: illegal status transition % -> %', OLD.load_session_id, OLD.status, NEW.status;
    END IF;

    IF NEW.status = 'READY' AND NEW.last_error_code IS NOT NULL THEN
      RAISE EXCEPTION 'reference dedup load session %: cannot transition to READY with a last_error_code set', NEW.load_session_id;
    END IF;

    IF NEW.load_session_id IS DISTINCT FROM OLD.load_session_id
       OR NEW.retrieval_index_id IS DISTINCT FROM OLD.retrieval_index_id
       OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id
       OR NEW.snapshot_manifest_sha256 IS DISTINCT FROM OLD.snapshot_manifest_sha256
       OR NEW.document_chunks_sha256 IS DISTINCT FROM OLD.document_chunks_sha256
       OR NEW.embedding_config_sha256 IS DISTINCT FROM OLD.embedding_config_sha256
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'reference dedup load session %: identity and pin columns are immutable', OLD.load_session_id;
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS dedup_load_sessions_transition_guard ON disclosure_reference.reference_dedup_load_sessions;
CREATE TRIGGER dedup_load_sessions_transition_guard
BEFORE UPDATE OR DELETE ON disclosure_reference.reference_dedup_load_sessions
FOR EACH ROW EXECUTE FUNCTION disclosure_reference.guard_dedup_load_session_transition();

-- DB-BACKED DEDUP QUEUE. This table -- not an in-process Map -- is what
-- de-duplicates 1,874,688 occurrences down to their distinct text_sha256
-- set: discovery inserts each newly-seen (load_session_id, text_sha256)
-- pair with `ON CONFLICT (load_session_id, text_sha256) DO NOTHING`, so the
-- PRIMARY KEY itself does the O(1)-per-row dedup work no matter how large
-- the source is; the loader process never needs to hold more than one
-- discovery batch (a few hundred/thousand rows) in memory at a time.
CREATE TABLE IF NOT EXISTS disclosure_reference.reference_dedup_canonical_queue (
  load_session_id text NOT NULL REFERENCES disclosure_reference.reference_dedup_load_sessions(load_session_id) ON DELETE CASCADE,
  text_sha256 text NOT NULL CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
  canonical_text text NOT NULL CHECK (length(canonical_text) > 0),
  char_length integer NOT NULL CHECK (char_length > 0),
  status disclosure_reference.dedup_queue_status NOT NULL DEFAULT 'PENDING',
  embedding vector,
  lease_owner text,
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code text,
  materialized boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (load_session_id, text_sha256),
  CHECK ((status = 'EMBEDDED') = (embedding IS NOT NULL))
);

-- The lease-acquisition query's own access pattern: "give me up to N rows
-- that are PENDING, or LEASED-but-expired (a dead worker's lease), for
-- THIS session" -- this partial/composite index keeps that a real index
-- scan rather than a sequential scan even at 723,875 rows.
CREATE INDEX IF NOT EXISTS reference_dedup_canonical_queue_lease_idx
  ON disclosure_reference.reference_dedup_canonical_queue (load_session_id, status, lease_expires_at);
CREATE INDEX IF NOT EXISTS reference_dedup_canonical_queue_unmaterialized_idx
  ON disclosure_reference.reference_dedup_canonical_queue (load_session_id, materialized)
  WHERE materialized = false;

CREATE OR REPLACE FUNCTION disclosure_reference.touch_dedup_queue_row()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS dedup_canonical_queue_touch ON disclosure_reference.reference_dedup_canonical_queue;
CREATE TRIGGER dedup_canonical_queue_touch
BEFORE UPDATE ON disclosure_reference.reference_dedup_canonical_queue
FOR EACH ROW EXECUTE FUNCTION disclosure_reference.touch_dedup_queue_row();

-- ONE row per ORIGINAL chunk (occurrence provenance), batch-inserted during
-- DISCOVERY and copied into 004's reference_dedup_occurrences during
-- MATERIALIZATION. Never holds more than one discovery batch's worth of
-- new rows in the Node process -- the staging TABLE is the durable holding
-- area, not a process-level array.
CREATE TABLE IF NOT EXISTS disclosure_reference.reference_dedup_occurrence_staging (
  load_session_id text NOT NULL REFERENCES disclosure_reference.reference_dedup_load_sessions(load_session_id) ON DELETE CASCADE,
  chunk_id text NOT NULL CHECK (chunk_id ~ '^chunk_[0-9a-f]{24}$'),
  text_sha256 text NOT NULL CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
  source_document_id text NOT NULL,
  corp_code text CHECK (corp_code IS NULL OR corp_code ~ '^[0-9]{8}$'),
  source_group text,
  document_type text,
  node_id text NOT NULL,
  source_locator text NOT NULL,
  block_type text NOT NULL,
  parse_status text NOT NULL CHECK (parse_status IN ('SUCCESS', 'PARTIAL', 'FAILED')),
  chunk_ordinal integer NOT NULL CHECK (chunk_ordinal >= 0),
  char_start integer NOT NULL CHECK (char_start >= 0),
  char_end integer NOT NULL CHECK (char_end >= char_start),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  materialized boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (load_session_id, chunk_id)
);

CREATE INDEX IF NOT EXISTS reference_dedup_occurrence_staging_unmaterialized_idx
  ON disclosure_reference.reference_dedup_occurrence_staging (load_session_id, materialized)
  WHERE materialized = false;

-- Dimension-check for staged canonical embeddings -- mirrors 004's own
-- check_dedup_canonical_dimension, applied one migration earlier in the
-- pipeline (at EMBEDDING time, not just at MATERIALIZATION time into 004's
-- table) so a dimension mistake in embeddingAdapter output is caught the
-- instant it is written, not silently carried through to materialization.
CREATE OR REPLACE FUNCTION disclosure_reference.check_dedup_queue_dimension()
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
  FROM disclosure_reference.reference_dedup_load_sessions
  WHERE load_session_id = NEW.load_session_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'reference_dedup_canonical_queue: unknown load_session_id %', NEW.load_session_id;
  END IF;

  actual_dim := vector_dims(NEW.embedding);
  IF actual_dim IS DISTINCT FROM expected_dim THEN
    RAISE EXCEPTION 'reference_dedup_canonical_queue: embedding dimension % does not match session %''s pinned embedding_dimension %',
      actual_dim, NEW.load_session_id, expected_dim;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS dedup_queue_dimension_check ON disclosure_reference.reference_dedup_canonical_queue;
CREATE TRIGGER dedup_queue_dimension_check
BEFORE INSERT OR UPDATE ON disclosure_reference.reference_dedup_canonical_queue
FOR EACH ROW EXECUTE FUNCTION disclosure_reference.check_dedup_queue_dimension();

INSERT INTO disclosure_reference.schema_migrations (migration_id)
VALUES ('005_reference_dedup_load_sessions_v0.1')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
