-- CPI Price Web V5 - Link N/1/2/3 + automatic previous-price carry-forward
-- SAFE UPGRADE: keeps existing price_master and monthly_prices data.
-- Legacy columns is_checked / confirmed may remain in an old database but V5 no longer uses them.

begin;

-- 0) Ensure monthly G/L/U/N snapshot columns exist (safe even if V4 was not run yet).
alter table public.monthly_prices add column if not exists flag_g boolean;
alter table public.monthly_prices add column if not exists flag_l boolean;
alter table public.monthly_prices add column if not exists flag_u boolean;
alter table public.monthly_prices add column if not exists flag_n boolean;

update public.monthly_prices mp
set flag_g = coalesce(mp.flag_g, m.flag_g),
    flag_l = coalesce(mp.flag_l, m.flag_l),
    flag_u = coalesce(mp.flag_u, m.flag_u),
    flag_n = coalesce(mp.flag_n, m.flag_n)
from public.price_master m
where m.id = mp.master_id
  and (mp.flag_g is null or mp.flag_l is null or mp.flag_u is null or mp.flag_n is null);

update public.monthly_prices
set flag_g=coalesce(flag_g,false),
    flag_l=coalesce(flag_l,false),
    flag_u=coalesce(flag_u,false),
    flag_n=coalesce(flag_n,false)
where flag_g is null or flag_l is null or flag_u is null or flag_n is null;

alter table public.monthly_prices alter column flag_g set default false;
alter table public.monthly_prices alter column flag_l set default false;
alter table public.monthly_prices alter column flag_u set default false;
alter table public.monthly_prices alter column flag_n set default false;
alter table public.monthly_prices alter column flag_g set not null;
alter table public.monthly_prices alter column flag_l set not null;
alter table public.monthly_prices alter column flag_u set not null;
alter table public.monthly_prices alter column flag_n set not null;

-- 1) Add Link mode.
alter table public.monthly_prices add column if not exists link_mode text;
update public.monthly_prices
set link_mode = 'N'
where link_mode is null or upper(trim(link_mode)) not in ('N','1','2','3');
alter table public.monthly_prices alter column link_mode set default 'N';
alter table public.monthly_prices alter column link_mode set not null;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='monthly_prices_link_mode_check'
      AND conrelid='public.monthly_prices'::regclass
  ) THEN
    ALTER TABLE public.monthly_prices
      ADD CONSTRAINT monthly_prices_link_mode_check
      CHECK (link_mode in ('N','1','2','3')) NOT VALID;
    ALTER TABLE public.monthly_prices VALIDATE CONSTRAINT monthly_prices_link_mode_check;
  END IF;
END $$;

-- 2) Calculation rule is enforced again in Supabase, not only in the browser.
--    N   = compare_price = prev_price
--    1/2 = compare_price = current_price
--    3   = compare_price stays user-editable
create or replace function public.monthly_prices_calculate()
returns trigger
language plpgsql
set search_path=public,auth
as $$
begin
  new.updated_at := now();
  if auth.uid() is not null then new.updated_by := auth.uid(); end if;

  new.link_mode := coalesce(nullif(upper(trim(new.link_mode)),''),'N');
  if new.link_mode not in ('N','1','2','3') then
    raise exception 'Invalid Link mode: %', new.link_mode;
  end if;

  if new.link_mode = 'N' then
    new.compare_price := new.prev_price;
  elsif new.link_mode in ('1','2') then
    new.compare_price := new.current_price;
  end if;

  if new.current_price is not null and new.compare_price is not null and new.compare_price > 0 then
    new.rel := round((new.current_price / new.compare_price) * 100, 5);
  else
    new.rel := null;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_monthly_prices_calculate on public.monthly_prices;
create trigger trg_monthly_prices_calculate
before insert or update on public.monthly_prices
for each row execute function public.monthly_prices_calculate();

-- 3) Whenever a current price changes, push it to next month's prev_price if that month already exists.
create or replace function public.monthly_prices_sync_next_prev()
returns trigger
language plpgsql
security invoker
set search_path=public
as $$
declare
  v_next_year integer;
  v_next_month integer;
begin
  if tg_op = 'UPDATE' and new.current_price is not distinct from old.current_price then
    return new;
  end if;

  if new.month = 12 then
    v_next_year := new.year_be + 1;
    v_next_month := 1;
  else
    v_next_year := new.year_be;
    v_next_month := new.month + 1;
  end if;

  update public.monthly_prices nxt
     set prev_price = new.current_price
   where nxt.master_id = new.master_id
     and nxt.year_be = v_next_year
     and nxt.month = v_next_month;

  return new;
end;
$$;

drop trigger if exists trg_monthly_prices_sync_next_prev on public.monthly_prices;
create trigger trg_monthly_prices_sync_next_prev
after insert or update of current_price on public.monthly_prices
for each row execute function public.monthly_prices_sync_next_prev();

-- 4) Prepare / refresh a month.
--    For new rows: previous month's current_price becomes prev_price and compare_price (Link N).
--    For an already-prepared month: refresh prev_price from the previous month instead of DO NOTHING.
create or replace function public.prepare_month(p_year_be integer, p_month integer)
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

  insert into public.monthly_prices(
    master_id, year_be, month,
    prev_price, current_price, link_mode, compare_price,
    flag_g, flag_l, flag_u, flag_n,
    updated_by
  )
  select
    m.id, p_year_be, p_month,
    p.current_price, null, 'N', p.current_price,
    m.flag_g, m.flag_l, m.flag_u, m.flag_n,
    auth.uid()
  from public.price_master m
  left join public.monthly_prices p
    on p.master_id=m.id
   and p.year_be=v_prev_year
   and p.month=v_prev_month
  where m.is_active=true
  on conflict (master_id,year_be,month) do update
     set prev_price = coalesce(excluded.prev_price, public.monthly_prices.prev_price),
         updated_by = auth.uid();

  get diagnostics v_affected = row_count;
  return v_affected;
end;
$$;

grant execute on function public.prepare_month(integer,integer) to authenticated;

commit;
