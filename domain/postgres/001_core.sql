-- Disclosure Analyst common domain schema v0.1
-- PostgreSQL is the source of truth. Search-specific extensions are installed
-- separately so pgvector/Qdrant/Elasticsearch experiments share this schema.

BEGIN;

CREATE TYPE disclosure_doc_group AS ENUM ('periodic', 'major', 'exchange', 'holding');
CREATE TYPE disclosure_file_role AS ENUM (
  'MAIN', 'AUDIT', 'CONSOLIDATED_AUDIT', 'VIEWER_HTML', 'PDF_FALLBACK', 'OTHER'
);
CREATE TYPE disclosure_parse_status AS ENUM ('PENDING', 'SUCCESS', 'PARTIAL', 'FAILED');
CREATE TYPE disclosure_coverage_state AS ENUM (
  'PRESENT', 'ZERO_DOCUMENT', 'PARSE_FAILED', 'PARTIAL_PARSE_FAILURE', 'NOT_IN_CORPUS'
);
CREATE TYPE disclosure_relation_type AS ENUM (
  'AMENDS', 'TERMINATES', 'CONFIRMS', 'SAME_EVENT_AS'
);
CREATE TYPE disclosure_extraction_method AS ENUM (
  'MANIFEST', 'DETERMINISTIC', 'RULE', 'MODEL', 'HUMAN_VERIFIED'
);
CREATE TYPE disclosure_verification_status AS ENUM (
  'CANDIDATE', 'VERIFIED', 'REJECTED', 'PARSE_BLOCKED'
);
CREATE TYPE disclosure_value_type AS ENUM ('NUMERIC', 'TEXT', 'DATE', 'BOOLEAN');
CREATE TYPE disclosure_value_status AS ENUM (
  'DISCLOSED', 'WITHHELD', 'NOT_APPLICABLE', 'MISSING'
);
CREATE TYPE disclosure_value_certainty AS ENUM ('CONFIRMED', 'PLANNED', 'PROVISIONAL', 'NOT_RELEVANT');
CREATE TYPE disclosure_scope AS ENUM ('CONSOLIDATED', 'SEPARATE', 'COMPANY', 'SUBSIDIARY', 'UNKNOWN');
CREATE TYPE disclosure_period_type AS ENUM (
  'POINT_IN_TIME', 'QUARTER', 'CUMULATIVE', 'ANNUAL', 'EVENT_PERIOD', 'UNKNOWN'
);
CREATE TYPE disclosure_eval_split AS ENUM ('DEV_TUNE', 'DEV_CHECK', 'HOLDOUT');
CREATE TYPE disclosure_answerability AS ENUM (
  'SUPPORTED', 'NOT_FOUND', 'WITHHELD', 'NOT_APPLICABLE', 'UNANSWERABLE',
  'OUT_OF_SCOPE', 'AMBIGUOUS_QUERY', 'CONFLICTING_EVIDENCE'
);

