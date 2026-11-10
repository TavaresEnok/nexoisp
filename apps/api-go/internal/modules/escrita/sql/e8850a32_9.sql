with last as (select device_id, max(taken_at) as taken_at from config_backups group by device_id)
select d.id, d.name, d.config_backup_error as error, l.taken_at
from devices d left join last l on l.device_id = d.id
where d.config_backup and d.agent_id is not null and d.driver = any($1)
  and ((d.config_backup_error_at is not null and (l.taken_at is null or d.config_backup_error_at > l.taken_at))
       or (l.taken_at is null and d.created_at < now() - interval '1 day')
       or l.taken_at < now() - interval '8 days')
order by d.name
