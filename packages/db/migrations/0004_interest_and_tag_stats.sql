-- Feed interest (DESIGN §9.11), place routine factor, and per-group tag calibration statistics (§6.3).

alter table events
  add column interest real,                                  -- 0..1, null until the titles job has scored it
  add column interest_manual smallint check (interest_manual in (-1, 1));   -- member override: -1 quiet, +1 keep
create index events_group_interest on events (group_id, interest) where deleted_at is null;

alter table places add column routine real not null default 0;   -- 0..1: how much this place is "just home/studio"

create table ml.tag_stats (
  group_id uuid not null references groups(id) on delete cascade,
  vocab_version int not null,
  tag text not null,
  center real not null,
  scale real not null,
  n int not null,
  updated_at timestamptz not null default now(),
  primary key (group_id, vocab_version, tag)
);
grant select, insert, update, delete on ml.tag_stats to minnegela_worker;