CREATE TABLE corpus_snapshots (
  corpus_snapshot_id text PRIMARY KEY,
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  universe_sha256 text NOT NULL CHECK (universe_sha256 ~ '^[0-9a-f]{64}$'),
  document_count integer NOT NULL CHECK (document_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  notes text
);

CREATE TABLE companies (
  corp_code text PRIMARY KEY CHECK (corp_code ~ '^\d{8}$'),
  stock_code text NOT NULL CHECK (stock_code ~ '^\d{6}$'),
  corp_name text NOT NULL,
  listed_name text NOT NULL,
  corp_eng_name text,
  market text NOT NULL,
  industry text NOT NULL,
  sector_no integer,
  sector text NOT NULL,
  listing_date date,
  fiscal_month smallint CHECK (fiscal_month BETWEEN 1 AND 12),
  universe_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (stock_code)
);

CREATE TABLE company_aliases (
  alias_id text PRIMARY KEY,
  corp_code text NOT NULL REFERENCES companies(corp_code),
  alias text NOT NULL,
  normalized_alias text NOT NULL,
  alias_type text NOT NULL CHECK (alias_type IN ('DART_NAME', 'LISTED_NAME', 'STOCK_CODE', 'ENGLISH', 'HISTORICAL', 'MANUAL')),
  valid_from date,
  valid_to date,
  source text NOT NULL,
  UNIQUE (corp_code, normalized_alias, alias_type)
);

CREATE TABLE documents (
  document_id text PRIMARY KEY,
  corpus_snapshot_id text NOT NULL REFERENCES corpus_snapshots(corpus_snapshot_id),
  corp_code text NOT NULL REFERENCES companies(corp_code),
  doc_group disclosure_doc_group NOT NULL,
  doc_subtype text,
  report_name text NOT NULL,
  receipt_number text NOT NULL CHECK (receipt_number ~ '^\d{14}$'),
  receipt_date date NOT NULL,
  filer_name text NOT NULL,
  is_correction boolean NOT NULL,
  base_year smallint,
  base_month smallint CHECK (base_month BETWEEN 1 AND 12),
  file_path text NOT NULL,
  file_format text NOT NULL,
  declared_file_count integer NOT NULL CHECK (declared_file_count > 0),
  known_at timestamptz NOT NULL,
  manifest_payload jsonb NOT NULL,
  UNIQUE (corpus_snapshot_id, receipt_number),
  CHECK (document_id = doc_group::text || '_' || receipt_number)
);

CREATE INDEX documents_filter_idx
  ON documents (corp_code, doc_group, base_year, base_month, receipt_date);
CREATE INDEX documents_correction_idx
  ON documents (corp_code, doc_group, is_correction, receipt_date);

CREATE TABLE files (
  file_id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
  relative_path text NOT NULL,
  file_role disclosure_file_role NOT NULL,
  detected_format text NOT NULL CHECK (detected_format IN ('XML', 'HTML', 'PDF', 'UNKNOWN')),
  detected_encoding text,
  byte_size bigint CHECK (byte_size >= 0),
  content_sha256 text CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
  is_primary boolean NOT NULL DEFAULT false,
  UNIQUE (document_id, relative_path)
);

CREATE TABLE parse_runs (
  parse_run_id text PRIMARY KEY,
  file_id text NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
  parser_name text NOT NULL,
  parser_version text NOT NULL,
  status disclosure_parse_status NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  repair_used boolean NOT NULL DEFAULT false,
  text_loss_suspected boolean NOT NULL DEFAULT false,
  extracted_char_count bigint CHECK (extracted_char_count >= 0),
  warning_count integer NOT NULL DEFAULT 0 CHECK (warning_count >= 0),
  error_count integer NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX parse_runs_file_idx ON parse_runs (file_id, completed_at DESC);

CREATE TABLE coverage (
  coverage_id text PRIMARY KEY,
  corpus_snapshot_id text NOT NULL REFERENCES corpus_snapshots(corpus_snapshot_id),
  corp_code text NOT NULL REFERENCES companies(corp_code),
  doc_group disclosure_doc_group NOT NULL,
  period_key text NOT NULL,
  document_id text REFERENCES documents(document_id),
  state disclosure_coverage_state NOT NULL,
  reason_code text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  assessed_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state IN ('PARSE_FAILED', 'PARTIAL_PARSE_FAILURE', 'PRESENT')) OR document_id IS NULL)
);

CREATE INDEX coverage_lookup_idx ON coverage (corp_code, doc_group, period_key, state);

CREATE TABLE sections (
  section_id text PRIMARY KEY,
  file_id text NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
  parent_section_id text REFERENCES sections(section_id),
  section_path text[] NOT NULL,
  title text,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  source_locator text NOT NULL,
  char_start bigint,
  char_end bigint,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (file_id, source_locator)
);

CREATE TABLE source_tables (
  table_id text PRIMARY KEY,
  section_id text NOT NULL REFERENCES sections(section_id) ON DELETE CASCADE,
  title text,
  source_locator text NOT NULL,
  unit text,
  scope disclosure_scope NOT NULL DEFAULT 'UNKNOWN',
  period_type disclosure_period_type NOT NULL DEFAULT 'UNKNOWN',
  header_rows jsonb NOT NULL,
  body_rows jsonb NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (section_id, source_locator)
);

CREATE TABLE chunks (
  chunk_id text PRIMARY KEY,
  strategy_id text NOT NULL,
  document_id text NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
  file_id text NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
  section_id text REFERENCES sections(section_id),
  parent_chunk_id text REFERENCES chunks(chunk_id),
  chunk_type text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  text_content text NOT NULL,
  token_count integer NOT NULL CHECK (token_count > 0),
  section_path text[] NOT NULL,
  source_locator text NOT NULL,
  content_fingerprint text NOT NULL CHECK (content_fingerprint ~ '^[0-9a-f]{64}$'),
  duplicate_group_id text,
  repeated_section boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (strategy_id, document_id, ordinal)
);

