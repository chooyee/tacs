-- 003 — several labelled links per reference (D-39).
-- Additive only (expand step, docs/10 §5): reference_docs.url stays, unused, so older code keeps
-- working until it is replaced. A later migration can drop it.

-- The links of a reference, in the order the admin chose. The first one (position 0) is the main
-- "Open official document" button in the reference viewer.
create table reference_links (
  id           uuid primary key default gen_random_uuid(),
  reference_id uuid not null references reference_docs (id) on delete cascade,
  position     integer not null,
  label        text not null check (char_length(label) between 1 and 120),
  url          text not null check (url like 'https://%' and char_length(url) <= 2000)
);
create index reference_links_reference_idx on reference_links (reference_id, position);

-- Carry over the old single intranet link as the first link.
insert into reference_links (reference_id, position, label, url)
select id, 0, 'Official document', url
  from reference_docs
 where url is not null and url <> '';
