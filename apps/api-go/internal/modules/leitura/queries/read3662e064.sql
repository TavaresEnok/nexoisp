-- name: Read3662e064 :many

  select x.id, x.box_id, x.port, x.contract_id, x.note, x.created_at, b.name as box_name, b.kind as box_kind, b.pon_port, b.device_id, d.name as device_name,
         s.id as subscriber_id, s.name as subscriber_name
  from ftth_drops x join ftth_boxes b on b.id = x.box_id left join devices d on d.id = b.device_id
  left join contracts k on k.id = x.contract_id left join subscribers s on s.id = k.subscriber_id where x.contract_id = $1;
