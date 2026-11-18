-- 004 — paper type versions: draft and published (D-45).
-- A paper type now has numbered, read-only PUBLISHED versions (v1, v2 …) and at most ONE draft that
-- every admin edits. Publishing the draft freezes it as the next version. A paper is pinned to the
-- version it was created with and can be upgraded by its owner.
-- Additive (expand step, docs/10 §5): sections.paper_type_id and papers.paper_type_id stay, filled in.

create table paper_type_versions (
  id            uuid primary key default gen_random_uuid(),
  paper_type_id uuid not null references paper_types (id) on delete cascade,
  number        integer,                       -- 1, 2, 3 … once published; null while a draft
  status        text not null check (status in ('draft', 'published')),
  name          text not null,                 -- the type's name and description as of this version
  description   text,
  created_at    timestamptz not null default now(),
  created_by    text,
  updated_at    timestamptz not null default now(),
  updated_by    text,
  published_at  timestamptz,
  published_by  text,
  check ((status = 'published') = (number is not null and published_at is not null)),
  unique (paper_type_id, number)
);
-- "One draft per type" (D-45): every admin works on the same draft.
create unique index paper_type_versions_one_draft_uq on paper_type_versions (paper_type_id) where status = 'draft';

-- Every existing type becomes version 1, published, with its current content.
insert into paper_type_versions
       (paper_type_id, number, status, name, description, created_at, created_by, updated_at, updated_by,
        published_at, published_by)
select id, 1, 'published', name, description, created_at, updated_by, updated_at, updated_by, now(), 'migration'
  from paper_types;

-- Sections belong to one version.
alter table sections add column version_id uuid references paper_type_versions (id) on delete cascade;
update sections s set version_id = v.id from paper_type_versions v where v.paper_type_id = s.paper_type_id;
alter table sections alter column version_id set not null;
create index sections_version_position_idx on sections (version_id, position);

-- A standard keeps its lineage across versions (the copy in v2 of a standard in v1 has the same
-- lineage_id), so answers can follow a paper that is upgraded.
alter table standards add column lineage_id uuid;
update standards set lineage_id = id;
alter table standards alter column lineage_id set not null;
create index standards_lineage_idx on standards (lineage_id);

-- A paper is pinned to the version it was created with.
alter table papers add column paper_type_version_id uuid references paper_type_versions (id);
update papers p set paper_type_version_id = v.id from paper_type_versions v where v.paper_type_id = p.paper_type_id;
alter table papers alter column paper_type_version_id set not null;
create index papers_version_idx on papers (paper_type_version_id);