CREATE INDEX chunks_filter_idx ON chunks (strategy_id, document_id, chunk_type);
CREATE INDEX chunks_fingerprint_idx ON chunks (content_fingerprint);

CREATE TABLE events (
  event_id text PRIMARY KEY,
  chain_id text NOT NULL,
  corp_code text NOT NULL REFERENCES companies(corp_code),
  event_type text NOT NULL,
  event_status text NOT NULL,
  anchor_document_id text NOT NULL REFERENCES documents(document_id),
  event_date date,
  known_at timestamptz NOT NULL,
  valid_from timestamptz,
  valid_to timestamptz,
  verification_status disclosure_verification_status NOT NULL,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (chain_id, event_id)
);

CREATE INDEX events_lookup_idx ON events (corp_code, event_type, event_date);
CREATE INDEX events_chain_idx ON events (chain_id);

CREATE TABLE document_events (
  document_id text NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
  event_id text NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  relation_type text NOT NULL DEFAULT 'DISCLOSES' CHECK (relation_type = 'DISCLOSES'),
  known_at timestamptz NOT NULL,
  extraction_method disclosure_extraction_method NOT NULL,
  confidence numeric(5,4) CHECK (confidence BETWEEN 0 AND 1),
  PRIMARY KEY (document_id, event_id, relation_type)
);

CREATE TABLE evidence (
  evidence_id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES documents(document_id),
  file_id text NOT NULL REFERENCES files(file_id),
  chunk_id text REFERENCES chunks(chunk_id),
  source_locator text NOT NULL,
  quoted_text text,
  quote_sha256 text CHECK (quote_sha256 IS NULL OR quote_sha256 ~ '^[0-9a-f]{64}$'),
  extraction_method disclosure_extraction_method NOT NULL,
  confidence numeric(5,4) CHECK (confidence BETWEEN 0 AND 1),
  verification_status disclosure_verification_status NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE document_relations (
  relation_id text PRIMARY KEY,
  source_document_id text NOT NULL REFERENCES documents(document_id),
  target_document_id text NOT NULL REFERENCES documents(document_id),
  event_id text REFERENCES events(event_id),
  relation_type disclosure_relation_type NOT NULL,
  known_at timestamptz NOT NULL,
  extraction_method disclosure_extraction_method NOT NULL,
  confidence numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  evidence_id text REFERENCES evidence(evidence_id),
  verification_status disclosure_verification_status NOT NULL DEFAULT 'VERIFIED'
    CHECK (verification_status = 'VERIFIED'),
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (source_document_id, target_document_id, relation_type),
  CHECK (source_document_id <> target_document_id)
);

CREATE INDEX document_relations_source_idx ON document_relations (source_document_id, relation_type);
CREATE INDEX document_relations_target_idx ON document_relations (target_document_id, relation_type);

-- Candidate relations never participate in runtime reasoning until a reviewer
-- accepts and promotes them to document_relations.
CREATE TABLE document_relation_candidates (
  relation_candidate_id text PRIMARY KEY,
  source_document_id text NOT NULL REFERENCES documents(document_id),
  relation_type disclosure_relation_type NOT NULL,
  candidate_targets jsonb NOT NULL,
  review_status text NOT NULL DEFAULT 'PENDING'
    CHECK (review_status IN (
      'PENDING', 'ACCEPTED', 'REJECTED', 'TARGET_OUTSIDE_CORPUS', 'PARSE_BLOCKED'
    )),
  reviewer text,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_document_id, relation_type)
);

