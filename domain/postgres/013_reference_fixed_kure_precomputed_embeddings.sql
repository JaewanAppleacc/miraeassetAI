-- Turn AC-VECTOR-IMPORT-V1: additive support for importing an already
-- verified full-population KURE result without copying or mutating the
-- terminal discovery attempt's staging rows.
BEGIN;

ALTER TABLE disclosure_reference.reference_fixed_kure_load_sessions
  ADD COLUMN IF NOT EXISTS discovery_source_load_session_id text
    REFERENCES disclosure_reference.reference_fixed_kure_load_sessions(load_session_id) ON DELETE RESTRICT;

ALTER TABLE disclosure_reference.reference_fixed_kure_load_sessions
  ADD COLUMN IF NOT EXISTS precomputed_materialization_cursor_chunk_id text;

CREATE OR REPLACE FUNCTION disclosure_reference.guard_fixed_kure_discovery_source_link()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.discovery_source_load_session_id IS DISTINCT FROM OLD.discovery_source_load_session_id THEN
    IF NOT (
      OLD.discovery_source_load_session_id IS NULL
      AND OLD.status = 'CREATED'
      AND NEW.status = 'DISCOVERING'
      AND NEW.discovery_source_load_session_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'reference fixed/kure load session %: discovery source link is immutable and may only be set while entering DISCOVERING', OLD.load_session_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fixed_kure_discovery_source_link_guard
  ON disclosure_reference.reference_fixed_kure_load_sessions;
CREATE TRIGGER fixed_kure_discovery_source_link_guard
BEFORE UPDATE ON disclosure_reference.reference_fixed_kure_load_sessions
FOR EACH ROW EXECUTE FUNCTION disclosure_reference.guard_fixed_kure_discovery_source_link();

CREATE TABLE IF NOT EXISTS disclosure_reference.reference_fixed_kure_precomputed_embeddings (
  load_session_id text NOT NULL
    REFERENCES disclosure_reference.reference_fixed_kure_load_sessions(load_session_id) ON DELETE RESTRICT,
  embedding_input_id text NOT NULL CHECK (embedding_input_id ~ '^embin_[0-9a-f]{24}$'),
  global_eligible_index bigint NOT NULL CHECK (global_eligible_index >= 0),
  embed_text_sha256 text NOT NULL CHECK (embed_text_sha256 ~ '^[0-9a-f]{64}$'),
  embedding vector NOT NULL,
  source_shard_index integer NOT NULL CHECK (source_shard_index >= 0),
  source_result_manifest_sha256 text NOT NULL CHECK (source_result_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (load_session_id, embed_text_sha256),
  UNIQUE (load_session_id, embedding_input_id),
  UNIQUE (load_session_id, global_eligible_index)
);

CREATE INDEX IF NOT EXISTS reference_fixed_kure_precomputed_embeddings_shard_idx
  ON disclosure_reference.reference_fixed_kure_precomputed_embeddings(load_session_id, source_shard_index);

CREATE OR REPLACE FUNCTION disclosure_reference.check_fixed_kure_precomputed_embedding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_row disclosure_reference.reference_fixed_kure_load_sessions%ROWTYPE;
BEGIN
  SELECT * INTO session_row
  FROM disclosure_reference.reference_fixed_kure_load_sessions
  WHERE load_session_id = NEW.load_session_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'precomputed embedding: unknown load_session_id %', NEW.load_session_id;
  END IF;
  IF session_row.status <> 'EMBEDDING' THEN
    RAISE EXCEPTION 'precomputed embedding: load session % must be EMBEDDING, got %', NEW.load_session_id, session_row.status;
  END IF;
  IF session_row.discovery_source_load_session_id IS NULL THEN
    RAISE EXCEPTION 'precomputed embedding: load session % has no pinned discovery source', NEW.load_session_id;
  END IF;
  IF vector_dims(NEW.embedding) IS DISTINCT FROM session_row.embedding_dimension THEN
    RAISE EXCEPTION 'precomputed embedding: dimension % does not match session % dimension %',
      vector_dims(NEW.embedding), NEW.load_session_id, session_row.embedding_dimension;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fixed_kure_precomputed_embedding_check
  ON disclosure_reference.reference_fixed_kure_precomputed_embeddings;
CREATE TRIGGER fixed_kure_precomputed_embedding_check
BEFORE INSERT OR UPDATE ON disclosure_reference.reference_fixed_kure_precomputed_embeddings
FOR EACH ROW EXECUTE FUNCTION disclosure_reference.check_fixed_kure_precomputed_embedding();

CREATE TABLE IF NOT EXISTS disclosure_reference.reference_fixed_kure_precomputed_embedding_shards (
  load_session_id text NOT NULL
    REFERENCES disclosure_reference.reference_fixed_kure_load_sessions(load_session_id) ON DELETE RESTRICT,
  shard_index integer NOT NULL CHECK (shard_index >= 0),
  row_count integer NOT NULL CHECK (row_count > 0),
  global_start_index bigint NOT NULL CHECK (global_start_index >= 0),
  global_end_index bigint NOT NULL CHECK (global_end_index >= global_start_index),
  result_manifest_sha256 text NOT NULL CHECK (result_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  vectors_sha256 text NOT NULL CHECK (vectors_sha256 ~ '^[0-9a-f]{64}$'),
  mapping_sha256 text NOT NULL CHECK (mapping_sha256 ~ '^[0-9a-f]{64}$'),
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (load_session_id, shard_index),
  CHECK (global_end_index - global_start_index + 1 = row_count)
);

-- Atomically binds a zero-progress successor to a terminal discovery source.
-- The source rows remain under the source attempt and are never updated.
CREATE OR REPLACE FUNCTION disclosure_reference.inherit_fixed_kure_discovery(
  successor_id text,
  source_id text
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  successor disclosure_reference.reference_fixed_kure_load_sessions%ROWTYPE;
  source disclosure_reference.reference_fixed_kure_load_sessions%ROWTYPE;
  eligible_chunk_count integer;
  eligible_unique_count integer;
BEGIN
  SELECT * INTO successor FROM disclosure_reference.reference_fixed_kure_load_sessions
  WHERE load_session_id = successor_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'successor attempt % does not exist', successor_id; END IF;

  SELECT * INTO source FROM disclosure_reference.reference_fixed_kure_load_sessions
  WHERE load_session_id = source_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'discovery source attempt % does not exist', source_id; END IF;

  IF successor.status <> 'CREATED'
     OR successor.discovered_document_count <> 0
     OR successor.discovered_total_chunk_count <> 0
     OR successor.discovered_search_eligible_count <> 0
     OR successor.discovered_unique_text_count <> 0
     OR successor.embedded_unique_text_count <> 0
     OR successor.materialized_chunk_count <> 0 THEN
    RAISE EXCEPTION 'successor attempt % is not pristine CREATED/zero-progress', successor_id;
  END IF;
  IF source.status <> 'INVALID_DISCOVERY_CANONICAL_SCOPE' THEN
    RAISE EXCEPTION 'discovery source % must be INVALID_DISCOVERY_CANONICAL_SCOPE, got %', source_id, source.status;
  END IF;
  IF successor.supersedes_load_session_id IS DISTINCT FROM source_id
     OR successor.logical_load_id IS DISTINCT FROM source.logical_load_id
     OR successor.retrieval_index_id IS DISTINCT FROM source.retrieval_index_id
     OR successor.corpus_snapshot_id IS DISTINCT FROM source.corpus_snapshot_id
     OR successor.corpus_manifest_sha256 IS DISTINCT FROM source.corpus_manifest_sha256
     OR successor.chunking_policy_id IS DISTINCT FROM source.chunking_policy_id
     OR successor.chunking_policy_sha256 IS DISTINCT FROM source.chunking_policy_sha256
     OR successor.embedding_config_sha256 IS DISTINCT FROM source.embedding_config_sha256 THEN
    RAISE EXCEPTION 'successor/source provenance or immutable pins do not match';
  END IF;
  IF source.pass1_chunk_stream_sha256 IS NULL
     OR source.pass1_chunk_stream_sha256 IS DISTINCT FROM source.pass2_chunk_stream_sha256 THEN
    RAISE EXCEPTION 'discovery source % has no verified double-pass stream SHA', source_id;
  END IF;

  SELECT count(*)::int, count(DISTINCT embed_text_sha256)::int
    INTO eligible_chunk_count, eligible_unique_count
  FROM disclosure_reference.reference_fixed_kure_chunk_staging
  WHERE load_session_id = source_id AND retrieval_eligible;

  IF eligible_chunk_count <> source.discovered_search_eligible_count THEN
    RAISE EXCEPTION 'discovery source eligible chunk count mismatch: actual %, recorded %',
      eligible_chunk_count, source.discovered_search_eligible_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT DISTINCT embed_text_sha256
      FROM disclosure_reference.reference_fixed_kure_chunk_staging
      WHERE load_session_id = source_id AND retrieval_eligible
    ) eligible
    LEFT JOIN disclosure_reference.reference_fixed_kure_canonical_queue q
      ON q.load_session_id = source_id AND q.embed_text_sha256 = eligible.embed_text_sha256
    WHERE q.embed_text_sha256 IS NULL
  ) THEN
    RAISE EXCEPTION 'discovery source has eligible hashes missing from canonical queue';
  END IF;

  UPDATE disclosure_reference.reference_fixed_kure_load_sessions
  SET status = 'DISCOVERING',
      discovery_source_load_session_id = source_id,
      source_files_progress = source.source_files_progress,
      discovery_pass_number = 2,
      pass1_chunk_stream_sha256 = source.pass1_chunk_stream_sha256,
      pass2_chunk_stream_sha256 = source.pass2_chunk_stream_sha256,
      discovered_document_count = source.discovered_document_count,
      discovered_total_chunk_count = eligible_chunk_count,
      discovered_search_eligible_count = eligible_chunk_count,
      discovered_unique_text_count = eligible_unique_count
  WHERE load_session_id = successor_id;

  UPDATE disclosure_reference.reference_fixed_kure_load_sessions
  SET status = 'DISCOVERY_COMPLETE',
      expected_document_count = discovered_document_count,
      expected_total_chunk_count = discovered_total_chunk_count,
      expected_search_eligible_count = discovered_search_eligible_count,
      expected_unique_embeddable_count = discovered_unique_text_count
  WHERE load_session_id = successor_id;
END;
$$;

INSERT INTO disclosure_reference.schema_migrations (migration_id)
VALUES ('013_reference_fixed_kure_precomputed_embeddings_v0.1')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
