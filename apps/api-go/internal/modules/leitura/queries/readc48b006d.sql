-- name: Readc48b006d :many
select r.id as referrer_id, r.name as referrer_name, count(*)::int as referred,
                count(*) filter (where k.status = 'active')::int as active
         from contracts k join subscribers r on r.id = k.referred_by_subscriber_id group by r.id, r.name order by 3 desc, 2 limit 200;
