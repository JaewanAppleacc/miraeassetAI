-- Disclosure Analyst pgvector-backed retrieval index v0.1 (Turn P4)
--
-- ADDITIVE ONLY: this migration creates NEW objects alongside the existing
-- disclosure_reference schema (001_core.sql, 002_reference_release.sql).
-- It does not alter, drop, or rename anything either of those migrations
-- created. Fact/Evidence/Event/Relation remain governed exclusively by
-- 002_reference_release.sql's own tables/triggers -- this migration only
-- ADDS a read-optimized candidate-search index derived FROM that data.
--
-- OPERATIONAL PRIVILEGE ASSUMPTION, STATED PLAINLY (not hidden): applying
-- this migration requires `CREATE EXTENSION vector` to succeed, which in
-- turn requires (a) the pgvector extension's control/SQL files to already
-- be installed on the PostgreSQL server's filesystem (a superuser/OS-level
-- installation step this project does NOT perform automatically -- see
-- domain/postgres/README.md's Turn P4 section) and (b) the connecting role
-- to have the privilege to create extensions in the target database. If
-- either is missing, `CREATE EXTENSION vector` fails and -- because this
-- whole file is one BEGIN/COMMIT transaction, exactly like
-- 002_reference_release.sql -- the ENTIRE migration rolls back atomically.
-- No partial schema is ever left behind by a failed apply.
--
-- WHY A SHARED, UNCONSTRAINED `vector` COLUMN (not `vector(n)`): pgvector's
-- fixed-dimension column type (`vector(1536)` etc.) is what lets ivfflat/
-- hnsw ANN indexes be built, but it also hard-codes ONE dimension per
-- table. This schema instead allows MULTIPLE retrieval indexes -- each
-- pinning its OWN embedding_dimension in reference_retrieval_indexes -- to
-- share one reference_retrieval_chunks table, so a future second embedding
-- model/dimension does not require a new migration. The tradeoff (stated
-- honestly, not hidden): search in this Turn is a brute-force
-- `ORDER BY embedding <=> query_vector` scan, not an ANN index scan. Given
-- this Turn's indexing scope is v0.20-r3's own VERIFIED Evidence set (order
-- of hundreds of rows, not millions), that is an acceptable, deliberate
-- choice for a shadow/wiring Turn -- a future Turn that needs ANN-index
-- performance at full-corpus scale can add a per-dimension partition or
-- per-index table without breaking this one's own contract.

BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS disclosure_reference;

