-- name: Group91a4cc442 :many
select p.id, p.amount_cents, p.signed_cents, p.kind, p.reversal_of, p.paid_at, p.method, p.source, p.gateway_payment_id, p.note, u.name as created_by_name
         from payments p left join users u on u.id = p.created_by where p.invoice_id = $1 order by p.created_at;
