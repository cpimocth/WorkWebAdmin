-- CPI Price Web V6 - status carry-forward, N exclusivity, editor audit
-- SAFE UPGRADE: keeps existing data. Run once in Supabase SQL Editor.

begin;

-- 1) New reviewer status and human-readable editor identity.
alter table public.monthly_prices add column if not exists product_status text not null default '';
alter table public.monthly_prices add column if not exists reviewer_remark text not null default '';
alter table public.monthly_prices add column if not exists updated_by uuid;
alter table public.monthly_prices add column if not exists reviewer_status text;
alter table public.monthly_prices add column if not exists updated_by_email text;

update public.monthly_prices
set reviewer_status = coalesce(nullif(reviewer_status,''), coalesce(reviewer_remark,''))
where coalesce(reviewer_status,'')='';

update public.monthly_prices set reviewer_status='' where reviewer_status is null;
update public.monthly_prices set updated_by_email='' where updated_by_email is null;
alter table public.monthly_prices alter column reviewer_status set default '';
alter table public.monthly_prices alter column reviewer_status set not null;
alter table public.monthly_prices alter column updated_by_email set default '';
alter table public.monthly_prices alter column updated_by_email set not null;

-- 2) Enforce N as exclusive. Existing N rows are normalized now.
update public.price_master set flag_g=false,flag_l=false,flag_u=false where flag_n=true;
update public.monthly_prices set flag_g=false,flag_l=false,flag_u=false where flag_n=true;

create or replace function public.price_master_normalize_flags()
returns trigger language plpgsql set search_path=public as $$
begin
  new.updated_at:=now();
  if new.flag_n then new.flag_g:=false; new.flag_l:=false; new.flag_u:=false; end if;
  return new;
end; $$;
drop trigger if exists trg_price_master_touch on public.price_master;
drop trigger if exists trg_price_master_normalize_flags on public.price_master;
create trigger trg_price_master_normalize_flags before insert or update on public.price_master
for each row execute function public.price_master_normalize_flags();

-- 3) Price calculation + editor audit + N normalization.
create or replace function public.monthly_prices_calculate()
returns trigger
language plpgsql
set search_path=public,auth
as $$
begin
  new.updated_at:=now();
  if auth.uid() is not null then
    new.updated_by:=auth.uid();
    new.updated_by_email:=coalesce(auth.jwt()->>'email',auth.uid()::text);
  end if;

  if new.flag_n then new.flag_g:=false; new.flag_l:=false; new.flag_u:=false; end if;

  new.link_mode:=coalesce(nullif(upper(trim(new.link_mode)),''),'N');
  if new.link_mode not in ('N','1','2','3') then raise exception 'Invalid Link mode: %',new.link_mode; end if;
  if new.link_mode='N' then new.compare_price:=new.prev_price;
  elsif new.link_mode in ('1','2') then new.compare_price:=new.current_price;
  end if;

  if new.current_price is not null and new.compare_price is not null and new.compare_price>0 then
    new.rel:=round((new.current_price/new.compare_price)*100,5);
  else new.rel:=null;
  end if;
  return new;
end; $$;

drop trigger if exists trg_monthly_prices_calculate on public.monthly_prices;
create trigger trg_monthly_prices_calculate before insert or update on public.monthly_prices
for each row execute function public.monthly_prices_calculate();

-- 4) Keep next month synchronized at all times:
--    current price -> next month's previous price
--    reviewer status -> next month's recorder status
create or replace function public.monthly_prices_sync_next()
returns trigger
language plpgsql
security invoker
set search_path=public
as $$
declare v_next_year integer; v_next_month integer;
begin
  if new.month=12 then v_next_year:=new.year_be+1; v_next_month:=1;
  else v_next_year:=new.year_be; v_next_month:=new.month+1; end if;

  update public.monthly_prices nxt
     set prev_price=new.current_price,
         product_status=coalesce(new.reviewer_status,'')
   where nxt.master_id=new.master_id
     and nxt.year_be=v_next_year
     and nxt.month=v_next_month;
  return new;
end; $$;

drop trigger if exists trg_monthly_prices_sync_next_prev on public.monthly_prices;
drop trigger if exists trg_monthly_prices_sync_next on public.monthly_prices;
create trigger trg_monthly_prices_sync_next
after insert or update of current_price,reviewer_status on public.monthly_prices
for each row execute function public.monthly_prices_sync_next();

-- 5) Prepare or refresh a month from the immediately previous month.
create or replace function public.prepare_month(p_year_be integer,p_month integer)
returns integer
language plpgsql
security invoker
set search_path=public,auth
as $$
declare v_prev_year integer; v_prev_month integer; v_affected integer;
begin
  if p_year_be<2500 or p_year_be>3000 or p_month<1 or p_month>12 then raise exception 'Invalid Buddhist year/month'; end if;
  if p_month=1 then v_prev_year:=p_year_be-1; v_prev_month:=12;
  else v_prev_year:=p_year_be; v_prev_month:=p_month-1; end if;

  insert into public.monthly_prices(
    master_id,year_be,month,prev_price,current_price,link_mode,compare_price,
    flag_g,flag_l,flag_u,flag_n,product_status,reviewer_status,updated_by,updated_by_email
  )
  select m.id,p_year_be,p_month,p.current_price,null,'N',p.current_price,
         case when m.flag_n then false else m.flag_g end,
         case when m.flag_n then false else m.flag_l end,
         case when m.flag_n then false else m.flag_u end,
         m.flag_n,
         coalesce(p.reviewer_status,''),'',auth.uid(),coalesce(auth.jwt()->>'email',auth.uid()::text,'')
  from public.price_master m
  left join public.monthly_prices p
    on p.master_id=m.id and p.year_be=v_prev_year and p.month=v_prev_month
  where m.is_active=true
  on conflict (master_id,year_be,month) do update
     set prev_price=excluded.prev_price,
         product_status=excluded.product_status,
         updated_by=auth.uid(),
         updated_by_email=coalesce(auth.jwt()->>'email',auth.uid()::text,public.monthly_prices.updated_by_email);

  get diagnostics v_affected=row_count;
  return v_affected;
end; $$;

grant execute on function public.prepare_month(integer,integer) to authenticated;

commit;
