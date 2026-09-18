-- CPI Price Web V6.4 - OPTIONAL PRODUCT/SHOP CODES
-- SAFE UPGRADE: keeps existing data.
-- Required: code7 / รหัสรายการ / รหัสหมวด = exactly 7 digits.
-- Optional: commodity_code (16 digits if supplied), shop_code (10 digits if supplied).

begin;

-- =========================================================
-- 1) CHANGE MASTER VALIDATION
-- =========================================================
-- Existing V6.3 code7 may be a generated column derived from commodity_code.
-- Convert it to a normal stored column so CODE7 can exist without commodity_code.
do $$
begin
  begin
    alter table public.price_master alter column code7 drop expression;
  exception when others then
    null;
  end;
end $$;

alter table public.price_master alter column commodity_code drop not null;
alter table public.price_master alter column shop_code drop not null;

-- Ensure old rows still have code7 before making it required.
update public.price_master
set code7=substring(commodity_code from 1 for 7)
where (code7 is null or trim(code7)='')
  and commodity_code ~ '^[0-9]{16}$';

-- Fail clearly only if an old row truly has no category/item code.
do $$
begin
  if exists(select 1 from public.price_master where code7 is null or code7 !~ '^[0-9]{7}$') then
    raise exception 'Cannot upgrade: some price_master rows do not have a valid 7-digit CODE7/รหัสรายการ';
  end if;
end $$;

alter table public.price_master alter column code7 set not null;

alter table public.price_master drop constraint if exists price_master_commodity_code_16_digits;
alter table public.price_master drop constraint if exists price_master_shop_code_10_digits;
alter table public.price_master drop constraint if exists price_master_code7_7_digits;
alter table public.price_master drop constraint if exists price_master_commodity_code_optional_16_digits;
alter table public.price_master drop constraint if exists price_master_shop_code_optional_10_digits;
alter table public.price_master drop constraint if exists price_master_commodity_matches_code7;

alter table public.price_master
  add constraint price_master_code7_7_digits
    check (code7 ~ '^[0-9]{7}$'),
  add constraint price_master_commodity_code_optional_16_digits
    check (commodity_code is null or commodity_code ~ '^[0-9]{16}$'),
  add constraint price_master_shop_code_optional_10_digits
    check (shop_code is null or shop_code ~ '^[0-9]{10}$'),
  add constraint price_master_commodity_matches_code7
    check (commodity_code is null or substring(commodity_code from 1 for 7)=code7);

-- =========================================================
-- 2) STABLE IMPORT KEY
-- =========================================================
create or replace function public.make_price_master_key(
  p_code7 text, p_commodity text, p_shop text, p_description text,
  p_item_name text, p_unit text, p_shop_name text,
  p_province text, p_district text, p_region text
)
returns text
language plpgsql
immutable
set search_path=public
as $$
begin
  return
    'M|' || lower(trim(coalesce(p_code7,''))) || '|' ||
    lower(trim(coalesce(p_commodity,''))) || '|' ||
    lower(trim(coalesce(p_shop,''))) || '|' ||
    lower(trim(coalesce(p_description,''))) || '|' ||
    lower(trim(coalesce(p_item_name,''))) || '|' ||
    lower(trim(coalesce(p_unit,''))) || '|' ||
    lower(trim(coalesce(p_shop_name,''))) || '|' ||
    lower(trim(coalesce(p_province,''))) || '|' ||
    lower(trim(coalesce(p_district,''))) || '|' ||
    lower(trim(coalesce(p_region,'')));
end;
$$;

alter table public.price_master add column if not exists master_key text;

-- Normalize blanks to NULL for the two optional codes.
update public.price_master
set commodity_code=nullif(trim(coalesce(commodity_code,'')),''),
    shop_code=nullif(trim(coalesce(shop_code,'')),'');

update public.price_master
set master_key=public.make_price_master_key(
  code7,commodity_code,shop_code,description,item_name,unit_code,
  shop_name,province_name,district_name,region_name
);

-- Existing V6.3 rows have unique commodity/shop pairs, so this should be unique.
-- If an unusual legacy duplicate exists, suffix only that duplicate to preserve data.
with d as (
  select id,master_key,row_number() over(partition by master_key order by id) rn
  from public.price_master
)
update public.price_master p
set master_key=p.master_key||'|legacy-id:'||p.id
from d
where p.id=d.id and d.rn>1;

alter table public.price_master alter column master_key set not null;
drop index if exists public.ux_price_master_master_key;
create unique index ux_price_master_master_key on public.price_master(master_key);

