-- Minnegela initial schema. Mirrors docs/DESIGN.md §11, §11.1, §18.3, §18.9.
-- Applied by src/migrate.ts as the admin role (superuser in the container).

create extension if not exists pgcrypto;
create extension if not exists vector;
create extension if not exists pg_trgm;
create extension if not exists cube;
create extension if not exists earthdistance;

-- roles ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'minnegela_api') then
    create role minnegela_api login password 'minnegela';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'minnegela_worker') then
    create role minnegela_worker login password 'minnegela';
  end if;
end $$;
alter role minnegela_worker bypassrls;
alter role minnegela_api nobypassrls;

create schema if not exists ml;   -- biometric embeddings; only the worker role can read it

-- viewer context helpers ----------------------------------------------------
create or replace function app_user_id() returns uuid language sql stable as
$$ select nullif(current_setting('app.user_id', true), '')::uuid $$;
create or replace function app_group_id() returns uuid language sql stable as
$$ select nullif(current_setting('app.group_id', true), '')::uuid $$;
create or replace function app_person_id() returns int language sql stable as
$$ select nullif(current_setting('app.person_id', true), '')::int $$;

-- identity & tenancy (auth tables are owned by Better Auth; no RLS) -----------
create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  email_verified boolean not null default false,
  display_name text not null,
  image text,
  birthday date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token text not null unique,
  expires_at timestamptz not null,
  ip_address text,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index sessions_user on sessions(user_id);
create table accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  account_id text not null,
  provider_id text not null,
  access_token text, refresh_token text, id_token text,
  access_token_expires_at timestamptz, refresh_token_expires_at timestamptz,
  scope text, password text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index accounts_user on accounts(user_id);
create table verifications (
  id uuid primary key default gen_random_uuid(),
  identifier text not null,
  value text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index verifications_identifier on verifications(identifier);

create table groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid not null references users(id),
  settings jsonb not null default '{"cluster_unknown_faces": true}'::jsonb,
  created_at timestamptz not null default now()
);
create table group_members (
  group_id uuid not null references groups(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('owner','member')),
  joined_at timestamptz not null default now(),
  consent_faces_at timestamptz,
  primary key (group_id, user_id)
);
create index group_members_user on group_members(user_id);
create table group_invites (
  code text primary key,
  group_id uuid not null references groups(id) on delete cascade,
  created_by uuid not null references users(id),
  expires_at timestamptz not null,
  used_by uuid references users(id),
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create table devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  platform text not null check (platform in ('ios','android','cli','web')),
  name text not null,
  clock_offset_s int not null default 0,
  last_sync_at timestamptz,
  push_token text,
  created_at timestamptz not null default now()
);
create index devices_user on devices(user_id);

-- membership check that does not recurse through RLS
create or replace function app_is_member(gid uuid) returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from group_members where group_id = gid and user_id = app_user_id()) $$;
create or replace function app_is_owner(gid uuid) returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from group_members where group_id = gid and user_id = app_user_id() and role = 'owner') $$;

-- physical media ---------------------------------------------------------------
create table blobs (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id) on delete cascade,
  sha256 bytea,                          -- null until the first upload is verified by `derive`
  md5 bytea,                             -- phone pre-check identity
  size_bytes bigint,
  mime text not null,
  width int, height int,
  duration_ms int,
  phash bit(64),
  storage_key text,                      -- original, null until uploaded
  preview_key text,                      -- 1600 px preview (always, once derived)
  thumb_key text,
  captured_at timestamptz,               -- corrected, derived (§11 notes)
  captured_tz text,
  lat double precision, lon double precision, gps_accuracy_m real,
  city text,
  camera_make text, camera_model text,
  exif jsonb,
  is_utility boolean not null default false,
  time_uncertain boolean not null default false,
  clip_emb vector(512),
  clip_model text,
  tags jsonb not null default '[]'::jsonb,
  quality jsonb,
  n_faces int not null default 0,
  near_dup_group_id uuid,
  variant_of uuid references blobs(id) on delete set null,
  derived_at timestamptz,
  analyzed_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index blobs_group_sha on blobs (group_id, sha256) where sha256 is not null;
