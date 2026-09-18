-- ============================================================
-- CPI Price Entry Web V3 - RESET DATABASE
-- คำเตือน: ไฟล์นี้ลบข้อมูล price_master และ monthly_prices ทั้งหมด
-- ใช้เฉพาะกรณีต้องการเริ่มฐานใหม่จากศูนย์
-- ============================================================

begin;
drop table if exists public.monthly_prices cascade;
drop table if exists public.price_master cascade;
drop function if exists public.prepare_month(integer,integer);
drop function if exists public.monthly_prices_calculate();
drop function if exists public.touch_updated_at();
commit;

-- ============================================================
-- CPI Price Entry Web V3 - CREATE AFTER RESET
-- ใช้ไฟล์นี้ถ้าต้องการเก็บข้อมูลเดิมไว้
-- Run ใน Supabase > SQL Editor
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
  updated_at timestamptz not null default now()
);

-- รองรับฐานเดิมที่อาจมีคอลัมน์ไม่ครบ
alter table public.price_master add column if not exists description text not null default '';
alter table public.price_master add column if not exists item_name text not null default '';
alter table public.price_master add column if not exists item_admin text not null default '';
alter table public.price_master add column if not exists unit_code text not null default '';
alter table public.price_master add column if not exists shop_name text not null default '';
alter table public.price_master add column if not exists province_code text not null default '';
alter table public.price_master add column if not exists province_name text not null default '';
alter table public.price_master add column if not exists district_name text not null default '';
alter table public.price_master add column if not exists region_name text not null default '';
alter table public.price_master add column if not exists group_type text not null default '';
alter table public.price_master add column if not exists flag_g boolean not null default false;
alter table public.price_master add column if not exists flag_l boolean not null default false;
alter table public.price_master add column if not exists flag_u boolean not null default false;
alter table public.price_master add column if not exists flag_n boolean not null default false;
alter table public.price_master add column if not exists is_active boolean not null default true;
alter table public.price_master add column if not exists created_at timestamptz not null default now();
alter table public.price_master add column if not exists updated_at timestamptz not null default now();

-- เพิ่ม CODE7 แบบ generated เฉพาะกรณีฐานเก่ายังไม่มี
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='price_master' AND column_name='code7'
  ) THEN
    EXECUTE 'ALTER TABLE public.price_master ADD COLUMN code7 text GENERATED ALWAYS AS (substring(commodity_code from 1 for 7)) STORED';
  END IF;
END $$;

create unique index if not exists ux_price_master_item_shop
  on public.price_master(commodity_code, shop_code);
create index if not exists idx_price_master_code7 on public.price_master(code7);
create index if not exists idx_price_master_province on public.price_master(province_name);
create index if not exists idx_price_master_region on public.price_master(region_name);
create index if not exists idx_price_master_shop on public.price_master(shop_code);

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
  updated_at timestamptz not null default now()
);

alter table public.monthly_prices add column if not exists prev_price numeric(18,5);
alter table public.monthly_prices add column if not exists compare_price numeric(18,5);
alter table public.monthly_prices add column if not exists current_price numeric(18,5);
alter table public.monthly_prices add column if not exists rel numeric(18,5);
alter table public.monthly_prices add column if not exists is_checked boolean not null default true;
alter table public.monthly_prices add column if not exists product_status text not null default '';
alter table public.monthly_prices add column if not exists reviewer_remark text not null default '';
alter table public.monthly_prices add column if not exists confirmed boolean not null default false;
alter table public.monthly_prices add column if not exists submitted_at timestamptz;
alter table public.monthly_prices add column if not exists updated_by uuid;
alter table public.monthly_prices add column if not exists created_at timestamptz not null default now();
alter table public.monthly_prices add column if not exists updated_at timestamptz not null default now();

create unique index if not exists ux_monthly_prices_period_item
  on public.monthly_prices(master_id, year_be, month);
create index if not exists idx_monthly_prices_period on public.monthly_prices(year_be, month);
create index if not exists idx_monthly_prices_master on public.monthly_prices(master_id);

-- ตรวจปี/เดือนและราคาให้ถูกต้อง
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='monthly_prices_year_be_check' AND conrelid='public.monthly_prices'::regclass) THEN
    ALTER TABLE public.monthly_prices ADD CONSTRAINT monthly_prices_year_be_check CHECK (year_be between 2500 and 3000) NOT VALID;
    ALTER TABLE public.monthly_prices VALIDATE CONSTRAINT monthly_prices_year_be_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='monthly_prices_month_check' AND conrelid='public.monthly_prices'::regclass) THEN
    ALTER TABLE public.monthly_prices ADD CONSTRAINT monthly_prices_month_check CHECK (month between 1 and 12) NOT VALID;
    ALTER TABLE public.monthly_prices VALIDATE CONSTRAINT monthly_prices_month_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='monthly_prices_prev_positive' AND conrelid='public.monthly_prices'::regclass) THEN
    ALTER TABLE public.monthly_prices ADD CONSTRAINT monthly_prices_prev_positive CHECK (prev_price is null or prev_price > 0) NOT VALID;
    ALTER TABLE public.monthly_prices VALIDATE CONSTRAINT monthly_prices_prev_positive;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='monthly_prices_compare_positive' AND conrelid='public.monthly_prices'::regclass) THEN
    ALTER TABLE public.monthly_prices ADD CONSTRAINT monthly_prices_compare_positive CHECK (compare_price is null or compare_price > 0) NOT VALID;
    ALTER TABLE public.monthly_prices VALIDATE CONSTRAINT monthly_prices_compare_positive;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='monthly_prices_current_positive' AND conrelid='public.monthly_prices'::regclass) THEN
    ALTER TABLE public.monthly_prices ADD CONSTRAINT monthly_prices_current_positive CHECK (current_price is null or current_price > 0) NOT VALID;
    ALTER TABLE public.monthly_prices VALIDATE CONSTRAINT monthly_prices_current_positive;
  END IF;
