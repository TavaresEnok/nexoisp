select r.*, tp.body from notice_rules r join notice_templates tp on tp.id = r.template_id join notice_channels ch on ch.id = r.channel_id
       where r.active and tp.active and ch.active