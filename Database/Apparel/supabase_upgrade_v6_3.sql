-- CPI Price Web V6.3 - G/L/U/N month-to-month inheritance
-- SAFE UPGRADE: keeps all existing data.
-- Run once in Supabase SQL Editor before using index.html V6.3.

begin;

-- 1) Track whether the month's G/L/U/N was explicitly saved/overridden.
alter table public.monthly_prices
  add column if not exists flags_manual boolean not null default false;

-- Existing monthly records are treated as established historical snapshots.
-- This prevents a later edit to an older month from unexpectedly rewriting them.
update public.monthly_prices
set flags_manual = true
where flags_manual = false;

-- 2) Keep calculation, N exclusivity, and audit.
-- Nested propagation to future months should not falsely change "แก้ไขโดย" / "แก้ไขล่าสุด".
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
    new.flag_g:=false;
    new.flag_l:=false;
    new.flag_u:=false;
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

-- 3) Propagate to an already-created next month.
-- Price: current -> next previous price
-- Status: reviewer -> next recorder
-- G/L/U/N: propagate only while next month has NOT been manually overridden.
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

drop trigger if exists trg_monthly_prices_sync_next on public.monthly_prices;
create trigger trg_monthly_prices_sync_next
after insert or update of current_price,reviewer_status,flag_g,flag_l,flag_u,flag_n
on public.monthly_prices
for each row execute function public.monthly_prices_sync_next();

-- 4) Prepare a new month from the IMMEDIATELY PREVIOUS month.
-- If there is no previous-month row for an item, fall back to price_master.
-- Re-running prepare_month never overwrites a month whose G/L/U/N was manually saved.
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

grant execute on function public.prepare_month(integer,integer) to authenticated;

commit;
