-- §18.3 presence fallback, tightened. When no owner has a camera-origin asset at tier ≥ probable, owners of
-- camera-origin assets at any tier count before "every owner": a received photo of a participant that
-- anchors into someone's loose leftovers must not make its owner a contributor of those leftovers.
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
      ), trusted as (
        select distinct a.owner_user_id
        from event_assets ea join assets a on a.id = ea.asset_id
        where ea.event_id = e.id and a.deleted_at is null and a.origin = 'camera'
      ), anyone as (
        select distinct a.owner_user_id
        from event_assets ea join assets a on a.id = ea.asset_id
        where ea.event_id = e.id and a.deleted_at is null
      )
      select array_agg(distinct owner_user_id order by owner_user_id) from (
        select owner_user_id from strong
        union all
        select owner_user_id from trusted where not exists (select 1 from strong)
        union all
        select owner_user_id from anyone where not exists (select 1 from trusted)
      ) s
    ), '{}'),
    n_assets = (select count(*) from event_assets ea join assets a on a.id = ea.asset_id where ea.event_id = e.id and a.deleted_at is null),
    n_videos = (select count(*) from event_assets ea join blobs b on b.id = ea.blob_id where ea.event_id = e.id and b.duration_ms is not null),
    updated_at = now()
  where e.id = any(eids);
$$;
