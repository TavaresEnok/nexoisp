-- name: Groupcfbe52020 :many

  select l.*, p.name as plan_name, o.name as owner_name, s.name as subscriber_name
  from leads l left join plans p on p.id = l.plan_id left join users o on o.id = l.owner_id left join subscribers s on s.id = l.subscriber_id where ($1::text is null or (case when $1 = 'open' then l.stage in ('new','contacted','proposal') else l.stage = $1 end))
           and ($2::text is null or l.name ilike '%'||$2||'%' or l.phone like '%'||$2||'%' or l.email ilike '%'||$2||'%')
         order by l.updated_at desc, l.id;
