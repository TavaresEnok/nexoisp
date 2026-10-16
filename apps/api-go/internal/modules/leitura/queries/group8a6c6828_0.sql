-- name: Group8a6c68280 :many

  select t.*, s.name as subscriber_name, a.name as assignee_name,
         (select count(*) from ticket_messages m where m.ticket_id = t.id) as messages,
         (select m.author_kind from ticket_messages m where m.ticket_id = t.id and not m.internal order by m.id desc limit 1) as last_from
  from tickets t join subscribers s on s.id = t.subscriber_id left join users a on a.id = t.assignee_id where t.id = $1;
