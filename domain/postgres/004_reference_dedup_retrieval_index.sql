-- Disclosure Analyst EXACT_TEXT_DEDUP_INDEX v0.1 (Turn P5.2)
--
-- ADDITIVE ONLY: creates NEW objects alongside 001_core.sql,
-- 002_reference_release.sql, and 003_reference_vector_retrieval.sql. It
-- does not alter, drop, or rename anything any of those migrations
-- created -- 003's reference_retrieval_indexes/reference_retrieval_chunks
-- (VERIFIED_EVIDENCE, 219 rows) keep their exact current meaning and are
-- never touched by this file.
--
-- WHY A SEPARATE TABLE SET (not a retrofit into 003's tables): Turn P5.1
-- (retrieval-index-strategy-comparison.v0.1.json) recommended
-- EXACT_TEXT_DEDUP_INDEX specifically because 003's one-row-per-chunk
-- design has no way to express "many chunk occurrences share one
-- embedding." This migration adds a genuinely two-table shape: ONE
-- canonical (text_sha256 -> embedding) row per DISTINCT text, and ONE
-- occurrence (chunk_id -> text_sha256) row per ORIGINAL Turn P5 chunk --
-- a real foreign key between them, not a convention.
--
-- THE ONE INVARIANT THIS SCHEMA EXISTS TO ENFORCE: a canonical row's own
-- columns are NEVER a valid metadata-filter target for corp_code/
-- source_document_id/etc -- those only ever live on occurrence rows.
-- reference-dedup-retrieval-repository.mjs's search() is written so the
-- occurrence table is filtered BEFORE any join to the canonical table ever
-- happens; this schema does not (and cannot, since canonical_texts carries
-- no corp_code/document_id column at all) allow filtering the other way
-- around.

BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS disclosure_reference;

-- Reuses 003's own retrieval_index_status ENUM (LOADING/READY/FAILED) --
-- identical semantics, no reason to declare a second copy.
DO $$
BEGIN
  CREATE TYPE disclosure_reference.retrieval_index_status AS ENUM ('LOADING', 'READY', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- One row per (release, DocumentIR snapshot, embedding config, chunking
-- policy) combination actually loaded. Mirrors 003's
-- reference_retrieval_indexes almost exactly, with two counts instead of
-- one (canonical_count and occurrence_count are independent -- the whole
-- point of dedup is canonical_count << occurrence_count).
CREATE TABLE IF NOT EXISTS disclosure_reference.reference_dedup_indexes (
  retrieval_index_id text PRIMARY KEY,
  release_id text NOT NULL REFERENCES disclosure_reference.releases(release_id) ON DELETE RESTRICT,
  source_snapshot_id text NOT NULL, -- Turn P5's own docsnap_... id
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
  canonical_count integer NOT NULL DEFAULT 0 CHECK (canonical_count >= 0),
  occurrence_count integer NOT NULL DEFAULT 0 CHECK (occurrence_count >= 0),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (
    (index_status = 'LOADING' AND ready_at IS NULL)
    OR (index_status = 'READY' AND ready_at IS NOT NULL)
    OR (index_status = 'FAILED')
  )
);

-- ONE row per DISTINCT text_sha256 -- this is the entire dedup: no two
-- rows under the same index may share a text_sha256 (enforced by the
-- primary key itself, not just application discipline). `canonical_text`
-- is byte-identical to every occurrence's own text_content (that is what
-- "exact duplicate" means) -- never a summary, never rewritten.
--
-- Deliberately carries NO corp_code / source_document_id / source_kind
-- column: a canonical row is shared by definition across every document
-- (and possibly every company) whose text happens to match, so it must
-- never be the target of a per-document/per-company metadata filter.
CREATE TABLE IF NOT EXISTS disclosure_reference.reference_dedup_canonical_texts (
  retrieval_index_id text NOT NULL REFERENCES disclosure_reference.reference_dedup_indexes(retrieval_index_id) ON DELETE CASCADE,
  text_sha256 text NOT NULL CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
  canonical_text text NOT NULL CHECK (length(canonical_text) > 0),
  char_length integer NOT NULL CHECK (char_length > 0),
  embedding_config_hash text NOT NULL CHECK (embedding_config_hash ~ '^[0-9a-f]{64}$'),
  embedding vector NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (retrieval_index_id, text_sha256)
);

-- ONE row per ORIGINAL Turn P5 chunk (chunk_id is already globally unique
-- across the whole 1,874,688-row snapshot -- see
-- tests/document-retrieval-snapshot-build.test.mjs's own chunk_id
-- uniqueness proof). Every provenance/metadata field a Retriever result
-- needs lives HERE, never on the canonical row.
CREATE TABLE IF NOT EXISTS disclosure_reference.reference_dedup_occurrences (
  retrieval_index_id text NOT NULL REFERENCES disclosure_reference.reference_dedup_indexes(retrieval_index_id) ON DELETE CASCADE,
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
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (retrieval_index_id, chunk_id),
  -- A composite FK into the canonical table under the SAME index -- an
  -- occurrence can never reference a canonical row that does not (yet, or
  -- ever) exist under this index. This is the database-enforced half of
  -- "occurrence -> canonical" provenance; the loader's own pre-embedding
  -- pass is the other half (see reference-dedup-retrieval-loader.mjs).
  FOREIGN KEY (retrieval_index_id, text_sha256)
    REFERENCES disclosure_reference.reference_dedup_canonical_texts(retrieval_index_id, text_sha256)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS reference_dedup_occurrences_document_idx
  ON disclosure_reference.reference_dedup_occurrences (retrieval_index_id, source_document_id);
CREATE INDEX IF NOT EXISTS reference_dedup_occurrences_corp_idx
  ON disclosure_reference.reference_dedup_occurrences (retrieval_index_id, corp_code)
  WHERE corp_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS reference_dedup_occurrences_text_idx
  ON disclosure_reference.reference_dedup_occurrences (retrieval_index_id, text_sha256);

-- Mirrors 003's check_retrieval_chunk_dimension exactly.
CREATE OR REPLACE FUNCTION disclosure_reference.check_dedup_canonical_dimension()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_dim integer;
  actual_dim integer;
BEGIN
  SELECT embedding_dimension INTO expected_dim
  FROM disclosure_reference.reference_dedup_indexes
  WHERE retrieval_index_id = NEW.retrieval_index_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'reference_dedup_canonical_texts: unknown retrieval_index_id %', NEW.retrieval_index_id;
  END IF;

  actual_dim := vector_dims(NEW.embedding);
  IF actual_dim IS DISTINCT FROM expected_dim THEN
    RAISE EXCEPTION 'reference_dedup_canonical_texts: embedding dimension % does not match index %''s pinned embedding_dimension %',
      actual_dim, NEW.retrieval_index_id, expected_dim;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS dedup_canonical_dimension_check ON disclosure_reference.reference_dedup_canonical_texts;
CREATE TRIGGER dedup_canonical_dimension_check
BEFORE INSERT OR UPDATE ON disclosure_reference.reference_dedup_canonical_texts
FOR EACH ROW EXECUTE FUNCTION disclosure_reference.check_dedup_canonical_dimension();

-- Mirrors 003's reject_non_loading_retrieval_chunk_write, applied to BOTH
-- child tables via one shared function (parameterized only by which table
-- fired it, via TG_TABLE_NAME -- purely for the error message).
CREATE OR REPLACE FUNCTION disclosure_reference.reject_non_loading_dedup_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status disclosure_reference.retrieval_index_status;
BEGIN
  SELECT index_status INTO parent_status
  FROM disclosure_reference.reference_dedup_indexes
  WHERE retrieval_index_id = COALESCE(NEW.retrieval_index_id, OLD.retrieval_index_id)
  FOR SHARE;

  IF FOUND AND parent_status IS DISTINCT FROM 'LOADING' THEN
    RAISE EXCEPTION '% row under reference retrieval index % is immutable once %',
      TG_TABLE_NAME, COALESCE(NEW.retrieval_index_id, OLD.retrieval_index_id), parent_status;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS dedup_canonical_loading_only ON disclosure_reference.reference_dedup_canonical_texts;
CREATE TRIGGER dedup_canonical_loading_only
BEFORE INSERT OR UPDATE OR DELETE ON disclosure_reference.reference_dedup_canonical_texts
FOR EACH ROW EXECUTE FUNCTION disclosure_reference.reject_non_loading_dedup_write();

DROP TRIGGER IF EXISTS dedup_occurrences_loading_only ON disclosure_reference.reference_dedup_occurrences;
CREATE TRIGGER dedup_occurrences_loading_only
BEFORE INSERT OR UPDATE OR DELETE ON disclosure_reference.reference_dedup_occurrences
FOR EACH ROW EXECUTE FUNCTION disclosure_reference.reject_non_loading_dedup_write();

-- Mirrors 003's guard_retrieval_index_transition, extended to check BOTH
-- canonical_count and occurrence_count against their real row counts
-- before allowing LOADING -> READY (the whole point of the dedup
-- invariant: these two counts are independent and BOTH must be exactly
-- right, not just one).
CREATE OR REPLACE FUNCTION disclosure_reference.guard_dedup_index_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.index_status IN ('READY', 'FAILED') THEN
    RAISE EXCEPTION 'reference dedup index % (%) cannot be deleted', OLD.retrieval_index_id, OLD.index_status;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.index_status <> 'LOADING' THEN
      RAISE EXCEPTION 'reference dedup index % is immutable once %', OLD.retrieval_index_id, OLD.index_status;
    END IF;
    IF NEW.index_status NOT IN ('READY', 'FAILED') THEN
      RAISE EXCEPTION 'only the LOADING -> READY or LOADING -> FAILED dedup index transition is permitted';
    END IF;

    IF NEW.index_status = 'READY' THEN
      IF NEW.canonical_count <> (
        SELECT count(*) FROM disclosure_reference.reference_dedup_canonical_texts
        WHERE retrieval_index_id = NEW.retrieval_index_id
      ) THEN
        RAISE EXCEPTION 'reference dedup index %: canonical_count does not match the actual canonical row count', NEW.retrieval_index_id;
      END IF;
      IF NEW.occurrence_count <> (
        SELECT count(*) FROM disclosure_reference.reference_dedup_occurrences
        WHERE retrieval_index_id = NEW.retrieval_index_id
      ) THEN
        RAISE EXCEPTION 'reference dedup index %: occurrence_count does not match the actual occurrence row count', NEW.retrieval_index_id;
      END IF;
    END IF;

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
      RAISE EXCEPTION 'reference dedup index identity, snapshot/config pins, and hash pins are immutable across a status transition';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS dedup_indexes_transition_guard ON disclosure_reference.reference_dedup_indexes;
CREATE TRIGGER dedup_indexes_transition_guard
BEFORE UPDATE OR DELETE ON disclosure_reference.reference_dedup_indexes
FOR EACH ROW EXECUTE FUNCTION disclosure_reference.guard_dedup_index_transition();

INSERT INTO disclosure_reference.schema_migrations (migration_id)
VALUES ('004_reference_dedup_retrieval_index_v0.1')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
