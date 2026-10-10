-- 001_init.sql — the full schema of docs/05, plus app-managed roles and local admins (D-26, D-27).
-- Conventions: uuid keys (gen_random_uuid, built into PostgreSQL 13+), timestamptz everywhere,
-- soft delete with deleted_at, positions for ordering. db/migrate.js runs this in one transaction.

-- 3.1 Users who signed in with Entra ID. The role is managed in the app (D-26), never from the token.
create table users (
  id            uuid primary key default gen_random_uuid(),
  entra_oid     text not null unique,
  email         text,
  display_name  text,
  role          text not null default 'architect' check (role in ('architect', 'admin')),
  status        text not null default 'active' check (status in ('active', 'disabled')),
  last_login_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- 3.1a Local administrator accounts (D-27): break-glass sign-in that works without Entra.
create table local_admins (
  id                   uuid primary key default gen_random_uuid(),
  username             text not null unique check (username ~ '^[a-z0-9._-]{3,40}$'),
  password_hash        text not null,
  must_change_password boolean not null default true,
  password_changed_at  timestamptz not null default now(),
  failed_attempts      integer not null default 0,
  locked_until         timestamptz,
  created_by           text,
  last_login_at        timestamptz,
  created_at           timestamptz not null default now()
);

-- 3.2 Paper types
create table paper_types (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
-- Names are unique among non-deleted types only, so a deleted name can be reused.
create unique index paper_types_name_active_uq on paper_types (lower(name)) where deleted_at is null;
create index paper_types_deleted_at_idx on paper_types (deleted_at) where deleted_at is not null;

-- 3.3 Sections of a paper type
create table sections (
  id            uuid primary key default gen_random_uuid(),
  paper_type_id uuid not null references paper_types (id) on delete cascade,
  title         text not null,
  position      integer not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index sections_type_position_idx on sections (paper_type_id, position);
create index sections_deleted_at_idx on sections (deleted_at) where deleted_at is not null;

-- 3.4 Standards of a section
create table standards (
  id           uuid primary key default gen_random_uuid(),
  section_id   uuid not null references sections (id) on delete cascade,
  text         text not null check (char_length(text) between 1 and 500),
  is_mandatory boolean not null default false,
  position     integer not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);
create index standards_section_position_idx on standards (section_id, position);
create index standards_deleted_at_idx on standards (deleted_at) where deleted_at is not null;

-- 3.5 Reference documents ("references" is a reserved word)
create table reference_docs (
  id            uuid primary key default gen_random_uuid(),
  paper_type_id uuid not null references paper_types (id) on delete cascade,
  type          text not null check (type in ('Policy', 'Sample', 'Template', 'Guide')),
  title         text not null,
  note          text check (char_length(note) <= 500),
  url           text check (url like 'https://%'),
  s3_key        text not null,
  file_name     text not null,
  mime_type     text not null check (mime_type in ('application/pdf', 'image/png', 'image/jpeg')),
  size_bytes    integer not null,
  page_count    integer,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index reference_docs_type_idx on reference_docs (paper_type_id);
create index reference_docs_deleted_at_idx on reference_docs (deleted_at) where deleted_at is not null;

-- 3.6 Standard <-> reference links
create table standard_references (
  standard_id  uuid not null references standards (id) on delete cascade,
  reference_id uuid not null references reference_docs (id) on delete cascade,
  primary key (standard_id, reference_id)
);
create index standard_references_reference_idx on standard_references (reference_id);

-- 3.7 Papers
create table papers (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references users (id),
  paper_type_id uuid not null references paper_types (id),
  title         text not null check (char_length(title) between 3 and 150),
  vendor        text check (char_length(vendor) <= 150),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index papers_owner_idx on papers (owner_id, updated_at desc);
create index papers_type_idx on papers (paper_type_id);
create index papers_updated_idx on papers (updated_at desc) where deleted_at is null;
create index papers_deleted_at_idx on papers (deleted_at) where deleted_at is not null;

-- 3.8 Answers (one per paper + standard; upsert)
create table answers (
  paper_id    uuid not null references papers (id) on delete cascade,
  standard_id uuid not null references standards (id) on delete cascade,
  value       text check (value in ('yes', 'no', 'na')),
  remark      text not null default '' check (char_length(remark) <= 2000),
  updated_at  timestamptz not null default now(),
  primary key (paper_id, standard_id)
);
create index answers_standard_idx on answers (standard_id);

-- 3.9 Uploaded paper PDFs
create table paper_documents (
  id         uuid primary key default gen_random_uuid(),
  paper_id   uuid not null references papers (id) on delete cascade,
  s3_key     text not null,
  file_name  text not null,
  size_bytes integer not null,
  page_count integer not null,
  is_current boolean not null default true,
  created_at timestamptz not null default now()
);
create index paper_documents_paper_idx on paper_documents (paper_id);
create index paper_documents_created_idx on paper_documents (created_at); -- retention job

-- 3.10 AI checks (the background job queue)
create table checks (
  id                 uuid primary key default gen_random_uuid(),
  paper_id           uuid not null references papers (id) on delete cascade,
  requested_by       uuid not null references users (id),
  status             text not null check (status in ('queued', 'running', 'done', 'failed')),
  step               smallint not null default 0 check (step between 0 and 4),
  provider           text,
  model              text,
  prompt_version     text,
  standards_snapshot jsonb,
  error_code         text,
  error_message      text,
  input_tokens       integer,
  output_tokens      integer,
  started_at         timestamptz,
  finished_at        timestamptz,
  created_at         timestamptz not null default now()
);
create index checks_status_created_idx on checks (status, created_at); -- worker claim
create index checks_paper_created_idx on checks (paper_id, created_at desc);
-- One active check per paper.
create unique index checks_one_active_per_paper_uq on checks (paper_id) where status in ('queued', 'running');

-- 3.11 Which documents a check read
create table check_documents (
  check_id    uuid not null references checks (id) on delete cascade,
  document_id uuid not null references paper_documents (id) on delete cascade,
  primary key (check_id, document_id)
);
create index check_documents_document_idx on check_documents (document_id);

-- 3.12 AI results per standard
create table check_results (
  id              uuid primary key default gen_random_uuid(),
  check_id        uuid not null references checks (id) on delete cascade,
  standard_id     uuid not null references standards (id) on delete cascade,
  verdict         text not null check (verdict in ('comply', 'partial', 'gap', 'none')),
  page            integer,
  document_id     uuid references paper_documents (id) on delete set null, -- the PDF expires after 7 days
  area            text check (area in ('text', 'diagram', 'table')),
  bbox            jsonb,
  finding         text not null check (char_length(finding) <= 300),
  reference_id    uuid references reference_docs (id) on delete set null,
  reference_page  integer,
  confidence      numeric(3, 2) check (confidence between 0 and 1),
  kept_by_user_at timestamptz,
  unique (check_id, standard_id)
);
create index check_results_standard_idx on check_results (standard_id);

-- 3.13 AI checker chat
create table chat_messages (
  id         uuid primary key default gen_random_uuid(),
  paper_id   uuid not null references papers (id) on delete cascade,
  role       text not null check (role in ('user', 'assistant')),
  kind       text not null check (kind in ('text', 'files', 'report', 'compare', 'gaps', 'refs', 'summary', 'error')),
  content    jsonb not null,
  created_at timestamptz not null default now()
);
create index chat_messages_paper_idx on chat_messages (paper_id, created_at);
create index chat_messages_created_idx on chat_messages (created_at); -- retention job

-- 3.14 Admin audit log. Exactly one actor: an Entra admin (user_id) or a local admin (local_admin_id).
create table admin_audit_log (
  id             bigserial primary key,
  user_id        uuid references users (id),
  local_admin_id uuid references local_admins (id) on delete set null,
  action         text not null,
  entity_type    text not null,
  entity_id      uuid,
  before         jsonb,
  after          jsonb,
  created_at     timestamptz not null default now(),
  -- "at most one" (not "exactly one"): deleting a local admin later nulls its id but keeps the history.
  check (num_nonnulls(user_id, local_admin_id) <= 1)
);
create index admin_audit_log_entity_idx on admin_audit_log (entity_type, entity_id);

-- 3.15 Sessions: the standard connect-pg-simple table (created here, not at runtime).
create table session (
  sid    varchar not null primary key,
  sess   json not null,
  expire timestamp(6) not null
);
create index session_expire_idx on session (expire);