DO $$
BEGIN
  CREATE TYPE disclosure_reference.retrieval_index_status AS ENUM ('LOADING', 'READY', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE disclosure_reference.retrieval_source_kind AS ENUM ('VERIFIED_EVIDENCE', 'DOCUMENT_CHUNK');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- One row per (release, embedding config, chunking policy) combination
-- actually loaded. `release_id` REFERENCES the existing, unmodified
-- disclosure_reference.releases -- a retrieval index can only ever pin a
-- release that already exists there (any release, LOADING or READY at
-- FK-check time; index construction itself additionally requires the
-- release to be READY -- see reference-vector-retrieval-loader.mjs).
CREATE TABLE IF NOT EXISTS disclosure_reference.reference_retrieval_indexes (
  retrieval_index_id text PRIMARY KEY,
  release_id text NOT NULL REFERENCES disclosure_reference.releases(release_id) ON DELETE RESTRICT,
  source_snapshot_id text NOT NULL,
  embedding_provider text NOT NULL,
  embedding_model text NOT NULL,
  embedding_revision text NOT NULL,
  embedding_dimension integer NOT NULL CHECK (embedding_dimension > 0),
  distance_metric text NOT NULL CHECK (distance_metric IN ('cosine', 'l2', 'inner_product')),
  chunking_policy_id text NOT NULL,
  chunking_policy_sha256 text NOT NULL CHECK (chunking_policy_sha256 ~ '^[0-9a-f]{64}$'),
  index_status disclosure_reference.retrieval_index_status NOT NULL DEFAULT 'LOADING',
  created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  record_count integer NOT NULL DEFAULT 0 CHECK (record_count >= 0),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (
    (index_status = 'LOADING' AND ready_at IS NULL)
    OR (index_status = 'READY' AND ready_at IS NOT NULL)
    OR (index_status = 'FAILED')
  )
);

-- One row per indexed chunk. `source_kind = 'VERIFIED_EVIDENCE'` uses one
-- VERIFIED Evidence record as-is (no synthesized sentences -- see the
-- loader's own header comment); `source_kind = 'DOCUMENT_CHUNK'` is
-- reserved for the future full-corpus chunking pipeline (interface/schema
-- only this Turn -- no real document is loaded under this source_kind, see
-- reference-vector-retrieval-loader.mjs and its own tests).
CREATE TABLE IF NOT EXISTS disclosure_reference.reference_retrieval_chunks (
  retrieval_index_id text NOT NULL REFERENCES disclosure_reference.reference_retrieval_indexes(retrieval_index_id) ON DELETE CASCADE,
  chunk_id text NOT NULL CHECK (chunk_id ~ '^chunk_[0-9a-f]{24}$'),
  source_kind disclosure_reference.retrieval_source_kind NOT NULL,
  record_key text NOT NULL,
  evidence_id text CHECK (evidence_id IS NULL OR evidence_id ~ '^evidence_[0-9a-f]{24}$'),
  source_document_id text NOT NULL,
  corp_code text CHECK (corp_code IS NULL OR corp_code ~ '^[0-9]{8}$'),
  source_locator text NOT NULL,
  chunk_ordinal integer NOT NULL CHECK (chunk_ordinal >= 0),
  text_content text NOT NULL CHECK (length(text_content) > 0),
  text_sha256 text NOT NULL CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  embedding vector NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (retrieval_index_id, chunk_id),
  UNIQUE (retrieval_index_id, record_key),
  CHECK (source_kind <> 'VERIFIED_EVIDENCE' OR evidence_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS reference_retrieval_chunks_document_idx
  ON disclosure_reference.reference_retrieval_chunks (retrieval_index_id, source_document_id);
CREATE INDEX IF NOT EXISTS reference_retrieval_chunks_corp_idx
  ON disclosure_reference.reference_retrieval_chunks (retrieval_index_id, corp_code)
  WHERE corp_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS reference_retrieval_chunks_source_kind_idx
  ON disclosure_reference.reference_retrieval_chunks (retrieval_index_id, source_kind);

-- Enforces that every stored embedding actually has the dimension its own
-- parent index declared -- an application-level bug (or a hand-crafted
-- INSERT) writing a mismatched-dimension vector is rejected by the
-- database itself, not only by loader-side JS validation.
CREATE OR REPLACE FUNCTION disclosure_reference.check_retrieval_chunk_dimension()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_dim integer;
  actual_dim integer;
BEGIN
  SELECT embedding_dimension INTO expected_dim
  FROM disclosure_reference.reference_retrieval_indexes
  WHERE retrieval_index_id = NEW.retrieval_index_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'reference_retrieval_chunks: unknown retrieval_index_id %', NEW.retrieval_index_id;
  END IF;

  actual_dim := vector_dims(NEW.embedding);
  IF actual_dim IS DISTINCT FROM expected_dim THEN
    RAISE EXCEPTION 'reference_retrieval_chunks: embedding dimension % does not match index %''s pinned embedding_dimension %',
      actual_dim, NEW.retrieval_index_id, expected_dim;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS retrieval_chunks_dimension_check ON disclosure_reference.reference_retrieval_chunks;
CREATE TRIGGER retrieval_chunks_dimension_check
BEFORE INSERT OR UPDATE ON disclosure_reference.reference_retrieval_chunks
FOR EACH ROW EXECUTE FUNCTION disclosure_reference.check_retrieval_chunk_dimension();

-- Mirrors 002_reference_release.sql's reject_non_loading_child_write
-- exactly, including its CASCADE-delete FOUND-based fix (Turn N1.2 there):
-- a chunk row may only be inserted/updated/deleted while its PARENT index
-- is LOADING. Once the parent flips READY (or FAILED), every chunk under
-- it is immutable -- this is what makes "READY index/chunk 불변성" a real
-- database-enforced invariant, not just an application convention.
CREATE OR REPLACE FUNCTION disclosure_reference.reject_non_loading_retrieval_chunk_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status disclosure_reference.retrieval_index_status;
BEGIN
  SELECT index_status INTO parent_status
  FROM disclosure_reference.reference_retrieval_indexes
  WHERE retrieval_index_id = COALESCE(NEW.retrieval_index_id, OLD.retrieval_index_id)
  FOR SHARE;

  IF FOUND AND parent_status IS DISTINCT FROM 'LOADING' THEN
    RAISE EXCEPTION 'reference retrieval index % is immutable once %', COALESCE(NEW.retrieval_index_id, OLD.retrieval_index_id), parent_status;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS retrieval_chunks_loading_only ON disclosure_reference.reference_retrieval_chunks;
CREATE TRIGGER retrieval_chunks_loading_only
BEFORE INSERT OR UPDATE OR DELETE ON disclosure_reference.reference_retrieval_chunks
FOR EACH ROW EXECUTE FUNCTION disclosure_reference.reject_non_loading_retrieval_chunk_write();

-- Mirrors 002_reference_release.sql's guard_release_transition: only
-- LOADING -> READY (or LOADING -> FAILED) is a legal index_status
-- transition; a READY (or FAILED) row is otherwise fully immutable and can
-- never be deleted. The LOADING -> READY transition additionally requires
-- record_count to equal the ACTUAL chunk row count for this index -- the
-- database itself refuses a READY flip whose declared count disagrees
-- with reality, independent of whatever the loader's own JS-side count
-- check already did.
CREATE OR REPLACE FUNCTION disclosure_reference.guard_retrieval_index_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.index_status IN ('READY', 'FAILED') THEN
    RAISE EXCEPTION 'reference retrieval index % (%) cannot be deleted', OLD.retrieval_index_id, OLD.index_status;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.index_status <> 'LOADING' THEN
      RAISE EXCEPTION 'reference retrieval index % is immutable once %', OLD.retrieval_index_id, OLD.index_status;
    END IF;
    IF NEW.index_status NOT IN ('READY', 'FAILED') THEN
      RAISE EXCEPTION 'only the LOADING -> READY or LOADING -> FAILED retrieval index transition is permitted';
    END IF;

    IF NEW.index_status = 'READY' THEN
      IF NEW.record_count <> (
        SELECT count(*) FROM disclosure_reference.reference_retrieval_chunks
        WHERE retrieval_index_id = NEW.retrieval_index_id
      ) THEN
        RAISE EXCEPTION 'reference retrieval index %: record_count does not match the actual chunk row count', NEW.retrieval_index_id;
      END IF;
    END IF;

    -- Every identity field, snapshot/config pin, and hash pin must be
    -- byte-for-byte the same before and after the transition. Only
    -- index_status, ready_at, and record_count (the exact fields this
    -- transition legitimately sets for the first time) are allowed to
    -- change. IS DISTINCT FROM (not <>) so a NULL <-> non-NULL change is
    -- also caught.
    IF NEW.retrieval_index_id IS DISTINCT FROM OLD.retrieval_index_id
       OR NEW.release_id IS DISTINCT FROM OLD.release_id
       OR NEW.source_snapshot_id IS DISTINCT FROM OLD.source_snapshot_id
       OR NEW.embedding_provider IS DISTINCT FROM OLD.embedding_provider
       OR NEW.embedding_model IS DISTINCT FROM OLD.embedding_model
       OR NEW.embedding_revision IS DISTINCT FROM OLD.embedding_revision
       OR NEW.embedding_dimension IS DISTINCT FROM OLD.embedding_dimension
       OR NEW.distance_metric IS DISTINCT FROM OLD.distance_metric
       OR NEW.chunking_policy_id IS DISTINCT FROM OLD.chunking_policy_id
       OR NEW.chunking_policy_sha256 IS DISTINCT FROM OLD.chunking_policy_sha256
       OR NEW.manifest_sha256 IS DISTINCT FROM OLD.manifest_sha256
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'reference retrieval index identity, snapshot/config pins, and hash pins are immutable across a status transition';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS retrieval_indexes_transition_guard ON disclosure_reference.reference_retrieval_indexes;
CREATE TRIGGER retrieval_indexes_transition_guard
BEFORE UPDATE OR DELETE ON disclosure_reference.reference_retrieval_indexes
FOR EACH ROW EXECUTE FUNCTION disclosure_reference.guard_retrieval_index_transition();

INSERT INTO disclosure_reference.schema_migrations (migration_id)
VALUES ('003_reference_vector_retrieval_v0.1')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