CREATE TABLE facts (
  fact_id text PRIMARY KEY,
  corp_code text NOT NULL REFERENCES companies(corp_code),
  event_id text REFERENCES events(event_id),
  source_document_id text NOT NULL REFERENCES documents(document_id),
  metric_code text NOT NULL,
  metric_name text NOT NULL,
  value_type disclosure_value_type NOT NULL,
  value_status disclosure_value_status NOT NULL,
  value_certainty disclosure_value_certainty NOT NULL,
  raw_value_text text NOT NULL CHECK (btrim(raw_value_text) <> ''),
  raw_unit_text text,
  numeric_value numeric,
  text_value text,
  date_value date,
  boolean_value boolean,
  unit text,
  currency char(3),
  scale numeric NOT NULL DEFAULT 1,
  scope disclosure_scope NOT NULL DEFAULT 'UNKNOWN',
  period_type disclosure_period_type NOT NULL DEFAULT 'UNKNOWN',
  period_start date,
  period_end date,
  as_of_date date,
  known_at timestamptz NOT NULL,
  valid_from timestamptz,
  valid_to timestamptz,
  withheld_until date,
  extraction_method disclosure_extraction_method NOT NULL,
  confidence numeric(5,4) CHECK (confidence BETWEEN 0 AND 1),
  verification_status disclosure_verification_status NOT NULL,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (
    value_status <> 'DISCLOSED' OR
    (value_type = 'NUMERIC' AND numeric_value IS NOT NULL) OR
    (value_type = 'TEXT' AND text_value IS NOT NULL) OR
    (value_type = 'DATE' AND date_value IS NOT NULL) OR
    (value_type = 'BOOLEAN' AND boolean_value IS NOT NULL)
  ),
  CHECK (value_status = 'WITHHELD' OR withheld_until IS NULL)
);

CREATE INDEX facts_lookup_idx
  ON facts (corp_code, metric_code, period_start, period_end, as_of_date, scope);
CREATE INDEX facts_event_idx ON facts (event_id);

CREATE TABLE fact_evidence (
  fact_id text NOT NULL REFERENCES facts(fact_id) ON DELETE CASCADE,
  evidence_id text NOT NULL REFERENCES evidence(evidence_id) ON DELETE CASCADE,
  evidence_role text NOT NULL DEFAULT 'PRIMARY',
  PRIMARY KEY (fact_id, evidence_id)
);

CREATE TABLE event_evidence (
  event_id text NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  evidence_id text NOT NULL REFERENCES evidence(evidence_id) ON DELETE CASCADE,
  evidence_role text NOT NULL DEFAULT 'PRIMARY',
  PRIMARY KEY (event_id, evidence_id)
);