create index blobs_group_md5 on blobs (group_id, md5, size_bytes) where md5 is not null;
create index blobs_group_time on blobs (group_id, captured_at);
create index blobs_phash on blobs (group_id, phash) where phash is not null;
create index blobs_geo on blobs using gist (ll_to_earth(lat, lon)) where lat is not null;
create index blobs_clip on blobs using hnsw (clip_emb vector_cosine_ops);
create index blobs_near_dup on blobs (near_dup_group_id) where near_dup_group_id is not null;

create table assets (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id) on delete cascade,
  blob_id uuid not null references blobs(id) on delete cascade,
  owner_user_id uuid not null references users(id) on delete cascade,
  device_id uuid not null references devices(id) on delete cascade,
  local_id text not null,
  filename text,
  album_names text[] not null default '{}',
  local_created_at timestamptz not null,
  local_modified_at timestamptz,
  is_favorite boolean not null default false,
  visibility text not null default 'group' check (visibility in ('group','hidden')),
  excluded_reason text,
  person_ids int[] not null default '{}',
  preview_uploaded_at timestamptz,
  original_uploaded_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (device_id, local_id)
);
create index assets_group_owner on assets (group_id, owner_user_id);
create index assets_blob on assets (blob_id);
create index assets_people on assets using gin (person_ids);

create table derivatives (
  blob_id uuid not null references blobs(id) on delete cascade,
  kind text not null,                    -- thumb320 | preview1600 | poster | frame | video720
  frame_index int not null default -1,
  storage_key text not null,
  width int, height int,
  bytes int,
  primary key (blob_id, kind, frame_index)
);

-- faces & people -----------------------------------------------------------------
create table persons (
  id serial primary key,
  group_id uuid not null references groups(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  name text,
  hidden boolean not null default false,
  cover_face_id uuid,
  created_at timestamptz not null default now()
);
create unique index persons_group_user on persons (group_id, user_id) where user_id is not null;
create index persons_group on persons (group_id);

create table faces (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id) on delete cascade,
  blob_id uuid not null references blobs(id) on delete cascade,
  frame_index int not null default -1,
  box jsonb not null,                    -- {x,y,w,h} in preview pixels
  landmarks jsonb,
  det_score real not null,
  quality_flags text[] not null default '{}',
  crop_key text,
  person_id int references persons(id) on delete set null,
  match_score real,
  tier text check (tier in ('confirmed','high','probable','low')),
  match_source text check (match_source in ('auto','label','context')),
  created_at timestamptz not null default now()
);
create index faces_group_person on faces (group_id, person_id);
create index faces_blob on faces (blob_id);
alter table persons add constraint persons_cover_face_fk foreign key (cover_face_id) references faces(id) on delete set null;

-- biometric embeddings live in a schema the API role cannot read (§18.4, §18.9)
create table ml.face_embeddings (
  face_id uuid primary key references faces(id) on delete cascade,
  emb vector(512) not null,
  model text not null
);
create index face_embeddings_hnsw on ml.face_embeddings using hnsw (emb vector_cosine_ops);
create table ml.person_prototypes (
  person_id int not null references persons(id) on delete cascade,
  idx smallint not null,
  emb vector(512) not null,
  n_faces int not null,
  primary key (person_id, idx)
);
create table face_labels (
  face_id uuid not null references faces(id) on delete cascade,
  person_id int not null references persons(id) on delete cascade,
  verdict text not null check (verdict in ('confirm','reject')),
  by_user_id uuid not null references users(id),
  created_at timestamptz not null default now(),
  primary key (face_id, person_id)
);
create table unknown_clusters (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id) on delete cascade,
  face_ids uuid[] not null,
  cover_face_id uuid references faces(id) on delete set null,
  n int not null,
  dismissed boolean not null default false,
  created_at timestamptz not null default now()
);
create table ml.unknown_cluster_centroids (
  cluster_id uuid primary key references unknown_clusters(id) on delete cascade,
  centroid vector(512) not null
);

