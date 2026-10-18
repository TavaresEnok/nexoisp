-- name: Group91a4cc441 :many
select description, amount_cents from invoice_items where invoice_id = $1 order by id;
