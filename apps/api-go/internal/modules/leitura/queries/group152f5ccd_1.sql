-- name: Group152f5ccd1 :many
select e.id, e.gateway, e.event_id, e.type, e.charge_id, e.status, e.note, e.received_at, i.id as invoice_id, s.name as subscriber_name
         from gateway_events e left join invoices i on i.gateway = e.gateway and i.gateway_charge_id = e.charge_id left join subscribers s on s.id = i.subscriber_id
         order by e.id desc limit 100;
