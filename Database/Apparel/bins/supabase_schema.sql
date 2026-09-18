-- ============================================================
-- CPI Price Entry Web - Supabase schema
-- Run once in Supabase > SQL Editor
-- Frontend must use ONLY publishable/anon key (never secret/service_role)
-- ============================================================

begin;

create table if not exists public.price_master (
  id bigint generated always as identity primary key,
  commodity_code text not null,
  code7 text generated always as (substring(commodity_code from 1 for 7)) stored,
  description text not null default '',
  item_name text not null default '',
  item_admin text not null default '',
  unit_code text not null default '',
  shop_code text not null,
  shop_name text not null default '',
  province_code text not null default '',
  province_name text not null default '',
  district_name text not null default '',
  region_name text not null default '',
  group_type text not null default '',
  flag_g boolean not null default false,
  flag_l boolean not null default false,
  flag_u boolean not null default false,
  flag_n boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint price_master_commodity_code_16_digits check (commodity_code ~ '^[0-9]{16}$'),
  constraint price_master_shop_code_10_digits check (shop_code ~ '^[0-9]{10}$'),
  constraint price_master_unique_item_shop unique (commodity_code, shop_code)
);

create table if not exists public.monthly_prices (
  id bigint generated always as identity primary key,
  master_id bigint not null references public.price_master(id) on update cascade on delete restrict,
  year_be integer not null,
  month integer not null,
  prev_price numeric(18,5),
  compare_price numeric(18,5),
  current_price numeric(18,5),
  rel numeric(18,5),
  is_checked boolean not null default true,
  product_status text not null default '',
  reviewer_remark text not null default '',
  confirmed boolean not null default false,
  submitted_at timestamptz,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint monthly_prices_year_be_check check (year_be between 2500 and 3000),
  constraint monthly_prices_month_check check (month between 1 and 12),
  constraint monthly_prices_prev_positive check (prev_price is null or prev_price > 0),
  constraint monthly_prices_compare_positive check (compare_price is null or compare_price > 0),
  constraint monthly_prices_current_positive check (current_price is null or current_price > 0),
  constraint monthly_prices_unique_period_item unique (master_id, year_be, month)
);

create index if not exists idx_price_master_code7 on public.price_master(code7);
create index if not exists idx_price_master_province on public.price_master(province_name);
create index if not exists idx_price_master_region on public.price_master(region_name);
create index if not exists idx_price_master_shop on public.price_master(shop_code);
create index if not exists idx_monthly_prices_period on public.monthly_prices(year_be, month);
create index if not exists idx_monthly_prices_master on public.monthly_prices(master_id);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_price_master_touch on public.price_master;
create trigger trg_price_master_touch
before update on public.price_master
for each row execute function public.touch_updated_at();

-- REL = current_price / compare_price * 100
-- Database stores REL at 5 decimal places. A compare price of 0 is never accepted.
create or replace function public.monthly_prices_calculate()
returns trigger
language plpgsql
set search_path = public, auth
as $$
begin
  new.updated_at := now();

  if auth.uid() is not null then
    new.updated_by := auth.uid();
  end if;

  if new.current_price is not null and new.compare_price is not null and new.compare_price > 0 then
    new.rel := round((new.current_price / new.compare_price) * 100, 5);
  else
    new.rel := null;
  end if;

  if new.confirmed = true and (tg_op = 'INSERT' or old.confirmed is distinct from true) then
    new.submitted_at := now();
  elsif new.confirmed = false then
    new.submitted_at := null;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_monthly_prices_calculate on public.monthly_prices;
create trigger trg_monthly_prices_calculate
before insert or update on public.monthly_prices
for each row execute function public.monthly_prices_calculate();

-- Prepare a new month from active master data.
-- Previous month current_price -> prev_price and compare_price.
-- Safe to run repeatedly: existing rows are not overwritten.
create or replace function public.prepare_month(p_year_be integer, p_month integer)
returns integer
language plpgsql
security invoker
set search_path = public, auth
as $$
declare
  v_prev_year integer;
  v_prev_month integer;
  v_inserted integer;
begin
  if p_year_be < 2500 or p_year_be > 3000 or p_month < 1 or p_month > 12 then
    raise exception 'Invalid Buddhist year/month';
  end if;

  if p_month = 1 then
    v_prev_year := p_year_be - 1;
    v_prev_month := 12;
  else
    v_prev_year := p_year_be;
    v_prev_month := p_month - 1;
  end if;

  insert into public.monthly_prices (
    master_id, year_be, month, prev_price, compare_price,
    is_checked, updated_by
  )
  select
    m.id,
    p_year_be,
    p_month,
    p.current_price,
    p.current_price,
    (m.flag_g or m.flag_l or m.flag_u),
    auth.uid()
  from public.price_master m
  left join public.monthly_prices p
    on p.master_id = m.id
   and p.year_be = v_prev_year
   and p.month = v_prev_month
  where m.is_active = true
  on conflict (master_id, year_be, month) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

-- -----------------------
-- Security / RLS
-- -----------------------
alter table public.price_master enable row level security;
alter table public.monthly_prices enable row level security;

revoke all on table public.price_master from anon;
revoke all on table public.monthly_prices from anon;

grant select, insert, update on table public.price_master to authenticated;
grant select, insert, update on table public.monthly_prices to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on function public.prepare_month(integer, integer) to authenticated;

-- Internal staff model: any authenticated user can view and edit shared CPI data.
-- If you later need province/user-level permissions, replace these policies.
drop policy if exists price_master_authenticated_select on public.price_master;
create policy price_master_authenticated_select
on public.price_master for select to authenticated
using (true);

drop policy if exists price_master_authenticated_insert on public.price_master;
create policy price_master_authenticated_insert
on public.price_master for insert to authenticated
with check (true);

drop policy if exists price_master_authenticated_update on public.price_master;
create policy price_master_authenticated_update
on public.price_master for update to authenticated
using (true) with check (true);

drop policy if exists monthly_prices_authenticated_select on public.monthly_prices;
create policy monthly_prices_authenticated_select
on public.monthly_prices for select to authenticated
using (true);

drop policy if exists monthly_prices_authenticated_insert on public.monthly_prices;
create policy monthly_prices_authenticated_insert
on public.monthly_prices for insert to authenticated
with check (true);

drop policy if exists monthly_prices_authenticated_update on public.monthly_prices;
create policy monthly_prices_authenticated_update
on public.monthly_prices for update to authenticated
using (true) with check (true);

commit;
