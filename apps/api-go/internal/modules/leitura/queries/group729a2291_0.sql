-- name: Group729a22910 :many

  select t.*, s.name as subscriber_name, a.name as assignee_name,
         (select count(*) from ticket_messages m where m.ticket_id = t.id) as messages,
         (select m.author_kind from ticket_messages m where m.ticket_id = t.id and not m.internal order by m.id desc limit 1) as last_from
  from tickets t join subscribers s on s.id = t.subscriber_id left join users a on a.id = t.assignee_id where ($1::text is null or (case when $1 = 'pending' then t.status <> 'closed' else t.status = $1 end))
           and ($2::text is null or s.name ilike '%'||$2||'%' or t.subject ilike '%'||$2||'%' or t.number::text = $2)
           and ($3::uuid is null or t.subscriber_id = $3) and ($4::uuid is null or t.assignee_id = $4)
         order by (t.status = 'closed'), t.updated_at desc, t.id;