-- Keep legacy pair uniqueness only when both optional codes exist.
drop index if exists public.ux_price_master_item_shop;
create unique index ux_price_master_item_shop
  on public.price_master(commodity_code,shop_code)
  where commodity_code is not null and shop_code is not null;

-- =========================================================
-- 3) NORMALIZE + BUILD KEY ON EVERY MASTER SAVE
-- =========================================================
create or replace function public.price_master_normalize_flags()
returns trigger
language plpgsql
set search_path=public
as $$
begin
  new.commodity_code:=nullif(trim(coalesce(new.commodity_code,'')),'');
  new.shop_code:=nullif(trim(coalesce(new.shop_code,'')),'');
  new.code7:=trim(coalesce(new.code7,''));
  new.updated_at:=now();

  if new.flag_n then
    new.flag_g:=false; new.flag_l:=false; new.flag_u:=false;
  end if;

  new.master_key:=public.make_price_master_key(
    new.code7,new.commodity_code,new.shop_code,new.description,
    new.item_name,new.unit_code,new.shop_name,new.province_name,
    new.district_name,new.region_name
  );
  return new;
end;
$$;

drop trigger if exists trg_price_master_normalize_flags on public.price_master;
create trigger trg_price_master_normalize_flags
before insert or update on public.price_master
for each row execute function public.price_master_normalize_flags();

-- =========================================================
-- 4) KEEP V6.3 MONTH-TO-MONTH G/L/U/N + PRICE/STATUS LOGIC
-- =========================================================
alter table public.monthly_prices
  add column if not exists flags_manual boolean not null default false;

create or replace function public.monthly_prices_calculate()
returns trigger
language plpgsql
set search_path=public,auth
as $$
begin
  if pg_trigger_depth() <= 1 then
    new.updated_at:=now();
    if auth.uid() is not null then
      new.updated_by:=auth.uid();
      new.updated_by_email:=coalesce(auth.jwt()->>'email',auth.uid()::text);
    end if;
  end if;

  if new.flag_n then
    new.flag_g:=false; new.flag_l:=false; new.flag_u:=false;
  end if;

  new.link_mode:=coalesce(nullif(upper(trim(new.link_mode)),''),'N');
  if new.link_mode not in ('N','1','2','3') then
    raise exception 'Invalid Link mode: %',new.link_mode;
  end if;

  if new.link_mode='N' then
    new.compare_price:=new.prev_price;
  elsif new.link_mode in ('1','2') then
    new.compare_price:=new.current_price;
  end if;

  if new.current_price is not null and new.compare_price is not null and new.compare_price>0 then
    new.rel:=round((new.current_price/new.compare_price)*100,5);
  else
    new.rel:=null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_monthly_prices_calculate on public.monthly_prices;
create trigger trg_monthly_prices_calculate
before insert or update on public.monthly_prices
for each row execute function public.monthly_prices_calculate();

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
  if new.month=12 then v_next_year:=new.year_be+1; v_next_month:=1;
  else v_next_year:=new.year_be; v_next_month:=new.month+1;
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

drop trigger if exists trg_monthly_prices_sync_next on public.monthly_prices;
create trigger trg_monthly_prices_sync_next
after insert or update of current_price,reviewer_status,flag_g,flag_l,flag_u,flag_n
on public.monthly_prices
for each row execute function public.monthly_prices_sync_next();

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
  if p_month=1 then v_prev_year:=p_year_be-1; v_prev_month:=12;
  else v_prev_year:=p_year_be; v_prev_month:=p_month-1;
  end if;

  insert into public.monthly_prices(
    master_id,year_be,month,prev_price,current_price,link_mode,compare_price,
    flag_g,flag_l,flag_u,flag_n,flags_manual,
    product_status,reviewer_status,updated_by,updated_by_email
  )
  select
    m.id,p_year_be,p_month,
    p.current_price,null,'N',p.current_price,
    case when coalesce(p.flag_n,m.flag_n) then false when p.id is not null then p.flag_g else m.flag_g end,
    case when coalesce(p.flag_n,m.flag_n) then false when p.id is not null then p.flag_l else m.flag_l end,
    case when coalesce(p.flag_n,m.flag_n) then false when p.id is not null then p.flag_u else m.flag_u end,
    case when p.id is not null then p.flag_n else m.flag_n end,
    false,
    coalesce(p.reviewer_status,''),'',
    auth.uid(),coalesce(auth.jwt()->>'email',auth.uid()::text,'')
  from public.price_master m
  left join public.monthly_prices p
    on p.master_id=m.id and p.year_be=v_prev_year and p.month=v_prev_month
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

grant execute on function public.prepare_month(integer,integer) to authenticated;

commit;
