-- Turn AC-VFINAL-ALIGNMENT-AND-DISCOVERY, section L: adds ONE new terminal
-- status value, FAILED_DISCOVERY_RESOURCE_EXHAUSTED, to 006's
-- disclosure_reference.fixed_kure_load_session_status enum.
--
-- WHY THIS IS DIFFERENT FROM 007's SUPERSEDED_ZERO_PROGRESS: that status is
-- for attempts abandoned with ZERO progress (the DB-side trigger refuses it
-- otherwise). The real full-corpus attempt this Turn must terminate
-- (fixed_kure_attempt_f40dc66a8daf48a12397353dd65bc0c6) has REAL, non-zero
-- discovery progress (partial documents/chunks/unique-texts genuinely
-- discovered before the resource-exhaustion crash) that must be preserved,
-- not zeroed or discarded -- a plain 006 FAILED transition would work for
-- the row itself, but 008's partial unique index only excludes
-- SUPERSEDED_ZERO_PROGRESS from the active-attempt uniqueness gate, so a
-- plain FAILED row would keep blocking a fresh attempt of the same logical
-- load from ever being created. This status is the additive fix: a
-- terminal, immutable status for a genuinely-progressed-but-resource-
-- exhausted attempt, ALSO excluded from the active-attempt gate.
--
-- WHY ITS OWN MIGRATION FILE, SEPARATE FROM 010: same PostgreSQL rule as
-- 007/008 -- a freshly ALTER TYPE ... ADD VALUE'd enum label cannot be
-- referenced (including as a literal inside a CREATE OR REPLACE FUNCTION
-- body, or inside a partial index's WHERE predicate) within the SAME
-- transaction that added it. The ADD VALUE must commit first, in isolation,
-- here; 010 does the trigger/index work that references it.
--
-- ADDITIVE ONLY: adds a new enum label; does not remove or reorder any of
-- 006/007's existing nine labels, does not touch any row.

BEGIN;

ALTER TYPE disclosure_reference.fixed_kure_load_session_status ADD VALUE IF NOT EXISTS 'FAILED_DISCOVERY_RESOURCE_EXHAUSTED';

INSERT INTO disclosure_reference.schema_migrations (migration_id)
VALUES ('009_reference_fixed_kure_failed_resource_exhausted_status_v0.1')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
