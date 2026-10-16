select w.id, w.number, w.kind, w.status, w.scheduled_for, w.estimated_minutes, w.assignee_id, a.name as assignee_name, s.name as subscriber_name,
                coalesce(w.address_text, concat_ws(', ', s.address_street, s.address_number, s.address_district, s.address_city)) as address,
                (w.sla_due_at is not null and w.sla_due_at < now()) as sla_overdue
         from work_orders w join subscribers s on s.id = w.subscriber_id left join users a on a.id = w.assignee_id
         where w.status in ('open','analysis','awaiting_schedule','scheduled','en_route','in_progress') and w.scheduled_for >= ($1::date)::timestamp at time zone $2
           and w.scheduled_for < (($1::date + $3::int))::timestamp at time zone $2 and ($4::uuid is null or w.assignee_id = $4)
         order by a.name nulls last, w.scheduled_for