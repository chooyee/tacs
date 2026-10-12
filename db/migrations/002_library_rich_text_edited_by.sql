-- 002 — reference library, rich text, "last edited by" (D-37).
-- Additive only (expand step, docs/10 §5): nothing is dropped, so older code keeps working until
-- it is replaced. A later migration can remove reference_docs.paper_type_id once nothing reads it.

-- References are a shared library, no longer owned by one paper type. The old column stays,
-- nullable, as a record of where a reference came from.
alter table reference_docs alter column paper_type_id drop not null;

-- Rich-text guidance ("what should the architect look for?"), sanitised HTML. `note` keeps a
-- plain-text version of it for tooltips and the AI prompt.
alter table reference_docs add column guidance_html text not null default '';
update reference_docs
   set guidance_html = '<p>' || replace(replace(replace(note, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</p>'
 where note is not null and note <> '';
create index reference_docs_title_idx on reference_docs (lower(title)) where deleted_at is null;

-- A standard has a short title (the old text) and an optional rich-text description.
alter table standards rename column text to title;
alter table standards add column description_html text not null default '';

-- Who made the last change. A display-name snapshot ("Dana Tan", "admin (local)"), so it still
-- reads correctly if the account is later removed. Shown next to updated_at.
alter table paper_types add column updated_by text;
alter table sections add column updated_by text;
alter table standards add column updated_by text;
alter table reference_docs add column updated_by text;

-- Live links between paper types (D-38): a standard imported from another type points to its
-- source and shows the source's title, description, mandatory flag and references. Its own
-- columns are ignored while the link exists; "Duplicate here" copies the content and clears it.
alter table standards add column source_standard_id uuid references standards (id) on delete set null;
create index standards_source_idx on standards (source_standard_id) where source_standard_id is not null;
