-- name: Ticket1 :many
select m.id, m.at, m.author_kind, m.body from ticket_messages m where m.ticket_id = $1 and not m.internal order by m.id;
