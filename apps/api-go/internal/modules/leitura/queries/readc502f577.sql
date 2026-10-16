-- name: Readc502f577 :many
select r.id, r.name, r.days_relative, r.plan_id, r.pop_id, r.tag_id, r.hour_from, r.hour_to, r.weekdays, r.min_interval_days, r.active,
                t.name as template_name, ch.name as channel_name,
                (select count(*)::int from notice_log l where l.rule_id = r.id and l.status = 'sent') as sent
         from notice_rules r join notice_templates t on t.id = r.template_id join notice_channels ch on ch.id = r.channel_id order by r.days_relative, r.name;
