-- Create announcements table for in-app banners/promotions
create table if not exists announcements (
  id uuid primary key default gen_random_uuid(),
  title text,
  message text not null,
  image_url text,
  link_url text,
  buttons jsonb,                        -- [{label, url}]
  placements text[],                    -- e.g. {'global','match','explore'}
  audience text default 'all',          -- 'all' | 'paid' | 'free' | 'region:<code>' | etc.
  countries text[],                     -- optional ISO country codes
  min_app_version text,                 -- optional semver string
  priority int default 0,
  starts_at timestamptz,
  ends_at timestamptz,
  is_active boolean default true,
  send_push_on_publish boolean default false,
  created_by uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  published_at timestamptz
);

create index if not exists idx_announcements_active_window
  on announcements (is_active, starts_at, ends_at);

create index if not exists idx_announcements_priority
  on announcements (priority desc, published_at desc nulls last, created_at desc);

-- Optional helper view for active announcements
create or replace view v_active_announcements as
select * from announcements
where is_active = true
  and (starts_at is null or now() >= starts_at)
  and (ends_at is null or now() <= ends_at);