-- Immutable, reviewer-authorized input to route policy evaluation. A new Fact
-- extraction state creates a new snapshot; existing experiment rounds never
-- observe in-place changes.
CREATE TABLE fact_coverage_snapshots (
  fact_coverage_snapshot_id text PRIMARY KEY,
  corpus_snapshot_id text NOT NULL REFERENCES corpus_snapshots(corpus_snapshot_id),
  semantic_bundle_schema_version text NOT NULL,
  producer_version text NOT NULL,
  created_at timestamptz NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE TABLE fact_coverage_snapshot_slots (
  fact_coverage_snapshot_id text NOT NULL
    REFERENCES fact_coverage_snapshots(fact_coverage_snapshot_id) ON DELETE CASCADE,
  slot_key text NOT NULL,
  corp_code text NOT NULL REFERENCES companies(corp_code),
  metric_code text NOT NULL,
  period_key text,
  scope disclosure_scope,
  coverage_state text NOT NULL CHECK (coverage_state IN (
    'ALL_REQUIRED_FACT_SLOTS_VERIFIED', 'FACT_SLOT_VERIFIED_WITHHELD',
    'FACT_SLOT_VERIFIED_NOT_APPLICABLE', 'PARTIAL_STRUCTURED_FACT_COVERAGE',
    'NO_STRUCTURED_FACT_COVERAGE', 'ZERO_DOCUMENT_IN_CORPUS', 'PARSE_BLOCKED',
    'OUT_OF_SCOPE', 'CONFLICTING_VERIFIED_FACTS'
  )),
  verification_status text NOT NULL CHECK (verification_status = 'VERIFIED'),
  fact_ids text[] NOT NULL DEFAULT '{}',
  evidence_ids text[] NOT NULL DEFAULT '{}',
  reason_code text,
  PRIMARY KEY (fact_coverage_snapshot_id, slot_key),
  CHECK (coverage_state <> 'CONFLICTING_VERIFIED_FACTS' OR cardinality(fact_ids) >= 2)
);

CREATE TABLE evaluation_questions (
  question_id text PRIMARY KEY,
  schema_version text NOT NULL CHECK (schema_version = '0.2.0'),
  evaluation_group_id text NOT NULL,
  split disclosure_eval_split NOT NULL,
  question text NOT NULL,
  question_type text NOT NULL,
  difficulty text NOT NULL CHECK (difficulty IN ('EASY', 'MEDIUM', 'HARD')),
  answer_mode text NOT NULL CHECK (answer_mode IN ('CLOSED', 'OPEN')),
  doc_groups disclosure_doc_group[] NOT NULL,
  corp_codes text[] NOT NULL DEFAULT '{}',
  as_of_date date,
  expected_answerability disclosure_answerability NOT NULL,
  expected_answer jsonb NOT NULL,
  authored_against jsonb NOT NULL CHECK (jsonb_typeof(authored_against) = 'object'),
  expected_execution jsonb NOT NULL CHECK (jsonb_typeof(expected_execution) = 'object'),
  scoring_spec jsonb NOT NULL CHECK (jsonb_typeof(scoring_spec) = 'object'),
  tags text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX evaluation_group_idx ON evaluation_questions (evaluation_group_id, split);

CREATE TABLE evaluation_evidence_slots (
  slot_id text PRIMARY KEY,
  question_id text NOT NULL REFERENCES evaluation_questions(question_id) ON DELETE CASCADE,
  slot_name text NOT NULL,
  description text NOT NULL,
  acceptable_sources jsonb NOT NULL,
  expected_fact_ids text[] NOT NULL DEFAULT '{}',
  expected_event_ids text[] NOT NULL DEFAULT '{}',
  UNIQUE (question_id, slot_name)
);

CREATE TABLE regression_cases (
  regression_case_id text PRIMARY KEY,
  question_payload jsonb NOT NULL,
  bug_class text NOT NULL,
  introduced_by_run_id text,
  fixed_by_commit text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE experiment_runs (
  run_id text PRIMARY KEY,
  experiment_round_id text NOT NULL,
  corpus_snapshot_id text NOT NULL REFERENCES corpus_snapshots(corpus_snapshot_id),
  git_commit text NOT NULL,
  parser_version text NOT NULL,
  chunker_version text NOT NULL,
  chunking_config_id text NOT NULL,
  embedding_model_id text NOT NULL,
  search_backend_id text NOT NULL,
  index_snapshot_id text NOT NULL,
  gold_revision text NOT NULL,
  fact_coverage_snapshot_id text NOT NULL
    REFERENCES fact_coverage_snapshots(fact_coverage_snapshot_id),
  random_seed bigint NOT NULL,
  configuration jsonb NOT NULL,
  metrics jsonb NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE INDEX experiment_round_reproducibility_idx ON experiment_runs (
  experiment_round_id, corpus_snapshot_id, parser_version,
  gold_revision, fact_coverage_snapshot_id
);

CREATE TABLE evaluation_usage_events (
  usage_event_id text PRIMARY KEY,
  question_id text REFERENCES evaluation_questions(question_id),
  assignment_id text NOT NULL,
  run_id text NOT NULL REFERENCES experiment_runs(run_id),
  usage_kind text NOT NULL CHECK (usage_kind IN ('SANDBOX', 'TUNING', 'CHECKPOINT', 'FINAL_HOLDOUT')),
  executed_split text NOT NULL CHECK (executed_split IN ('SANDBOX', 'DEV_TUNE', 'DEV_CHECK', 'HOLDOUT')),
  used_at timestamptz NOT NULL,
  split_lock_status_at_use text NOT NULL CHECK (
    split_lock_status_at_use IN (
      'PROVISIONAL_UNTIL_CHAIN_CLOSURE', 'LOCKED_BY_CHAIN', 'LOCKED_BY_COVERAGE'
    )
  ),
  chain_ids_at_use text[] NOT NULL DEFAULT '{}',
  git_commit text,
  configuration_sha256 text CHECK (
    configuration_sha256 IS NULL OR configuration_sha256 ~ '^[0-9a-f]{64}$'
  ),
  notes text,
  CHECK (
    executed_split = 'SANDBOX' OR
    split_lock_status_at_use IN ('LOCKED_BY_CHAIN', 'LOCKED_BY_COVERAGE')
  ),
  CHECK (
    (usage_kind = 'SANDBOX' AND executed_split = 'SANDBOX') OR
    (usage_kind = 'TUNING' AND executed_split = 'DEV_TUNE') OR
    (usage_kind = 'CHECKPOINT' AND executed_split = 'DEV_CHECK') OR
    (usage_kind = 'FINAL_HOLDOUT' AND executed_split = 'HOLDOUT')
  )
);

CREATE INDEX evaluation_usage_assignment_idx
  ON evaluation_usage_events (assignment_id, used_at);
CREATE INDEX evaluation_usage_chain_idx
  ON evaluation_usage_events USING gin (chain_ids_at_use);

COMMIT;
