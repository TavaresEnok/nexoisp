-- name: Group8a6c68281 :many
select m.id, m.at, m.author_kind, m.body, m.internal, u.name as author_name from ticket_messages m left join users u on u.id = m.author_id where m.ticket_id = $1 order by m.id;
