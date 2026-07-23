-- Run this once in Supabase: Dashboard > SQL Editor > New query > paste all > Run

create table if not exists stores (
  id uuid primary key default gen_random_uuid(),
  epay_address text,
  epay text,
  vip_website_no text,
  vip_address text,
  company text,
  elevate_name text,
  company_name text,
  qbo_class_name text,
  new_qbo_class text,
  elevate_name_new_qbo_class text,
  ondigo_address text,
  salesforce_id text,
  rbfc_market text,
  asm text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- keep updated_at current on every edit
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_stores_updated_at on stores;
create trigger trg_stores_updated_at
before update on stores
for each row execute function set_updated_at();

-- Row Level Security: any logged-in team member can read/write.
-- (Everyone gets full edit access, per your team's requirement.)
alter table stores enable row level security;

drop policy if exists "Authenticated users can read stores" on stores;
create policy "Authenticated users can read stores"
  on stores for select
  to authenticated
  using (true);

drop policy if exists "Authenticated users can insert stores" on stores;
create policy "Authenticated users can insert stores"
  on stores for insert
  to authenticated
  with check (true);

drop policy if exists "Authenticated users can update stores" on stores;
create policy "Authenticated users can update stores"
  on stores for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists "Authenticated users can delete stores" on stores;
create policy "Authenticated users can delete stores"
  on stores for delete
  to authenticated
  using (true);
