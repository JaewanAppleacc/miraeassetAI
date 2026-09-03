-- Turn AC-VFINAL-ALIGNMENT-AND-DISCOVERY, section L (continues 009 -- see
-- its header for why this is a separate migration file).
--
-- (a) Extends the active-attempt uniqueness gate (008's partial unique
--     index on retrieval_index_id) to also exclude
--     FAILED_DISCOVERY_RESOURCE_EXHAUSTED rows, alongside
--     SUPERSEDED_ZERO_PROGRESS -- a resource-exhausted attempt must not
--     block a fresh attempt of the same logical load from being created,
--     exactly like a superseded zero-progress one.
-- (b) CREATE OR REPLACE of 008's exact trigger function, plus:
--       - FAILED_DISCOVERY_RESOURCE_EXHAUSTED added alongside
--         READY/FAILED/SUPERSEDED_ZERO_PROGRESS as a terminal, immutable-
--         once-reached status;
--       - one new legal transition, DISCOVERING ->
--         FAILED_DISCOVERY_RESOURCE_EXHAUSTED (this status names a
--         discovery-phase resource exhaustion specifically; it is not a
--         legal target from any other status);
--       - a hard, non-optional guard (never trusted from calling code) that
--         embedded_unique_text_count = 0 AND materialized_chunk_count = 0
--         on OLD -- UNLIKE SUPERSEDED_ZERO_PROGRESS, discovery progress
--         (documents/chunks/unique-text counters) is EXPECTED to be
--         non-zero here and is NOT required to be zero; only embedding and
--         materialization (which this Turn's own instructions forbid
--         running against a resource-exhausted discovery) must be zero.
--
-- ADDITIVE ONLY: replaces the partial index with an equivalent, wider
-- predicate (same underlying btree shape) and CREATE OR REPLACEs the
-- trigger function to recognize one more terminal status. No existing
-- column, row, or non-terminal invariant is altered or loosened.

BEGIN;

DROP INDEX IF EXISTS disclosure_reference.reference_fixed_kure_load_sessions_index_active_idx;
CREATE UNIQUE INDEX IF NOT EXISTS reference_fixed_kure_load_sessions_index_active_idx
  ON disclosure_reference.reference_fixed_kure_load_sessions (retrieval_index_id)
  WHERE status NOT IN ('SUPERSEDED_ZERO_PROGRESS', 'FAILED_DISCOVERY_RESOURCE_EXHAUSTED');

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
    IF OLD.status IN ('READY', 'FAILED', 'SUPERSEDED_ZERO_PROGRESS', 'FAILED_DISCOVERY_RESOURCE_EXHAUSTED') THEN
      RAISE EXCEPTION 'reference fixed/kure load session % is immutable once %', OLD.load_session_id, OLD.status;
    END IF;

    IF NEW.status = OLD.status THEN
      allowed := true; -- progress within the same step (checkpoint/counter updates)
    ELSIF OLD.status = 'CREATED' AND NEW.status IN ('DISCOVERING', 'FAILED', 'SUPERSEDED_ZERO_PROGRESS') THEN
      allowed := true;
    ELSIF OLD.status = 'DISCOVERING' AND NEW.status IN ('DISCOVERY_COMPLETE', 'PAUSED', 'FAILED', 'SUPERSEDED_ZERO_PROGRESS', 'FAILED_DISCOVERY_RESOURCE_EXHAUSTED') THEN
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

    IF NEW.status = 'SUPERSEDED_ZERO_PROGRESS' AND (
         OLD.discovered_document_count <> 0
      OR OLD.discovered_total_chunk_count <> 0
      OR OLD.discovered_search_eligible_count <> 0
      OR OLD.discovered_unique_text_count <> 0
      OR OLD.embedded_unique_text_count <> 0
      OR OLD.materialized_chunk_count <> 0
    ) THEN
      RAISE EXCEPTION 'reference fixed/kure load session %: refusing SUPERSEDED_ZERO_PROGRESS -- progress is non-zero (documents=%, chunks=%, search_eligible=%, unique_text=%, embedded=%, materialized=%)',
        OLD.load_session_id, OLD.discovered_document_count, OLD.discovered_total_chunk_count,
        OLD.discovered_search_eligible_count, OLD.discovered_unique_text_count,
        OLD.embedded_unique_text_count, OLD.materialized_chunk_count;
    END IF;

    IF NEW.status = 'FAILED_DISCOVERY_RESOURCE_EXHAUSTED' AND (
         OLD.embedded_unique_text_count <> 0
      OR OLD.materialized_chunk_count <> 0
    ) THEN
      RAISE EXCEPTION 'reference fixed/kure load session %: refusing FAILED_DISCOVERY_RESOURCE_EXHAUSTED -- embedding/materialization progress is non-zero (embedded=%, materialized=%)',
        OLD.load_session_id, OLD.embedded_unique_text_count, OLD.materialized_chunk_count;
    END IF;

    IF NEW.load_session_id IS DISTINCT FROM OLD.load_session_id
       OR NEW.retrieval_index_id IS DISTINCT FROM OLD.retrieval_index_id
       OR NEW.corpus_snapshot_id IS DISTINCT FROM OLD.corpus_snapshot_id
       OR NEW.corpus_manifest_sha256 IS DISTINCT FROM OLD.corpus_manifest_sha256
       OR NEW.chunking_policy_sha256 IS DISTINCT FROM OLD.chunking_policy_sha256
       OR NEW.embedding_config_sha256 IS DISTINCT FROM OLD.embedding_config_sha256
       OR NEW.logical_load_id IS DISTINCT FROM OLD.logical_load_id
       OR NEW.execution_attempt_id IS DISTINCT FROM OLD.execution_attempt_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'reference fixed/kure load session %: identity and pin columns are immutable', OLD.load_session_id;
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

INSERT INTO disclosure_reference.schema_migrations (migration_id)
VALUES ('010_reference_fixed_kure_failed_resource_exhausted_transition_v0.1')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
