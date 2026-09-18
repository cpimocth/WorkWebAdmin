-- CPI Price Web V6.3 - FRESH RESET
-- WARNING: DESTRUCTIVE.
-- This script permanently deletes price_master and monthly_prices data,
-- recreates the schema for V6.3, and enables month-to-month carry-forward.
-- Use only when you intentionally want to start over.

begin;

-- =========================================================
-- 0) CLEAN OLD OBJECTS
-- =========================================================
drop table if exists public.monthly_prices cascade;
drop table if exists public.price_master cascade;

-- Clean obsolete/current helper functions so RESET is deterministic.
drop function if exists public.prepare_month(integer,integer) cascade;
drop function if exists public.monthly_prices_sync_next() cascade;
drop function if exists public.monthly_prices_sync_next_prev() cascade;
drop function if exists public.monthly_prices_calculate() cascade;
drop function if exists public.price_master_normalize_flags() cascade;
drop function if exists public.touch_updated_at() cascade;

-- =========================================================
-- 1) MASTER DATA
-- =========================================================
create table public.price_master (
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

  constraint price_master_commodity_code_16_digits
    check (commodity_code ~ '^[0-9]{16}$'),
  constraint price_master_shop_code_10_digits
    check (shop_code ~ '^[0-9]{10}$')
);

create unique index ux_price_master_item_shop
  on public.price_master(commodity_code,shop_code);
create index idx_price_master_code7 on public.price_master(code7);
create index idx_price_master_province on public.price_master(province_name);
create index idx_price_master_region on public.price_master(region_name);
create index idx_price_master_shop on public.price_master(shop_code);

-- N is exclusive in Master as well.
create or replace function public.price_master_normalize_flags()
returns trigger
language plpgsql
set search_path=public
as $$
begin
  new.updated_at:=now();
  if new.flag_n then
    new.flag_g:=false;
    new.flag_l:=false;
    new.flag_u:=false;
  end if;
  return new;
end;
$$;

create trigger trg_price_master_normalize_flags
before insert or update on public.price_master
for each row execute function public.price_master_normalize_flags();

-- =========================================================
-- 2) MONTHLY PRICE DATA
-- =========================================================
create table public.monthly_prices (
  id bigint generated always as identity primary key,
  master_id bigint not null
    references public.price_master(id) on update cascade on delete restrict,
  year_be integer not null check (year_be between 2500 and 3000),
  month integer not null check (month between 1 and 12),

  prev_price numeric(18,5) check (prev_price is null or prev_price > 0),
  current_price numeric(18,5) check (current_price is null or current_price > 0),
  link_mode text not null default 'N' check (link_mode in ('N','1','2','3')),
  compare_price numeric(18,5) check (compare_price is null or compare_price > 0),
  rel numeric(18,5),

  flag_g boolean not null default false,
  flag_l boolean not null default false,
  flag_u boolean not null default false,
  flag_n boolean not null default false,

  -- false = inherited from previous month and may keep following it.
  -- true  = user explicitly saved G/L/U/N for this month.
  flags_manual boolean not null default false,

  product_status text not null default '',
  reviewer_remark text not null default '',
  reviewer_status text not null default '',

  updated_by uuid,
  updated_by_email text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index ux_monthly_prices_period_item
  on public.monthly_prices(master_id,year_be,month);
create index idx_monthly_prices_period on public.monthly_prices(year_be,month);
create index idx_monthly_prices_master on public.monthly_prices(master_id);

-- =========================================================
-- 3) MONTHLY CALCULATION + AUDIT + N EXCLUSIVITY
-- =========================================================
create or replace function public.monthly_prices_calculate()
returns trigger
language plpgsql
set search_path=public,auth
as $$
begin
  -- Only direct user/API edits change audit metadata.
  -- Nested propagation to next month should not pretend the user edited it.
  if pg_trigger_depth() <= 1 then
    new.updated_at:=now();
    if auth.uid() is not null then
      new.updated_by:=auth.uid();
      new.updated_by_email:=coalesce(auth.jwt()->>'email',auth.uid()::text);
    end if;
  end if;

  -- N is exclusive.
  if new.flag_n then
    new.flag_g:=false;
    new.flag_l:=false;
    new.flag_u:=false;
  end if;

  -- Link rules.
  new.link_mode:=coalesce(nullif(upper(trim(new.link_mode)),''),'N');
  if new.link_mode not in ('N','1','2','3') then
    raise exception 'Invalid Link mode: %',new.link_mode;
  end if;

  if new.link_mode='N' then
    new.compare_price:=new.prev_price;
  elsif new.link_mode in ('1','2') then
    new.compare_price:=new.current_price;
  end if;
  -- Link 3 leaves compare_price freely editable.

  -- REL at 5 decimal places.
  if new.current_price is not null
     and new.compare_price is not null
     and new.compare_price>0 then
    new.rel:=round((new.current_price/new.compare_price)*100,5);
  else
    new.rel:=null;
  end if;

  return new;
end;
$$;

create trigger trg_monthly_prices_calculate
before insert or update on public.monthly_prices
for each row execute function public.monthly_prices_calculate();

