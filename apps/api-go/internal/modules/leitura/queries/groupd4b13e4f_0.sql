-- name: Groupd4b13e4f0 :many

  select w.*, s.name as subscriber_name, s.phone as subscriber_phone,
         concat_ws(', ', s.address_street, s.address_number, s.address_district, s.address_city) as subscriber_address,
         a.name as assignee_name, cb.name as created_by_name,
         coalesce(w.address_text, concat_ws(', ', s.address_street, s.address_number, s.address_district, s.address_city)) as service_address,
         r.name as reason_name, (w.sla_due_at is not null and w.sla_breached_at is not null) as sla_breached
  from work_orders w left join catalog_items r on r.id = w.reason_id join subscribers s on s.id = w.subscriber_id left join users a on a.id = w.assignee_id left join users cb on cb.id = w.created_by
         where ($1::text is null or (case when $1 = 'pending' then w.status in ('open','analysis','awaiting_schedule','scheduled','en_route','in_progress') else w.status = $1 end))
           and ($2::text is null or s.name ilike '%'||$2||'%' or w.description ilike '%'||$2||'%' or w.number::text = $2)
           and ($3::uuid is null or w.assignee_id = $3) and ($4::uuid is null or w.subscriber_id = $4) and ($5::uuid is null or w.contract_id = $5)
         order by (w.status in ('done','canceled')), w.scheduled_for nulls last, w.created_at desc, w.id;
