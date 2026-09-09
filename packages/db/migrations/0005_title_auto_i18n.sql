-- Generated event titles are stored per language ({"nb": ..., "en": ...}); existing English titles are kept
-- under "en" and the titles job fills in Norwegian on its next run.
drop index if exists events_title_trgm;
alter table events alter column title_auto type jsonb using case when title_auto is null then null else jsonb_build_object('en', title_auto) end;
create index events_title_trgm_nb on events using gin ((coalesce(title_manual, title_auto->>'nb', title_auto->>'en')) gin_trgm_ops);
create index events_title_trgm_en on events using gin ((coalesce(title_manual, title_auto->>'en', title_auto->>'nb')) gin_trgm_ops);

-- Backfill: one titles job per group (dedupe key matches packages/shared jobDedupeKey for group-wide titles).
insert into jobs (kind, payload, dedupe_key)
select 'titles', jsonb_build_object('groupId', g.id), 'titles:' || g.id from groups g
on conflict do nothing;
