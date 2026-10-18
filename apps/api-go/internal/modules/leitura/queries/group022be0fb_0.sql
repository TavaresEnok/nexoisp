-- name: Group022be0fb0 :many

  select b.*, d.name as device_name, p.name as parent_name,
         (select count(*) from ftth_drops x where x.box_id = b.id) as used,
         (select count(*) from ftth_boxes x where x.parent_id = b.id) as children
  from ftth_boxes b left join devices d on d.id = b.device_id left join ftth_boxes p on p.id = b.parent_id where b.id = $1;
