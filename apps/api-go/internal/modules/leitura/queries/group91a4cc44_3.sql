-- name: Group91a4cc443 :many
select e.id,e.event_id,e.type,e.status,e.note,e.received_at from gateway_events e
where e.gateway=$1 and e.charge_id=$2
and e.financial_connection_id is not distinct from (select i.financial_connection_id from invoices i where i.id=$3)
order by e.id;
