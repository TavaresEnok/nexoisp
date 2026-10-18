-- name: Reada1bf9e6c :many
select x.*, (x.active and x.balance < x.min_qty) as low,
        (select count(*) from stock_units u where u.item_id = x.id and u.status = 'with_tech')::int as with_tech from (
  select i.*, coalesce((select sum(m.qty) from stock_movements m where m.item_id = i.id), 0)::int as balance
  from stock_items i) x order by x.active desc, x.name;
