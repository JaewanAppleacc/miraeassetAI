-- Turn AC-FULL-LOAD-V2: splits 006's single load_session_id identity into
-- two explicit concepts on the SAME table/row (no rename, no new table):
--
--   logical_load_id     -- corpus_snapshot_id + chunking_policy_sha256 +
--                           embedding_config_sha256 (what 006's
--                           computeFixedKureLoadSessionId already hashed --
--                           unchanged formula, now given its own column and
--                           name instead of being conflated with the row's
--                           own primary key)
--   execution_attempt_id -- logical_load_id + loader_contract_version +
--                           code_revision (006's code_revision column,
--                           reused as-is -- this loader's own immutable
--                           loader-code-SHA signal; no redundant column
--                           added for it)
--
-- For every row that predates this migration, v1 never distinguished the
-- two -- exactly one attempt ever existed per logical load, and that
-- attempt's load_session_id already equalled computeFixedKureLoadSessionId
-- (the logical hash). Backfill therefore sets BOTH new columns equal to the
-- existing load_session_id for old rows: this is not a guess, it is what
-- v1's own invariant already meant. New rows created going forward by the
-- v2 API set load_session_id = execution_attempt_id (a hash that ALSO
-- folds in loader_contract_version + code_revision, unlike 006's formula)
-- and logical_load_id separately, so two attempts of the SAME logical load
-- under two different code_revisions now get two DIFFERENT rows/PKs
-- instead of colliding into 006's CODE_REVISION_MISMATCH fail-closed
-- refusal (still fail-closed today for any caller not yet using the v2
-- attempt-scoped id -- unchanged, additive).
--
-- retrieval_index_id is DELIBERATELY NOT made attempt-scoped: it names the
-- eventual MATERIALIZED index (003's reference_retrieval_indexes /
-- reference_retrieval_chunks), which is properly identified by logical
-- pins alone -- two attempts of the same logical load that both eventually
-- succeed must materialize into the SAME retrieval index, not two. What
-- changes is the uniqueness rule: 006's plain UNIQUE(retrieval_index_id)
-- allowed only one row ever to hold a given retrieval_index_id, at any
-- status; this migration narrows that to only ACTIVE (non-superseded)
-- rows, via a partial unique index, so a fresh attempt may reuse the same
-- retrieval_index_id once its zero-progress predecessor is superseded.
--
-- supersedes_load_session_id records provenance: which prior (necessarily
-- zero-progress, necessarily abandoned) row this attempt's creation was
-- predicated on superseding, if any. Nullable; set once, on the SUPERSEDED
-- row itself is never set (a row cannot supersede itself) -- it is set on
-- the *new* row that follows a supersession, pointing back at the
-- superseded one.
--
-- ADDITIVE ONLY: new nullable-then-backfilled columns, a replaced (not
-- dropped-and-gone) uniqueness rule, and a CREATE OR REPLACE of 006's
-- existing trigger function to recognize one more terminal status
-- (007's SUPERSEDED_ZERO_PROGRESS, already committed). No existing column,
-- row, or non-superseded invariant is altered or loosened.

BEGIN;

ALTER TABLE disclosure_reference.reference_fixed_kure_load_sessions
  ADD COLUMN IF NOT EXISTS logical_load_id text,
  ADD COLUMN IF NOT EXISTS execution_attempt_id text,
  ADD COLUMN IF NOT EXISTS loader_contract_version text,
  ADD COLUMN IF NOT EXISTS supersedes_load_session_id text
    REFERENCES disclosure_reference.reference_fixed_kure_load_sessions(load_session_id);

-- 006's trigger makes READY/FAILED rows fully immutable -- correctly, for
-- every ordinary write path. This one-time backfill of a purely-additive,
-- purely-derived column (logical_load_id/execution_attempt_id both equal
-- the row's own existing load_session_id for every pre-v2 row -- see
-- header) is a schema migration, not an ordinary write, so the guard is
-- disabled for exactly these two UPDATE statements and re-enabled
-- immediately after, inside the same transaction -- if anything below
-- fails, ROLLBACK restores the trigger along with everything else.
ALTER TABLE disclosure_reference.reference_fixed_kure_load_sessions
  DISABLE TRIGGER fixed_kure_load_sessions_transition_guard;

UPDATE disclosure_reference.reference_fixed_kure_load_sessions
SET logical_load_id = load_session_id
WHERE logical_load_id IS NULL;

UPDATE disclosure_reference.reference_fixed_kure_load_sessions
SET execution_attempt_id = load_session_id
WHERE execution_attempt_id IS NULL;

ALTER TABLE disclosure_reference.reference_fixed_kure_load_sessions
  ENABLE TRIGGER fixed_kure_load_sessions_transition_guard;

ALTER TABLE disclosure_reference.reference_fixed_kure_load_sessions
  ALTER COLUMN logical_load_id SET NOT NULL,
  ALTER COLUMN execution_attempt_id SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE disclosure_reference.reference_fixed_kure_load_sessions
    ADD CONSTRAINT reference_fixed_kure_load_sessions_attempt_id_key UNIQUE (execution_attempt_id);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Replaces 006's plain UNIQUE(retrieval_index_id) index with a partial one
-- scoped to non-superseded rows (see header). Same underlying btree shape,
-- narrower predicate only.
DROP INDEX IF EXISTS disclosure_reference.reference_fixed_kure_load_sessions_index_idx;
CREATE UNIQUE INDEX IF NOT EXISTS reference_fixed_kure_load_sessions_index_active_idx
  ON disclosure_reference.reference_fixed_kure_load_sessions (retrieval_index_id)
  WHERE status <> 'SUPERSEDED_ZERO_PROGRESS';

-- CREATE OR REPLACE of 006's exact trigger function, plus:
--   (a) SUPERSEDED_ZERO_PROGRESS added alongside READY/FAILED as a terminal,
--       immutable-once-reached status;
--   (b) two new legal transitions into it -- CREATED -> SUPERSEDED_ZERO_PROGRESS
--       and DISCOVERING -> SUPERSEDED_ZERO_PROGRESS -- each additionally
--       guarded by a hard, non-optional check that every discovered/
--       embedded/materialized counter on OLD is exactly zero (this is the
--       actual "0%" enforcement; nothing upstream in application code is
--       trusted to have already verified it);
--   (c) logical_load_id/execution_attempt_id added to the existing
--       identity/pin immutability list (006's own last IF block).
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
    IF OLD.status IN ('READY', 'FAILED', 'SUPERSEDED_ZERO_PROGRESS') THEN
      RAISE EXCEPTION 'reference fixed/kure load session % is immutable once %', OLD.load_session_id, OLD.status;
    END IF;

    IF NEW.status = OLD.status THEN
      allowed := true; -- progress within the same step (checkpoint/counter updates)
    ELSIF OLD.status = 'CREATED' AND NEW.status IN ('DISCOVERING', 'FAILED', 'SUPERSEDED_ZERO_PROGRESS') THEN
      allowed := true;
    ELSIF OLD.status = 'DISCOVERING' AND NEW.status IN ('DISCOVERY_COMPLETE', 'PAUSED', 'FAILED', 'SUPERSEDED_ZERO_PROGRESS') THEN
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
VALUES ('008_reference_fixed_kure_load_sessions_v2_identity_v0.1')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