-- =========================================================
-- 4) PROPAGATE VALUES TO AN ALREADY-CREATED NEXT MONTH
-- =========================================================
-- current_price       -> next.prev_price
-- reviewer_status     -> next.product_status
-- G/L/U/N             -> next month only while next.flags_manual = false
create or replace function public.monthly_prices_sync_next()
returns trigger
language plpgsql
security invoker
set search_path=public
as $$
declare
  v_next_year integer;
  v_next_month integer;
begin
  if new.month=12 then
    v_next_year:=new.year_be+1;
    v_next_month:=1;
  else
    v_next_year:=new.year_be;
    v_next_month:=new.month+1;
  end if;

  update public.monthly_prices nxt
     set prev_price = new.current_price,
         product_status = coalesce(new.reviewer_status,''),
         flag_g = case when not nxt.flags_manual then new.flag_g else nxt.flag_g end,
         flag_l = case when not nxt.flags_manual then new.flag_l else nxt.flag_l end,
         flag_u = case when not nxt.flags_manual then new.flag_u else nxt.flag_u end,
         flag_n = case when not nxt.flags_manual then new.flag_n else nxt.flag_n end
   where nxt.master_id=new.master_id
     and nxt.year_be=v_next_year
     and nxt.month=v_next_month;

  return new;
end;
$$;

create trigger trg_monthly_prices_sync_next
after insert or update of current_price,reviewer_status,flag_g,flag_l,flag_u,flag_n
on public.monthly_prices
for each row execute function public.monthly_prices_sync_next();

-- =========================================================
-- 5) PREPARE MONTH FROM IMMEDIATELY PREVIOUS MONTH
-- =========================================================
create or replace function public.prepare_month(p_year_be integer,p_month integer)
returns integer
language plpgsql
security invoker
set search_path=public,auth
as $$
declare
  v_prev_year integer;
  v_prev_month integer;
  v_affected integer;
begin
  if p_year_be<2500 or p_year_be>3000 or p_month<1 or p_month>12 then
    raise exception 'Invalid Buddhist year/month';
  end if;

  if p_month=1 then
    v_prev_year:=p_year_be-1;
    v_prev_month:=12;
  else
    v_prev_year:=p_year_be;
    v_prev_month:=p_month-1;
  end if;

  insert into public.monthly_prices(
    master_id,year_be,month,
    prev_price,current_price,link_mode,compare_price,
    flag_g,flag_l,flag_u,flag_n,flags_manual,
    product_status,reviewer_status,
    updated_by,updated_by_email
  )
  select
    m.id,p_year_be,p_month,
    p.current_price,null,'N',p.current_price,
    case
      when coalesce(p.flag_n,m.flag_n) then false
      when p.id is not null then p.flag_g
      else m.flag_g
    end,
    case
      when coalesce(p.flag_n,m.flag_n) then false
      when p.id is not null then p.flag_l
      else m.flag_l
    end,
    case
      when coalesce(p.flag_n,m.flag_n) then false
      when p.id is not null then p.flag_u
      else m.flag_u
    end,
    case when p.id is not null then p.flag_n else m.flag_n end,
    false,
    coalesce(p.reviewer_status,''),'',
    auth.uid(),coalesce(auth.jwt()->>'email',auth.uid()::text,'')
  from public.price_master m
  left join public.monthly_prices p
    on p.master_id=m.id
   and p.year_be=v_prev_year
   and p.month=v_prev_month
  where m.is_active=true
  on conflict (master_id,year_be,month) do update
     set prev_price=excluded.prev_price,
         product_status=excluded.product_status,
         flag_g=case when not public.monthly_prices.flags_manual then excluded.flag_g else public.monthly_prices.flag_g end,
         flag_l=case when not public.monthly_prices.flags_manual then excluded.flag_l else public.monthly_prices.flag_l end,
         flag_u=case when not public.monthly_prices.flags_manual then excluded.flag_u else public.monthly_prices.flag_u end,
         flag_n=case when not public.monthly_prices.flags_manual then excluded.flag_n else public.monthly_prices.flag_n end,
         updated_by=auth.uid(),
         updated_by_email=coalesce(auth.jwt()->>'email',auth.uid()::text,public.monthly_prices.updated_by_email);

  get diagnostics v_affected=row_count;
  return v_affected;
end;
$$;

-- =========================================================
-- 6) SECURITY / RLS
-- =========================================================
alter table public.price_master enable row level security;
alter table public.monthly_prices enable row level security;

revoke all on table public.price_master from anon;
revoke all on table public.monthly_prices from anon;

grant select,insert,update on table public.price_master to authenticated;
grant select,insert,update on table public.monthly_prices to authenticated;
grant usage,select on all sequences in schema public to authenticated;
grant execute on function public.prepare_month(integer,integer) to authenticated;

create policy price_master_authenticated_select
  on public.price_master for select to authenticated using (true);
create policy price_master_authenticated_insert
  on public.price_master for insert to authenticated with check (true);
create policy price_master_authenticated_update
  on public.price_master for update to authenticated using (true) with check (true);

create policy monthly_prices_authenticated_select
  on public.monthly_prices for select to authenticated using (true);
create policy monthly_prices_authenticated_insert
  on public.monthly_prices for insert to authenticated with check (true);
create policy monthly_prices_authenticated_update
  on public.monthly_prices for update to authenticated using (true) with check (true);

commit;
