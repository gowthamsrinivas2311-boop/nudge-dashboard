create or replace function public.check_and_deduct_inventory(
  p_item_name text,
  p_quantity numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  matched_inventory record;
begin
  if p_item_name is null or btrim(p_item_name) = '' then
    return jsonb_build_object('found', false, 'deducted', false);
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be greater than zero';
  end if;

  select
    ctid as row_id,
    item_name,
    current_stock
  into matched_inventory
  from public.inventory
  where item_name ilike p_item_name
  order by item_name
  limit 1
  for update;

  if not found then
    return jsonb_build_object('found', false, 'deducted', false);
  end if;

  if coalesce(matched_inventory.current_stock, 0) < p_quantity then
    return jsonb_build_object(
      'found', true,
      'deducted', false,
      'itemName', matched_inventory.item_name,
      'available', coalesce(matched_inventory.current_stock, 0)
    );
  end if;

  update public.inventory
  set current_stock = current_stock - p_quantity
  where ctid = matched_inventory.row_id;

  return jsonb_build_object(
    'found', true,
    'deducted', true,
    'itemName', matched_inventory.item_name,
    'available', matched_inventory.current_stock - p_quantity
  );
end;
$$;

grant execute on function public.check_and_deduct_inventory(text, numeric) to anon, authenticated, service_role;
