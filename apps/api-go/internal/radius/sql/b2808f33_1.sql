delete from notice_log where ctid in (select ctid from notice_log where tenant_id = $1 and status in ('sent','failed','skipped_no_consent','skipped_settled','uncertain','test')
                   and created_at < now() - make_interval(days => $2::int) limit $3)
