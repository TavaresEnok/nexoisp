-- Dados adicionais apenas no laboratório de contrato. IDs estáveis permitem reexecução.
\set ON_ERROR_STOP 1
do $$ begin if current_database() <> 'nexo_contrato_lab' then raise exception 'banco recusado'; end if; end $$;
begin;
create temporary table reading_subjects on commit drop as
 select s.id, s.tenant_id, row_number() over(partition by s.tenant_id order by s.id) as n,
        (select k.id from contracts k where k.subscriber_id=s.id order by k.id limit 1) as contract_id
 from subscribers s where s.tenant_id in (select id from tenants where slug like 'bench-%');
delete from reading_subjects where n>2 or contract_id is null;
insert into tickets(id,tenant_id,number,subscriber_id,contract_id,subject,category,origin)
 select md5(id::text||':read-ticket')::uuid,tenant_id,9000000+n,id,contract_id,'Contrato de leitura '||n,'technical','portal' from reading_subjects on conflict(id) do nothing;
insert into ticket_messages(tenant_id,ticket_id,author_kind,body,internal)
 select s.tenant_id,md5(s.id::text||':read-ticket')::uuid,'staff','fixture leitura '||p,p='interna'
 from reading_subjects s cross join unnest(array['pública','interna']) p
 where not exists(select 1 from ticket_messages m where m.ticket_id=md5(s.id::text||':read-ticket')::uuid and m.body='fixture leitura '||p);
insert into acceptances(id,tenant_id,contract_id,subscriber_id,title,body,body_hash,status,canceled_at)
 select md5(s.id::text||':read-acceptance:'||state)::uuid,s.tenant_id,s.contract_id,s.id,'Documento '||state,'Texto de teste',encode(digest('Texto de teste','sha256'),'hex'),state,case when state='canceled' then now() end
 from reading_subjects s cross join unnest(array['pending','canceled']) state on conflict(id) do nothing;
insert into work_orders(id,tenant_id,number,kind,subscriber_id,contract_id,description)
 select md5(id::text||':read-work')::uuid,tenant_id,9000000+n,'repair',id,contract_id,'Contrato de leitura' from reading_subjects on conflict(id) do nothing;
insert into satisfaction_surveys(id,tenant_id,work_order_id,work_order_number,kind,subscriber_id)
 select md5(id::text||':read-survey')::uuid,tenant_id,md5(id::text||':read-work')::uuid,9000000+n,'repair',id from reading_subjects on conflict(id) do update set expires_at=now()+interval '30 days';
insert into usage_daily(tenant_id,resource_id,day,bytes_in,bytes_out)
 select r.tenant_id,r.id,current_date,12345,67890 from service_resources r join reading_subjects s on s.contract_id=r.contract_id
 on conflict(resource_id,day) do update set bytes_in=12345,bytes_out=67890;
commit;