-- events ------------------------------------------------------------------------
create table places (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id) on delete cascade,
  name text,
  city text,
  lat double precision not null, lon double precision not null,
  radius_m real not null default 300,
  n_events int not null default 0,
  home_of_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index places_group on places (group_id);
create index places_name_trgm on places using gin (name gin_trgm_ops);

create table events (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id) on delete cascade,
  kind text not null default 'event' check (kind in ('event','trip','loose')),
  title_auto text,
  title_manual text,
  start_at timestamptz not null,
  end_at timestamptz not null,
  tz text,
  center_lat double precision, center_lon double precision,
  place_id uuid references places(id) on delete set null,
  contributor_ids uuid[] not null default '{}',
  person_ids int[] not null default '{}',
  n_assets int not null default 0,
  n_videos int not null default 0,
  confidence real not null default 0,
  cover_blob_id uuid references blobs(id) on delete set null,
  is_public_to_group boolean not null default false,
  opened_by_user_id uuid references users(id) on delete set null,
  opened_at timestamptz,
  suggested_splits timestamptz[] not null default '{}',
  algo_version int not null default 1,
  frozen boolean not null default false,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index events_group_time on events (group_id, start_at desc) where deleted_at is null;
create index events_people on events using gin (person_ids);
create index events_contributors on events using gin (contributor_ids);
create index events_public on events (group_id, start_at desc) where is_public_to_group and deleted_at is null;
create index events_title_trgm on events using gin ((coalesce(title_manual, title_auto)) gin_trgm_ops);

create table event_assets (
  event_id uuid not null references events(id) on delete cascade,
  asset_id uuid not null references assets(id) on delete cascade,
  blob_id uuid not null references blobs(id) on delete cascade,
  confidence real not null,
  tier text not null check (tier in ('confirmed','probable','uncertain')),
  source text not null check (source in ('auto','manual')),
  primary key (event_id, asset_id)
);
create index event_assets_blob on event_assets (blob_id);
create index event_assets_asset on event_assets (asset_id);

create table event_person_tags (
  event_id uuid not null references events(id) on delete cascade,
  person_id int not null references persons(id) on delete cascade,
  by_user_id uuid not null references users(id),
  created_at timestamptz not null default now(),
  primary key (event_id, person_id)
);
create table moments (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz not null,
  label text,
  n_assets int not null,
  blob_ids uuid[] not null,
  center_lat double precision, center_lon double precision
);
create index moments_event on moments (event_id, start_at);
create table event_constraints (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id) on delete cascade,
  kind text not null check (kind in ('pin_boundary','keep_together','exclude','include','frozen')),
  event_id uuid references events(id) on delete cascade,
  at timestamptz,
  asset_ids uuid[],
  by_user_id uuid not null references users(id),
  created_at timestamptz not null default now()
);
create index event_constraints_group on event_constraints (group_id);

-- ops ---------------------------------------------------------------------------
create table jobs (
  id bigserial primary key,
  kind text not null,
  payload jsonb not null,
  priority int not null default 0,
  dedupe_key text,
  run_after timestamptz not null default now(),
  attempts int not null default 0,
  max_attempts int not null default 5,
  locked_by text,
  locked_at timestamptz,
  done_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);
create index jobs_ready on jobs (kind, priority desc, run_after) where done_at is null and locked_by is null;
create unique index jobs_dedupe on jobs (dedupe_key) where dedupe_key is not null and done_at is null and locked_by is null;
create index jobs_locked on jobs (locked_at) where locked_by is not null and done_at is null;

create table audit_log (
  id bigserial primary key,
  group_id uuid references groups(id) on delete cascade,
  user_id uuid,
  action text not null,
  target_type text,
  target_id text,
  meta jsonb,
  ip inet,
  ua text,
  at timestamptz not null default now()
);
create index audit_group_time on audit_log (group_id, at desc);

create table search_text_cache (
  query text primary key,
  model text not null,
  emb vector(512) not null,
  created_at timestamptz not null default now()
);

