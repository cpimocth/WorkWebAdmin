-- CPI Price Web V6.5 - ROW ACTIONS / ADD / DUPLICATE / REMOVE
-- SAFE UPGRADE FROM V6.4: keeps historical data.
-- Adds permission + RPC to remove an item from the selected month onward.

begin;

-- Monthly rows may be removed by authenticated users under RLS.
grant delete on table public.monthly_prices to authenticated;

drop policy if exists monthly_prices_authenticated_delete on public.monthly_prices;
create policy monthly_prices_authenticated_delete
  on public.monthly_prices for delete to authenticated using (true);

-- Deactivate a master item and remove monthly rows from the selected period onward.
-- Historical rows before the selected period are preserved.
create or replace function public.deactivate_price_item(
  p_master_id bigint,
  p_year_be integer,
  p_month integer
)
returns integer
language plpgsql
security invoker
set search_path=public
as $$
declare
  v_deleted integer := 0;
begin
  if p_year_be < 2500 or p_year_be > 3000 or p_month < 1 or p_month > 12 then
    raise exception 'Invalid Buddhist year/month';
  end if;

  update public.price_master
     set is_active=false,
         updated_at=now()
   where id=p_master_id;

  if not found then
    raise exception 'price_master id % not found', p_master_id;
  end if;

  delete from public.monthly_prices
   where master_id=p_master_id
     and (year_be > p_year_be or (year_be=p_year_be and month >= p_month));

  get diagnostics v_deleted=row_count;
  return v_deleted;
end;
$$;

grant execute on function public.deactivate_price_item(bigint,integer,integer) to authenticated;

commit;
