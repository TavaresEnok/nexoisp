select t.number, t.subject, t.category, t.status, t.created_at,
                                 (select coalesce(json_agg(json_build_object('at', m.at, 'from', m.author_kind, 'body', m.body) order by m.id), '[]')
                                  from ticket_messages m where m.ticket_id = t.id and not m.internal) as messages
                          from tickets t where t.subscriber_id = $1 order by t.created_at