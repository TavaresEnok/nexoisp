-- name: Read010e5cb3 :many
select l.id, l.created_at, l.status, l.attempts, l.error, l.contact_value, coalesce(r.name, case l.phase when 'start' then 'Aviso: ' when 'resolved' then 'Normalizado: ' end || m.title) as rule_name, s.name as subscriber_name, l.contract_id
         from notice_log l left join notice_rules r on r.id = l.rule_id left join subscribers s on s.id = l.subscriber_id left join maintenance_notices m on m.id = l.maintenance_notice_id order by l.id desc limit $1;
