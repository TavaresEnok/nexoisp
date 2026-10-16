-- name: ListSubscribersUnpaged :many
select s.*, (select count(*) from contracts c where c.subscriber_id = s.id and c.status = 'active') as active_contracts
         from subscribers s
         where ($1::text is null or s.name ilike '%'||$1||'%' or s.email ilike '%'||$1||'%' or ($2 <> '' and (s.document like '%'||$2||'%' or s.phone like '%'||$2||'%')))
           and ($3::text is null or s.status = $3)
         order by s.name, s.id;
