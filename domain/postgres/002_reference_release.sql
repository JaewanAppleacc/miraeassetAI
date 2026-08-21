-- Disclosure Analyst portable release reference store v0.1
--
-- This schema is the immutable PostgreSQL landing zone for a fully verified
-- portable release bundle.  The bundle remains the portable source artifact;
-- after import, PostgreSQL is the runtime source of record shared by agents.
-- Search-specific tables, embeddings, BM25 indexes, and worker-owned features
-- belong in separate schemas and are intentionally absent here.

BEGIN;

CREATE SCHEMA IF NOT EXISTS disclosure_reference;

CREATE TABLE IF NOT EXISTS disclosure_reference.schema_migrations (
  migration_id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  CREATE TYPE disclosure_reference.import_status AS ENUM ('LOADING', 'READY');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS disclosure_reference.releases (
  release_id text PRIMARY KEY,
  status disclosure_reference.import_status NOT NULL,
  approved_revision text NOT NULL,
  corpus_snapshot_id text NOT NULL,
  fact_coverage_snapshot_id text,
  bundle_manifest_sha256 text NOT NULL CHECK (bundle_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  final_manifest_sha256 text NOT NULL CHECK (final_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  final_decision_sha256 text NOT NULL CHECK (final_decision_sha256 ~ '^[0-9a-f]{64}$'),
  bundle_entry_count integer NOT NULL CHECK (bundle_entry_count > 0),
  record_counts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(record_counts) = 'object'),
  bundle_manifest jsonb NOT NULL CHECK (jsonb_typeof(bundle_manifest) = 'object'),
  final_manifest jsonb NOT NULL CHECK (jsonb_typeof(final_manifest) = 'object'),
  final_decision jsonb NOT NULL CHECK (jsonb_typeof(final_decision) = 'object'),
  imported_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'LOADING' AND imported_at IS NULL) OR (status = 'READY' AND imported_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS disclosure_reference.artifacts (
  release_id text NOT NULL REFERENCES disclosure_reference.releases(release_id) ON DELETE CASCADE,
  role text NOT NULL,
  bundle_path text NOT NULL,
  source_path text NOT NULL,
  compression text NOT NULL CHECK (compression IN ('none', 'gzip')),
  encoded_sha256 text CHECK (encoded_sha256 IS NULL OR encoded_sha256 ~ '^[0-9a-f]{64}$'),
  decoded_sha256 text NOT NULL CHECK (decoded_sha256 ~ '^[0-9a-f]{64}$'),
  encoded_bytes bigint CHECK (encoded_bytes IS NULL OR encoded_bytes >= 0),
  decoded_bytes bigint NOT NULL CHECK (decoded_bytes >= 0),
  declared_record_count integer CHECK (declared_record_count IS NULL OR declared_record_count >= 0),
  loaded_record_count integer NOT NULL CHECK (loaded_record_count >= 0),
  PRIMARY KEY (release_id, role),
  UNIQUE (release_id, bundle_path),
  UNIQUE (release_id, source_path)
);

CREATE TABLE IF NOT EXISTS disclosure_reference.records (
  release_id text NOT NULL,
  role text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  record_key text NOT NULL,
  corp_code text,
  document_id text,
  question_id text,
  metric_code text,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  PRIMARY KEY (release_id, role, ordinal),
  UNIQUE (release_id, role, record_key),
  FOREIGN KEY (release_id, role)
    REFERENCES disclosure_reference.artifacts(release_id, role) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS reference_records_key_idx
  ON disclosure_reference.records (record_key);
CREATE INDEX IF NOT EXISTS reference_records_document_idx
  ON disclosure_reference.records (document_id) WHERE document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS reference_records_company_metric_idx
  ON disclosure_reference.records (corp_code, metric_code)
  WHERE corp_code IS NOT NULL OR metric_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS reference_records_question_idx
  ON disclosure_reference.records (question_id) WHERE question_id IS NOT NULL;

CREATE OR REPLACE FUNCTION disclosure_reference.reject_non_loading_child_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status disclosure_reference.import_status;
BEGIN
  SELECT status INTO parent_status
  FROM disclosure_reference.releases
  WHERE release_id = COALESCE(NEW.release_id, OLD.release_id)
  FOR SHARE;

  -- Turn N1.2: real PostgreSQL 16 execution reproduced a genuine defect
  -- here -- deleting a LOADING release row (e.g. to clean up an
  -- abandoned/orphaned load) cascades to this table via ON DELETE
  -- CASCADE, and by the time THIS row's own BEFORE DELETE fires, the
  -- parent releases row is already gone from a fresh SELECT (cascade
  -- ordering), so the SELECT above returns no rows and parent_status
  -- stays NULL -- which "IS DISTINCT FROM 'LOADING'" (NULL is distinct
  -- from everything), incorrectly raising "immutable once READY" for a
  -- release that was never READY at all. `FOUND` (set by the SELECT INTO
  -- immediately above) distinguishes the two cases: FOUND=false means no
  -- parent row is visible, which can ONLY happen here because it is
  -- mid-cascade from a releases-level DELETE that guard_release_transition's
  -- OWN "READY reference release % cannot be deleted" check has already
  -- independently allowed -- i.e. the parent was proven non-READY (so,
  -- LOADING) before this trigger ever ran. A READY release is NEVER
  -- deleted (that path always raises first), so this relaxation cannot
  -- let a READY release's children be touched -- when the parent row IS
  -- found (the ordinary INSERT/UPDATE/DELETE-without-cascade case), its
  -- real status is still checked exactly as before.
  IF FOUND AND parent_status IS DISTINCT FROM 'LOADING' THEN
    RAISE EXCEPTION 'reference release % is immutable once READY', COALESCE(NEW.release_id, OLD.release_id);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS artifacts_loading_only ON disclosure_reference.artifacts;
CREATE TRIGGER artifacts_loading_only
BEFORE INSERT OR UPDATE OR DELETE ON disclosure_reference.artifacts
FOR EACH ROW EXECUTE FUNCTION disclosure_reference.reject_non_loading_child_write();

DROP TRIGGER IF EXISTS records_loading_only ON disclosure_reference.records;
CREATE TRIGGER records_loading_only
BEFORE INSERT OR UPDATE OR DELETE ON disclosure_reference.records
FOR EACH ROW EXECUTE FUNCTION disclosure_reference.reject_non_loading_child_write();

CREATE OR REPLACE FUNCTION disclosure_reference.guard_release_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.status = 'READY' THEN
    RAISE EXCEPTION 'READY reference release % cannot be deleted', OLD.release_id;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'LOADING' OR NEW.status <> 'READY' THEN
      RAISE EXCEPTION 'only the LOADING -> READY reference release transition is permitted';
    END IF;
    -- Turn N1.1: the DB itself -- not just the loader's own application
    -- code -- refuses a READY transition whose artifact/record counts
    -- are internally inconsistent. This is a second, independent layer:
    -- even a bug or a hand-crafted UPDATE that bypasses collectReferenceReleaseRecords's
    -- own JS-side count checks cannot flip a release READY with a wrong
    -- artifact count, a loaded_record_count that disagrees with the real
    -- row count, a declared_record_count the loader ignored, or a
    -- record_counts summary that doesn't match reality.
    IF (SELECT count(*) FROM disclosure_reference.artifacts WHERE release_id = NEW.release_id) <> NEW.bundle_entry_count THEN
      RAISE EXCEPTION 'reference release %: artifact row count does not match bundle_entry_count', NEW.release_id;
    END IF;
    IF EXISTS (
      SELECT 1 FROM disclosure_reference.artifacts a
      WHERE a.release_id = NEW.release_id
        AND a.loaded_record_count <> (
          SELECT count(*) FROM disclosure_reference.records r
          WHERE r.release_id = a.release_id AND r.role = a.role
        )
    ) THEN
      RAISE EXCEPTION 'reference release %: an artifact''s loaded_record_count does not match its actual record row count', NEW.release_id;
    END IF;
    IF EXISTS (
      SELECT 1 FROM disclosure_reference.artifacts a
      WHERE a.release_id = NEW.release_id
        AND a.declared_record_count IS NOT NULL
        AND a.declared_record_count <> a.loaded_record_count
    ) THEN
      RAISE EXCEPTION 'reference release %: an artifact''s declared_record_count does not match its loaded_record_count', NEW.release_id;
    END IF;
    IF NEW.record_counts <> (
      SELECT COALESCE(jsonb_object_agg(t.role, t.cnt), '{}'::jsonb)
      FROM (
        SELECT role, count(*) AS cnt
        FROM disclosure_reference.records
        WHERE release_id = NEW.release_id
        GROUP BY role
      ) t
    ) THEN
      RAISE EXCEPTION 'reference release %: record_counts does not match the actual per-role record aggregation', NEW.release_id;
    END IF;
    -- Every identity field, snapshot id, hash pin, entry count, and raw
    -- control-file payload must be byte-for-byte the same before and
    -- after the LOADING -> READY flip. Only status, record_counts (the
    -- per-role tally, legitimately populated for the first time by this
    -- exact transition), and imported_at are allowed to change.
    -- IS DISTINCT FROM (not <>) is used throughout so a NULL <-> non-NULL
    -- change on the nullable columns (fact_coverage_snapshot_id) is
    -- caught too -- plain <> silently evaluates to NULL (never TRUE) when
    -- either side is NULL, which would let such a change through unnoticed.
    IF NEW.release_id IS DISTINCT FROM OLD.release_id
       OR NEW.approved_revision IS DISTINCT FROM OLD.approved_revision
       OR NEW.corpus_snapshot_id IS DISTINCT FROM OLD.corpus_snapshot_id
       OR NEW.fact_coverage_snapshot_id IS DISTINCT FROM OLD.fact_coverage_snapshot_id
       OR NEW.bundle_manifest_sha256 IS DISTINCT FROM OLD.bundle_manifest_sha256
       OR NEW.final_manifest_sha256 IS DISTINCT FROM OLD.final_manifest_sha256
       OR NEW.final_decision_sha256 IS DISTINCT FROM OLD.final_decision_sha256
       OR NEW.bundle_entry_count IS DISTINCT FROM OLD.bundle_entry_count
       OR NEW.bundle_manifest IS DISTINCT FROM OLD.bundle_manifest
       OR NEW.final_manifest IS DISTINCT FROM OLD.final_manifest
       OR NEW.final_decision IS DISTINCT FROM OLD.final_decision
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'reference release identity, snapshot ids, hash pins, entry count, and control-file payloads are immutable across the LOADING -> READY transition';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS releases_transition_guard ON disclosure_reference.releases;
CREATE TRIGGER releases_transition_guard
BEFORE UPDATE OR DELETE ON disclosure_reference.releases
FOR EACH ROW EXECUTE FUNCTION disclosure_reference.guard_release_transition();

CREATE OR REPLACE VIEW disclosure_reference.verified_facts AS
SELECT release_id, record_key AS fact_id, corp_code, document_id AS source_document_id,
       metric_code, payload
FROM disclosure_reference.records
WHERE role = 'VERIFIED_FACT';

CREATE OR REPLACE VIEW disclosure_reference.verified_evidence AS
SELECT release_id, record_key AS evidence_id, document_id, payload
FROM disclosure_reference.records
WHERE role = 'VERIFIED_EVIDENCE';

CREATE OR REPLACE VIEW disclosure_reference.verified_events AS
SELECT release_id, record_key AS event_id, corp_code, document_id AS anchor_document_id,
       payload
FROM disclosure_reference.records
WHERE role = 'VERIFIED_EVENT';

CREATE OR REPLACE VIEW disclosure_reference.verified_relations AS
SELECT release_id, record_key AS relation_id, document_id AS source_document_id,
       payload
FROM disclosure_reference.records
WHERE role = 'VERIFIED_RELATION';

INSERT INTO disclosure_reference.schema_migrations (migration_id)
VALUES ('002_reference_release_v0.1')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
