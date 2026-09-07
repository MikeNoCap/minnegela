-- Derived-array maintenance (person_ids, contributor_ids, counts) is system logic that must run even when
-- the acting user is removing their own access: Postgres re-checks the SELECT policy against the updated
-- events row, and the row is no longer visible to them. Run the refresh functions with definer rights.
alter function app_refresh_events(uuid[]) security definer set search_path = public;
alter function app_refresh_asset_people(uuid[]) security definer set search_path = public;
