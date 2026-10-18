-- name: Group432d4bfb0 :many

  select w.*, s.name as subscriber_name, s.phone as subscriber_phone,
         concat_ws(', ', s.address_street, s.address_number, s.address_district, s.address_city) as subscriber_address,
         a.name as assignee_name, cb.name as created_by_name,
         coalesce(w.address_text, concat_ws(', ', s.address_street, s.address_number, s.address_district, s.address_city)) as service_address,
         r.name as reason_name, (w.sla_due_at is not null and w.sla_breached_at is not null) as sla_breached
  from work_orders w left join catalog_items r on r.id = w.reason_id join subscribers s on s.id = w.subscriber_id left join users a on a.id = w.assignee_id left join users cb on cb.id = w.created_by where w.id = $1;
