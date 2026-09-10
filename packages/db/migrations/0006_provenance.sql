-- Provenance-graded presence (DESIGN §7.4 / §18.3).
-- Where a file came from decides whether its time and place are trusted and whether it grants presence:
-- only `camera` media at tier ≥ probable makes its owner a contributor of an event. Received media
-- (Snapchat, WhatsApp, downloads) is placed and shown, but never unlocks an event for its owner.

alter table assets
  add column origin text not null default 'unknown' check (origin in ('camera', 'received', 'screenshot', 'edited', 'unknown')),
  add column capture_hint jsonb;   -- EXIF summary read on the device: make, model, dateTimeOriginal, offset, software

create index assets_group_origin on assets (group_id, origin) where deleted_at is null;

-- contributor_ids: owners with presence evidence. Fallback to every owner only when nobody has any,
-- i.e. a loose grouping of untrusted media that has a single owner by construction (the clusterer
-- keeps unanchored received media with its owner).
create or replace function app_refresh_events(eids uuid[]) returns void
language sql security definer set search_path = public as $$
  update events e set
    person_ids = coalesce((
      select array_agg(distinct pid order by pid) from (
        select f.person_id as pid from event_assets ea join faces f on f.blob_id = ea.blob_id
        where ea.event_id = e.id and f.person_id is not null and f.tier in ('confirmed','high','probable')
        union
        select t.person_id from event_person_tags t where t.event_id = e.id
      ) s
    ), '{}'),
    contributor_ids = coalesce((
      with strong as (
        select distinct a.owner_user_id
        from event_assets ea join assets a on a.id = ea.asset_id
        where ea.event_id = e.id and a.deleted_at is null and a.origin = 'camera' and ea.tier in ('confirmed', 'probable')
      ), anyone as (
        select distinct a.owner_user_id
        from event_assets ea join assets a on a.id = ea.asset_id
        where ea.event_id = e.id and a.deleted_at is null
      )
      select array_agg(distinct owner_user_id order by owner_user_id) from (
        select owner_user_id from strong
        union all
        select owner_user_id from anyone where not exists (select 1 from strong)
      ) s
    ), '{}'),
    n_assets = (select count(*) from event_assets ea join assets a on a.id = ea.asset_id where ea.event_id = e.id and a.deleted_at is null),
    n_videos = (select count(*) from event_assets ea join blobs b on b.id = ea.blob_id where ea.event_id = e.id and b.duration_ms is not null),
    updated_at = now()
  where e.id = any(eids);
$$;

-- an origin change (re-manifest with better signals, original with EXIF) changes contributor_ids too
create or replace function trg_assets_upd() returns trigger language plpgsql as $$
declare eids uuid[];
begin
  select array_agg(distinct ea.event_id) into eids
  from new_rows n join old_rows o on o.id = n.id join event_assets ea on ea.asset_id = n.id
  where n.deleted_at is distinct from o.deleted_at or n.owner_user_id <> o.owner_user_id or n.origin <> o.origin;
  if eids is not null then perform app_refresh_events(eids); end if;
  return null;
end $$;

-- tier now feeds contributor_ids, so a tier change on an existing membership (manual add-to-event
-- upsert, a confirm) must refresh the event too; inserts and deletes were already covered
create or replace function trg_event_assets_upd() returns trigger language plpgsql as $$
declare eids uuid[];
begin
  select array_agg(distinct n.event_id) into eids
  from new_rows n join old_rows o on o.event_id = n.event_id and o.asset_id = n.asset_id
  where n.tier is distinct from o.tier;
  if eids is not null then perform app_refresh_events(eids); end if;
  return null;
end $$;
create trigger event_assets_upd after update on event_assets referencing new table as new_rows old table as old_rows for each statement execute function trg_event_assets_upd();
