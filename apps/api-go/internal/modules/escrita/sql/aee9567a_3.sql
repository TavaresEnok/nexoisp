with afetados as (
           select distinct k.subscriber_id from contracts k
           where k.status = 'active' and ($2::uuid is null or exists (select 1 from service_resources r where r.contract_id = k.id and r.device_id = $2))),
         contato as (
           select a.subscriber_id, s.name,
                  (select value from subscriber_contacts x where x.subscriber_id = a.subscriber_id and x.allow_notices and x.kind in ('mobile','whatsapp')
                   order by (x.purpose = 'technical') desc, x.created_at limit 1) as value
           from afetados a join subscribers s on s.id = a.subscriber_id where s.status = 'active')
         insert into notice_log (tenant_id, subscriber_id, contact_value, status, channel_id, message, maintenance_notice_id, phase)
         select $1, subscriber_id, value, case when value is null then 'skipped_no_consent' else 'queued' end, case when value is null then null else $3::uuid end,
                case when value is null then null else left(replace($4, '{nome}', split_part(name, ' ', 1)), 600) end, $5, $6
         from contato
         on conflict (maintenance_notice_id, subscriber_id, phase) where maintenance_notice_id is not null do nothing
         returning status