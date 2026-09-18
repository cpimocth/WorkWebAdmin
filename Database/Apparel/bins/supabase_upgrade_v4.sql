-- CPI Price Web V4: G/L/U/N editable per month
-- Safe upgrade: does NOT delete existing price_master or monthly_prices rows.

begin;

-- 1) Add monthly snapshot flags. Initially nullable so existing rows can be backfilled from Master.
alter table public.monthly_prices add column if not exists flag_g boolean;
alter table public.monthly_prices add column if not exists flag_l boolean;
alter table public.monthly_prices add column if not exists flag_u boolean;
alter table public.monthly_prices add column if not exists flag_n boolean;

-- 2) Existing monthly rows inherit their current Master values one time.
update public.monthly_prices mp
set flag_g = coalesce(mp.flag_g, m.flag_g),
    flag_l = coalesce(mp.flag_l, m.flag_l),
    flag_u = coalesce(mp.flag_u, m.flag_u),
    flag_n = coalesce(mp.flag_n, m.flag_n)
from public.price_master m
where m.id = mp.master_id
  and (mp.flag_g is null or mp.flag_l is null or mp.flag_u is null or mp.flag_n is null);

update public.monthly_prices
set flag_g = coalesce(flag_g,false),
    flag_l = coalesce(flag_l,false),
    flag_u = coalesce(flag_u,false),
    flag_n = coalesce(flag_n,false)
where flag_g is null or flag_l is null or flag_u is null or flag_n is null;

alter table public.monthly_prices alter column flag_g set default false;
alter table public.monthly_prices alter column flag_l set default false;
alter table public.monthly_prices alter column flag_u set default false;
alter table public.monthly_prices alter column flag_n set default false;
alter table public.monthly_prices alter column flag_g set not null;
alter table public.monthly_prices alter column flag_l set not null;
alter table public.monthly_prices alter column flag_u set not null;
alter table public.monthly_prices alter column flag_n set not null;

-- 3) Recreate prepare_month so a new month starts with G/L/U/N from Master.
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

  insert into public.monthly_prices(
    master_id, year_be, month,
    prev_price, compare_price,
    flag_g, flag_l, flag_u, flag_n,
    is_checked, updated_by
  )
  select
    m.id, p_year_be, p_month,
    p.current_price, p.current_price,
    m.flag_g, m.flag_l, m.flag_u, m.flag_n,
    (m.flag_g or m.flag_l or m.flag_u),
    auth.uid()
  from public.price_master m
  left join public.monthly_prices p
    on p.master_id=m.id
   and p.year_be=v_prev_year
   and p.month=v_prev_month
  where m.is_active=true
  on conflict (master_id,year_be,month) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

grant execute on function public.prepare_month(integer,integer) to authenticated;

commit;
