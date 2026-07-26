-- Run this once in Supabase: Dashboard > SQL Editor > New query > paste all > Run

create table if not exists stores (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'Active', -- 'Active' or 'Closed'
  epay_address text,
  epay text,
  vip_website_no text,
  vip_address text,
  elevate_name text,
  company_name text,
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

-- Accounting Checklist: monthly reconciliation & task tracker, per company.
create table if not exists checklist_items (
  id uuid primary key default gen_random_uuid(),
  company text not null,
  section text not null,
  item_name text not null,
  sort_order integer not null default 0,
  section_order integer not null default 0,
  jan text,
  feb text,
  mar text,
  apr text,
  may text,
  jun text,
  jul text,
  aug text,
  sep text,
  oct text,
  nov text,
  dec text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_checklist_items_updated_at on checklist_items;
create trigger trg_checklist_items_updated_at
before update on checklist_items
for each row execute function set_updated_at();

alter table checklist_items enable row level security;

drop policy if exists "Authenticated users can read checklist_items" on checklist_items;
create policy "Authenticated users can read checklist_items"
  on checklist_items for select
  to authenticated
  using (true);

drop policy if exists "Authenticated users can insert checklist_items" on checklist_items;
create policy "Authenticated users can insert checklist_items"
  on checklist_items for insert
  to authenticated
  with check (true);

drop policy if exists "Authenticated users can update checklist_items" on checklist_items;
create policy "Authenticated users can update checklist_items"
  on checklist_items for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists "Authenticated users can delete checklist_items" on checklist_items;
create policy "Authenticated users can delete checklist_items"
  on checklist_items for delete
  to authenticated
  using (true);

-- Mapping Master: editable lookup tables used by Bills/Sales instead of
-- hardcoded lists in code.

-- Product Mapping: a VIP Bill line is classified by its Products text (not
-- Memo, which is often generic or inconsistent) — whichever product_prefix
-- it starts with (case-insensitive) determines the expense_account.
create table if not exists product_mappings (
  id uuid primary key default gen_random_uuid(),
  product_prefix text not null,
  expense_account text not null,
  expense_memo text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_product_mappings_updated_at on product_mappings;
create trigger trg_product_mappings_updated_at
before update on product_mappings
for each row execute function set_updated_at();

alter table product_mappings enable row level security;

drop policy if exists "Authenticated users can read product_mappings" on product_mappings;
create policy "Authenticated users can read product_mappings"
  on product_mappings for select
  to authenticated
  using (true);

drop policy if exists "Authenticated users can insert product_mappings" on product_mappings;
create policy "Authenticated users can insert product_mappings"
  on product_mappings for insert
  to authenticated
  with check (true);

drop policy if exists "Authenticated users can update product_mappings" on product_mappings;
create policy "Authenticated users can update product_mappings"
  on product_mappings for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists "Authenticated users can delete product_mappings" on product_mappings;
create policy "Authenticated users can delete product_mappings"
  on product_mappings for delete
  to authenticated
  using (true);

insert into product_mappings (product_prefix, expense_account, expense_memo, notes) values
('Boost', 'All Devices', 'Mobile and Other Devices', 'All device SKUs are Products starting with Boost (case-insensitive, covers "BOOST 5G" too)'),
('Managed Services Level', 'Other Services VIP', null, 'Seeded default — confirm target account'),
('Xfinity Advantage Activations', 'Other Services VIP', null, 'Seeded default — confirm target account');

-- Door Mapping: fallback for VIP Door Numbers not yet in Store Master, so
-- a bill can still match a Company + QBO Class without a full store record.
create table if not exists door_mappings (
  id uuid primary key default gen_random_uuid(),
  door_number text not null,
  company_name text not null,
  qbo_class text not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_door_mappings_updated_at on door_mappings;
create trigger trg_door_mappings_updated_at
before update on door_mappings
for each row execute function set_updated_at();

alter table door_mappings enable row level security;

drop policy if exists "Authenticated users can read door_mappings" on door_mappings;
create policy "Authenticated users can read door_mappings"
  on door_mappings for select
  to authenticated
  using (true);

drop policy if exists "Authenticated users can insert door_mappings" on door_mappings;
create policy "Authenticated users can insert door_mappings"
  on door_mappings for insert
  to authenticated
  with check (true);

drop policy if exists "Authenticated users can update door_mappings" on door_mappings;
create policy "Authenticated users can update door_mappings"
  on door_mappings for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists "Authenticated users can delete door_mappings" on door_mappings;
create policy "Authenticated users can delete door_mappings"
  on door_mappings for delete
  to authenticated
  using (true);

-- Epay Account Mapping: fallback for Epay Account Numbers not yet in Store
-- Master's `epay` field, so an Epay invoice can still match a Company +
-- QBO Class without a full store record. Same idea as door_mappings, kept
-- separate since Epay's Account Number and VIP's Door Number are
-- different ID spaces.
create table if not exists epay_account_mappings (
  id uuid primary key default gen_random_uuid(),
  account_number text not null,
  company_name text not null,
  qbo_class text not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_epay_account_mappings_updated_at on epay_account_mappings;
create trigger trg_epay_account_mappings_updated_at
before update on epay_account_mappings
for each row execute function set_updated_at();

alter table epay_account_mappings enable row level security;

drop policy if exists "Authenticated users can read epay_account_mappings" on epay_account_mappings;
create policy "Authenticated users can read epay_account_mappings"
  on epay_account_mappings for select
  to authenticated
  using (true);

drop policy if exists "Authenticated users can insert epay_account_mappings" on epay_account_mappings;
create policy "Authenticated users can insert epay_account_mappings"
  on epay_account_mappings for insert
  to authenticated
  with check (true);

drop policy if exists "Authenticated users can update epay_account_mappings" on epay_account_mappings;
create policy "Authenticated users can update epay_account_mappings"
  on epay_account_mappings for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists "Authenticated users can delete epay_account_mappings" on epay_account_mappings;
create policy "Authenticated users can delete epay_account_mappings"
  on epay_account_mappings for delete
  to authenticated
  using (true);

-- Store Mapping: fallback for raw store names (from timesheet/inventory/
-- transfer uploads) that don't exactly match Store Master's Elevate Name
-- (renames, typos, casing drift) — maps the raw name to the correct
-- Elevate Name so Payroll, Change in Inventory, and Store Transfer can all
-- resolve it instead of excluding the row.
create table if not exists store_name_mappings (
  id uuid primary key default gen_random_uuid(),
  raw_name text not null unique,
  elevate_name text not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_store_name_mappings_updated_at on store_name_mappings;
create trigger trg_store_name_mappings_updated_at
before update on store_name_mappings
for each row execute function set_updated_at();

alter table store_name_mappings enable row level security;

drop policy if exists "Authenticated users can read store_name_mappings" on store_name_mappings;
create policy "Authenticated users can read store_name_mappings"
  on store_name_mappings for select
  to authenticated
  using (true);

drop policy if exists "Authenticated users can insert store_name_mappings" on store_name_mappings;
create policy "Authenticated users can insert store_name_mappings"
  on store_name_mappings for insert
  to authenticated
  with check (true);

drop policy if exists "Authenticated users can update store_name_mappings" on store_name_mappings;
create policy "Authenticated users can update store_name_mappings"
  on store_name_mappings for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists "Authenticated users can delete store_name_mappings" on store_name_mappings;
create policy "Authenticated users can delete store_name_mappings"
  on store_name_mappings for delete
  to authenticated
  using (true);

-- Payroll: company-wise payroll numbers typed in manually each pay period,
-- keyed by pay_period_date + company_name. Allocated to stores by hours
-- (uploaded Employee Timesheet, processed in-memory) and turned into a
-- Journal Entry export in the Payroll tab — nothing else from that flow is
-- persisted, same as Bills/Sales never persisting their uploaded rows.
create table if not exists payroll_company_data (
  id uuid primary key default gen_random_uuid(),
  pay_period_date date not null,
  company_name text not null,
  regular_earnings numeric not null default 0,
  bonus numeric not null default 0,
  overtime_earnings numeric not null default 0,
  additional_earnings numeric not null default 0,
  total_commission numeric not null default 0,
  gross_earnings numeric not null default 0,
  total_employee_deductions numeric not null default 0,
  total_employer_contributions numeric not null default 0,
  total_employee_taxes numeric not null default 0,
  total_employer_taxes numeric not null default 0,
  net_pay numeric not null default 0,
  total_employer_cost numeric not null default 0,
  check_amount numeric not null default 0,
  garnishments numeric not null default 0,
  total_reimbursements numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (pay_period_date, company_name)
);

drop trigger if exists trg_payroll_company_data_updated_at on payroll_company_data;
create trigger trg_payroll_company_data_updated_at
before update on payroll_company_data
for each row execute function set_updated_at();

alter table payroll_company_data enable row level security;

drop policy if exists "Authenticated users can read payroll_company_data" on payroll_company_data;
create policy "Authenticated users can read payroll_company_data"
  on payroll_company_data for select
  to authenticated
  using (true);

drop policy if exists "Authenticated users can insert payroll_company_data" on payroll_company_data;
create policy "Authenticated users can insert payroll_company_data"
  on payroll_company_data for insert
  to authenticated
  with check (true);

drop policy if exists "Authenticated users can update payroll_company_data" on payroll_company_data;
create policy "Authenticated users can update payroll_company_data"
  on payroll_company_data for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists "Authenticated users can delete payroll_company_data" on payroll_company_data;
create policy "Authenticated users can delete payroll_company_data"
  on payroll_company_data for delete
  to authenticated
  using (true);

-- Arcade & Subcontractor: same shape as payroll_company_data but only two
-- amount columns — a separate sub-tab under Payroll with its own pay
-- period date and its own Employee Timesheet upload/allocation run.
create table if not exists payroll_arcade_subcontractor_data (
  id uuid primary key default gen_random_uuid(),
  pay_period_date date not null,
  company_name text not null,
  arcade numeric not null default 0,
  subcontractor numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (pay_period_date, company_name)
);

drop trigger if exists trg_payroll_arcade_subcontractor_data_updated_at on payroll_arcade_subcontractor_data;
create trigger trg_payroll_arcade_subcontractor_data_updated_at
before update on payroll_arcade_subcontractor_data
for each row execute function set_updated_at();

alter table payroll_arcade_subcontractor_data enable row level security;

drop policy if exists "Authenticated users can read payroll_arcade_subcontractor_data" on payroll_arcade_subcontractor_data;
create policy "Authenticated users can read payroll_arcade_subcontractor_data"
  on payroll_arcade_subcontractor_data for select
  to authenticated
  using (true);

drop policy if exists "Authenticated users can insert payroll_arcade_subcontractor_data" on payroll_arcade_subcontractor_data;
create policy "Authenticated users can insert payroll_arcade_subcontractor_data"
  on payroll_arcade_subcontractor_data for insert
  to authenticated
  with check (true);

drop policy if exists "Authenticated users can update payroll_arcade_subcontractor_data" on payroll_arcade_subcontractor_data;
create policy "Authenticated users can update payroll_arcade_subcontractor_data"
  on payroll_arcade_subcontractor_data for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists "Authenticated users can delete payroll_arcade_subcontractor_data" on payroll_arcade_subcontractor_data;
create policy "Authenticated users can delete payroll_arcade_subcontractor_data"
  on payroll_arcade_subcontractor_data for delete
  to authenticated
  using (true);
