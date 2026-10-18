update notice_log l set status = 'sending', claimed_at = now()
       where l.id = (select id from notice_log where tenant_id = $1 and status = 'queued' order by id limit 1 for update skip locked)
       returning l.id, l.contact_value, l.message,
         (select row_to_json(ch) from notice_channels ch where ch.id = l.channel_id and ch.active) as channel