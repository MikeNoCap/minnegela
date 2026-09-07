-- 1. An actor who removes their own access to an event (untag self, reject own face, exclude
--    their last asset) triggers `update events` on a row they can no longer see. The USING
--    clause still gates which rows can be targeted; WITH CHECK only needs the group to match.
alter policy events_update on events
  using (app_event_visible(group_id, contributor_ids, person_ids, is_public_to_group))
  with check (group_id = app_group_id());

-- 2. The manifest "skip" pre-check (§13.1) must see other members' blobs by md5+size, which
--    blobs_select hides. A definer function exposes only the id for an exact match.
create or replace function app_find_blob(gid uuid, m bytea, sz bigint) returns uuid
language sql stable security definer set search_path = public as
$$ select id from blobs where group_id = gid and md5 = m and size_bytes = sz and app_is_member(gid) limit 1 $$;
grant execute on function app_find_blob(uuid, bytea, bigint) to minnegela_api, minnegela_worker;