-- derived-array maintenance (§11 notes) ---------------------------------------------
-- assets.person_ids := persons with a confirmed/high/probable face on the asset's blob
create or replace function app_refresh_asset_people(bids uuid[]) returns void language sql as $$
  update assets a set person_ids = coalesce((
    select array_agg(distinct f.person_id order by f.person_id) from faces f
    where f.blob_id = a.blob_id and f.person_id is not null and f.tier in ('confirmed','high','probable')
  ), '{}')
  where a.blob_id = any(bids);
$$;

-- events.person_ids / contributor_ids / counts
create or replace function app_refresh_events(eids uuid[]) returns void language sql as $$
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
      select array_agg(distinct a.owner_user_id order by a.owner_user_id)
      from event_assets ea join assets a on a.id = ea.asset_id
      where ea.event_id = e.id and a.deleted_at is null
    ), '{}'),
    n_assets = (select count(*) from event_assets ea join assets a on a.id = ea.asset_id where ea.event_id = e.id and a.deleted_at is null),
    n_videos = (select count(*) from event_assets ea join blobs b on b.id = ea.blob_id where ea.event_id = e.id and b.duration_ms is not null),
    updated_at = now()
  where e.id = any(eids);
$$;

create or replace function trg_faces_changed() returns trigger language plpgsql as $$
declare bids uuid[];
begin
  -- only identity-relevant changes matter (transition tables cannot be combined with column lists)
  select array_agg(distinct n.blob_id) into bids
  from new_rows n join old_rows o on o.id = n.id
  where n.person_id is distinct from o.person_id or n.tier is distinct from o.tier or n.blob_id <> o.blob_id;
  if bids is null then return null; end if;
  perform app_refresh_asset_people(bids);
  perform app_refresh_events((select array_agg(distinct event_id) from event_assets where blob_id = any(bids)));
  return null;
end $$;
-- Postgres needs distinct functions per transition-table shape; define thin wrappers.
create or replace function trg_faces_changed_ins() returns trigger language plpgsql as $$
declare bids uuid[];
begin
  select array_agg(distinct blob_id) into bids from new_rows;
  if bids is null then return null; end if;
  perform app_refresh_asset_people(bids);
  perform app_refresh_events((select array_agg(distinct event_id) from event_assets where blob_id = any(bids)));
  return null;
end $$;
create or replace function trg_faces_changed_del() returns trigger language plpgsql as $$
declare bids uuid[];
begin
  select array_agg(distinct blob_id) into bids from old_rows;
  if bids is null then return null; end if;
  perform app_refresh_asset_people(bids);
  perform app_refresh_events((select array_agg(distinct event_id) from event_assets where blob_id = any(bids)));
  return null;
end $$;
create trigger faces_ins after insert on faces referencing new table as new_rows
  for each statement execute function trg_faces_changed_ins();
create trigger faces_upd after update on faces referencing new table as new_rows old table as old_rows
  for each statement execute function trg_faces_changed();
create trigger faces_del after delete on faces referencing old table as old_rows
  for each statement execute function trg_faces_changed_del();

create or replace function trg_event_assets_ins() returns trigger language plpgsql as $$
begin
  perform app_refresh_events((select array_agg(distinct event_id) from new_rows));
  return null;
end $$;
create or replace function trg_event_assets_del() returns trigger language plpgsql as $$
begin
  perform app_refresh_events((select array_agg(distinct event_id) from old_rows));
  return null;
end $$;
create trigger event_assets_ins after insert on event_assets referencing new table as new_rows for each statement execute function trg_event_assets_ins();
create trigger event_assets_del after delete on event_assets referencing old table as old_rows for each statement execute function trg_event_assets_del();
create trigger event_person_tags_ins after insert on event_person_tags referencing new table as new_rows for each statement execute function trg_event_assets_ins();
create trigger event_person_tags_del after delete on event_person_tags referencing old table as old_rows for each statement execute function trg_event_assets_del();

-- asset soft-delete or owner change also changes contributor_ids
create or replace function trg_assets_upd() returns trigger language plpgsql as $$
declare eids uuid[];
begin
  select array_agg(distinct ea.event_id) into eids
  from new_rows n join old_rows o on o.id = n.id join event_assets ea on ea.asset_id = n.id
  where n.deleted_at is distinct from o.deleted_at or n.owner_user_id <> o.owner_user_id;
  if eids is not null then perform app_refresh_events(eids); end if;
  return null;
