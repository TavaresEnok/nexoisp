-- name: ListSubscribersUnpaged :many
select s.*, (select count(*) from contracts c where c.subscriber_id = s.id and c.status = 'active') as active_contracts,
       (select string_agg(distinct p.name, ' + ' order by p.name) from contracts c join plan_versions pv on pv.id = c.plan_version_id join plans p on p.id = pv.plan_id where c.subscriber_id = s.id and c.status = 'active') as active_plan_names,
       (select sum(pv.price_cents) from contracts c join plan_versions pv on pv.id = c.plan_version_id where c.subscriber_id = s.id and c.status = 'active') as active_base_cents
         from subscribers s
         where ($1::text is null or s.name ilike '%'||$1||'%' or s.email ilike '%'||$1||'%' or ($2 <> '' and (s.document like '%'||$2||'%' or s.phone like '%'||$2||'%')))
           and ($3::text is null or s.status = $3)
         order by s.name, s.id;
