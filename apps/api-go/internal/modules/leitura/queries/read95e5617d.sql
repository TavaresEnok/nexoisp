-- name: Read95e5617d :many
select k.id, k.name, k.active,
                coalesce(json_agg(json_build_object('item_id', i.id, 'name', i.name, 'unit', i.unit, 'qty', x.qty) order by i.name) filter (where i.id is not null), '[]') as items
         from install_kits k left join install_kit_items x on x.kit_id = k.id left join stock_items i on i.id = x.item_id
         group by k.id order by k.name;