end $$;
create trigger assets_upd after update on assets referencing new table as new_rows old table as old_rows for each statement execute function trg_assets_upd();

-- invite acceptance runs with definer rights: the caller is not a member yet
create or replace function app_accept_invite(invite_code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare inv group_invites%rowtype; uid uuid := app_user_id();
begin
  if uid is null then raise exception 'no viewer';  end if;
  select * into inv from group_invites where code = invite_code for update;
  if not found or inv.used_at is not null or inv.revoked_at is not null or inv.expires_at < now() then
    raise exception 'invalid_invite' using errcode = 'P0001';
  end if;
  insert into group_members (group_id, user_id, role) values (inv.group_id, uid, 'member') on conflict do nothing;
  update group_invites set used_by = uid, used_at = now() where code = invite_code;
  return inv.group_id;
end $$;

-- presence-gated visibility (§18.3) ------------------------------------------------
create or replace function app_event_visible(gid uuid, contributor_ids uuid[], person_ids int[], is_public boolean) returns boolean
language sql stable as $$
  select gid = app_group_id() and (
    app_user_id() = any(contributor_ids)
    or (app_person_id() is not null and app_person_id() = any(person_ids))
    or is_public
  )
$$;

alter table groups enable row level security;            alter table groups force row level security;
alter table group_members enable row level security;     alter table group_members force row level security;
alter table group_invites enable row level security;     alter table group_invites force row level security;
alter table devices enable row level security;           alter table devices force row level security;
alter table blobs enable row level security;             alter table blobs force row level security;
alter table assets enable row level security;            alter table assets force row level security;
alter table derivatives enable row level security;       alter table derivatives force row level security;
alter table persons enable row level security;           alter table persons force row level security;
alter table faces enable row level security;             alter table faces force row level security;
alter table face_labels enable row level security;       alter table face_labels force row level security;
alter table unknown_clusters enable row level security;  alter table unknown_clusters force row level security;
alter table places enable row level security;            alter table places force row level security;
alter table events enable row level security;            alter table events force row level security;
alter table event_assets enable row level security;      alter table event_assets force row level security;
alter table event_person_tags enable row level security; alter table event_person_tags force row level security;
alter table moments enable row level security;           alter table moments force row level security;
alter table event_constraints enable row level security; alter table event_constraints force row level security;
alter table audit_log enable row level security;         alter table audit_log force row level security;

create policy groups_select on groups for select using (app_is_member(id));
create policy groups_insert on groups for insert with check (created_by = app_user_id());
create policy groups_update on groups for update using (app_is_owner(id));
create policy groups_delete on groups for delete using (app_is_owner(id));

create policy gm_select on group_members for select using (app_is_member(group_id));
create policy gm_insert on group_members for insert with check (user_id = app_user_id() or app_is_owner(group_id));
create policy gm_update on group_members for update using (user_id = app_user_id() or app_is_owner(group_id));
create policy gm_delete on group_members for delete using (user_id = app_user_id() or app_is_owner(group_id));

create policy gi_all on group_invites for all using (app_is_owner(group_id)) with check (app_is_owner(group_id) and created_by = app_user_id());

create policy dev_select on devices for select using (user_id = app_user_id() or exists (select 1 from group_members gm where gm.user_id = devices.user_id and gm.group_id = app_group_id()));
create policy dev_write on devices for insert with check (user_id = app_user_id());
create policy dev_update on devices for update using (user_id = app_user_id());
create policy dev_delete on devices for delete using (user_id = app_user_id());

create policy blobs_select on blobs for select using (group_id = app_group_id() and exists (select 1 from assets a where a.blob_id = blobs.id));
create policy blobs_insert on blobs for insert with check (group_id = app_group_id());
create policy blobs_update on blobs for update using (group_id = app_group_id() and exists (select 1 from assets a where a.blob_id = blobs.id));

create policy assets_select on assets for select using (
  group_id = app_group_id() and (owner_user_id = app_user_id() or exists (select 1 from event_assets ea where ea.asset_id = assets.id))
);
create policy assets_insert on assets for insert with check (group_id = app_group_id() and owner_user_id = app_user_id());
create policy assets_update on assets for update using (group_id = app_group_id() and owner_user_id = app_user_id());
create policy assets_delete on assets for delete using (group_id = app_group_id() and owner_user_id = app_user_id());

create policy deriv_select on derivatives for select using (exists (select 1 from blobs b where b.id = derivatives.blob_id));

create policy persons_select on persons for select using (group_id = app_group_id());
create policy persons_insert on persons for insert with check (group_id = app_group_id());
create policy persons_update on persons for update using (group_id = app_group_id());
create policy persons_delete on persons for delete using (group_id = app_group_id() and (user_id = app_user_id() or app_is_owner(group_id)));

create policy faces_select on faces for select using (exists (select 1 from blobs b where b.id = faces.blob_id));
create policy fl_select on face_labels for select using (exists (select 1 from faces f where f.id = face_labels.face_id));
create policy fl_insert on face_labels for insert with check (by_user_id = app_user_id() and exists (select 1 from faces f where f.id = face_labels.face_id));
create policy fl_update on face_labels for update using (exists (select 1 from faces f where f.id = face_labels.face_id));
create policy fl_delete on face_labels for delete using (exists (select 1 from faces f where f.id = face_labels.face_id));

create policy uc_select on unknown_clusters for select using (group_id = app_group_id() and exists (select 1 from faces f where f.id = any(unknown_clusters.face_ids)));
create policy uc_update on unknown_clusters for update using (group_id = app_group_id());

create policy places_select on places for select using (group_id = app_group_id());
create policy places_update on places for update using (group_id = app_group_id());

create policy events_select on events for select using (deleted_at is null and app_event_visible(group_id, contributor_ids, person_ids, is_public_to_group));
create policy events_update on events for update using (app_event_visible(group_id, contributor_ids, person_ids, is_public_to_group));

create policy ea_select on event_assets for select using (exists (select 1 from events e where e.id = event_assets.event_id));
create policy ea_insert on event_assets for insert with check (exists (select 1 from events e where e.id = event_assets.event_id));
create policy ea_delete on event_assets for delete using (exists (select 1 from events e where e.id = event_assets.event_id));

create policy ept_select on event_person_tags for select using (exists (select 1 from events e where e.id = event_person_tags.event_id));
create policy ept_insert on event_person_tags for insert with check (by_user_id = app_user_id() and exists (select 1 from events e where e.id = event_person_tags.event_id));
create policy ept_delete on event_person_tags for delete using (exists (select 1 from events e where e.id = event_person_tags.event_id));

create policy moments_select on moments for select using (exists (select 1 from events e where e.id = moments.event_id));

create policy ec_select on event_constraints for select using (group_id = app_group_id());
create policy ec_insert on event_constraints for insert with check (group_id = app_group_id() and by_user_id = app_user_id());
create policy ec_delete on event_constraints for delete using (group_id = app_group_id() and by_user_id = app_user_id());

create policy audit_insert on audit_log for insert with check (group_id is null or group_id = app_group_id());
create policy audit_select on audit_log for select using (app_is_owner(group_id));

-- grants ----------------------------------------------------------------------------
grant usage on schema public to minnegela_api, minnegela_worker;
grant usage on schema ml to minnegela_worker;
grant select, insert, update, delete on all tables in schema public to minnegela_api, minnegela_worker;
grant usage, select on all sequences in schema public to minnegela_api, minnegela_worker;
grant select, insert, update, delete on all tables in schema ml to minnegela_worker;
grant execute on all functions in schema public to minnegela_api, minnegela_worker;
alter default privileges in schema public grant select, insert, update, delete on tables to minnegela_api, minnegela_worker;
alter default privileges in schema public grant usage, select on sequences to minnegela_api, minnegela_worker;
alter default privileges in schema ml grant select, insert, update, delete on tables to minnegela_worker;
revoke all on schema ml from minnegela_api;