END $$;

-- ตรวจรหัส Master 16 / 10 หลัก ถ้ายังไม่มี constraint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='price_master_commodity_code_16_digits' AND conrelid='public.price_master'::regclass) THEN
    ALTER TABLE public.price_master ADD CONSTRAINT price_master_commodity_code_16_digits CHECK (commodity_code ~ '^[0-9]{16}$') NOT VALID;
    ALTER TABLE public.price_master VALIDATE CONSTRAINT price_master_commodity_code_16_digits;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='price_master_shop_code_10_digits' AND conrelid='public.price_master'::regclass) THEN
    ALTER TABLE public.price_master ADD CONSTRAINT price_master_shop_code_10_digits CHECK (shop_code ~ '^[0-9]{10}$') NOT VALID;
    ALTER TABLE public.price_master VALIDATE CONSTRAINT price_master_shop_code_10_digits;
  END IF;
END $$;

create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path=public as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_price_master_touch on public.price_master;
create trigger trg_price_master_touch
before update on public.price_master
for each row execute function public.touch_updated_at();

-- REL เก็บ 5 ตำแหน่ง
create or replace function public.monthly_prices_calculate()
returns trigger
language plpgsql
set search_path=public,auth
as $$
begin
  new.updated_at := now();
  if auth.uid() is not null then new.updated_by := auth.uid(); end if;

  if new.current_price is not null and new.compare_price is not null and new.compare_price > 0 then
    new.rel := round((new.current_price / new.compare_price) * 100, 5);
  else
    new.rel := null;
  end if;

  if new.confirmed = true then
    if tg_op = 'INSERT' then
      new.submitted_at := coalesce(new.submitted_at, now());
    elsif old.confirmed is distinct from true then
      new.submitted_at := now();
    end if;
  else
    new.submitted_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_monthly_prices_calculate on public.monthly_prices;
create trigger trg_monthly_prices_calculate
before insert or update on public.monthly_prices
for each row execute function public.monthly_prices_calculate();

-- เตรียมเดือนใหม่: ราคาปัจจุบันเดือนก่อน -> ราคาเดือนก่อน + ราคาเปรียบเทียบ
create or replace function public.prepare_month(p_year_be integer, p_month integer)
returns integer
language plpgsql
security invoker
set search_path=public,auth
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

  insert into public.monthly_prices(master_id,year_be,month,prev_price,compare_price,is_checked,updated_by)
  select m.id,p_year_be,p_month,p.current_price,p.current_price,
         (m.flag_g or m.flag_l or m.flag_u),auth.uid()
  from public.price_master m
  left join public.monthly_prices p
    on p.master_id=m.id and p.year_be=v_prev_year and p.month=v_prev_month
  where m.is_active=true
  on conflict (master_id,year_be,month) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

-- RLS
alter table public.price_master enable row level security;
alter table public.monthly_prices enable row level security;
revoke all on table public.price_master from anon;
revoke all on table public.monthly_prices from anon;
grant select,insert,update on table public.price_master to authenticated;
grant select,insert,update on table public.monthly_prices to authenticated;
grant usage,select on all sequences in schema public to authenticated;
grant execute on function public.prepare_month(integer,integer) to authenticated;

drop policy if exists price_master_authenticated_select on public.price_master;
create policy price_master_authenticated_select on public.price_master for select to authenticated using (true);
drop policy if exists price_master_authenticated_insert on public.price_master;
create policy price_master_authenticated_insert on public.price_master for insert to authenticated with check (true);
drop policy if exists price_master_authenticated_update on public.price_master;
create policy price_master_authenticated_update on public.price_master for update to authenticated using (true) with check (true);

drop policy if exists monthly_prices_authenticated_select on public.monthly_prices;
create policy monthly_prices_authenticated_select on public.monthly_prices for select to authenticated using (true);
drop policy if exists monthly_prices_authenticated_insert on public.monthly_prices;
create policy monthly_prices_authenticated_insert on public.monthly_prices for insert to authenticated with check (true);
drop policy if exists monthly_prices_authenticated_update on public.monthly_prices;
create policy monthly_prices_authenticated_update on public.monthly_prices for update to authenticated using (true) with check (true);

commit;
