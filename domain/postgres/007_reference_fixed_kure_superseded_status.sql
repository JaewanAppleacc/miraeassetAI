-- Turn AC-FULL-LOAD-V2: adds ONE new terminal status value,
-- SUPERSEDED_ZERO_PROGRESS, to 006's
-- disclosure_reference.fixed_kure_load_session_status enum.
--
-- WHY ITS OWN MIGRATION FILE, SEPARATE FROM 008: PostgreSQL forbids using a
-- freshly ALTER TYPE ... ADD VALUE'd enum label inside the SAME transaction
-- that added it (the label is not visible to other statements, including
-- CREATE OR REPLACE FUNCTION bodies that reference it as a literal, until
-- that transaction commits). 008_reference_fixed_kure_load_sessions_v2_identity.sql
-- needs to write 'SUPERSEDED_ZERO_PROGRESS'::disclosure_reference.fixed_kure_load_session_status
-- into the trigger function body, so the ADD VALUE must be committed first,
-- in isolation, here.
--
-- ADDITIVE ONLY: adds a new enum label; does not remove or reorder any of
-- 006's existing eight labels, does not touch any row.

BEGIN;

ALTER TYPE disclosure_reference.fixed_kure_load_session_status ADD VALUE IF NOT EXISTS 'SUPERSEDED_ZERO_PROGRESS';

INSERT INTO disclosure_reference.schema_migrations (migration_id)
VALUES ('007_reference_fixed_kure_superseded_status_v0.1')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
