-- Dados exclusivos do laboratório: contas financeiras, agenda e três conexões RADIUS.
\set ON_ERROR_STOP 1
do $$ begin if current_database() <> 'nexo_contrato_lab' then raise exception 'banco recusado'; end if; end $$;
begin;
create temporary table dyn_subjects on commit drop as
 select t.id tenant_id, row_number() over(order by t.id)::int n,
 (select id from subscribers where tenant_id=t.id order by id limit 1) subscriber_id,
 (select id from users where tenant_id=t.id and name='admin' and email like '%@contrato.invalid' limit 1) user_id
 from tenants t where slug like 'bench-%';
alter table dyn_subjects add column contract_id uuid;
update dyn_subjects s set contract_id=(select id from contracts where subscriber_id=s.subscriber_id order by id limit 1);
insert into invoices(id,tenant_id,contract_id,subscriber_id,kind,due_date,amount_cents,status)
 select md5(s.tenant_id::text||':dyn-invoice:'||state)::uuid,tenant_id,contract_id,subscriber_id,'manual','2020-01-01',123456,state
 from dyn_subjects s cross join unnest(array['open','paid','reconciling','canceled']) state on conflict(id) do nothing;
insert into invoice_items(tenant_id,invoice_id,description,amount_cents)
 select i.tenant_id,i.id,'fixture dinâmica',i.amount_cents from invoices i join dyn_subjects s on s.tenant_id=i.tenant_id
 where i.id in(select md5(s.tenant_id::text||':dyn-invoice:'||state)::uuid from unnest(array['open','paid','reconciling','canceled'])state)
 and not exists(select 1 from invoice_items it where it.invoice_id=i.id);
insert into work_orders(id,tenant_id,number,kind,subscriber_id,contract_id,description,status,assignee_id,scheduled_for,estimated_minutes)
 select md5(s.tenant_id::text||':dyn-work:'||slot)::uuid,tenant_id,9100000+slot,'repair',subscriber_id,contract_id,'Agenda dinâmica','scheduled',user_id,
 '2026-10-16 12:00:00Z'::timestamptz+(slot-1)*interval '30 minutes',60
 from dyn_subjects s cross join generate_series(1,2)slot on conflict(id) do nothing;
insert into ip_pools(id,tenant_id,name,cidr,kind)
 select md5(s.tenant_id::text||':dyn-pool:'||kind)::uuid,tenant_id,'fixture dinâmica '||kind,
 case when kind='public' then '198.51.100.0/30'::cidr else '100.64.0.0/24'::cidr end,kind
 from dyn_subjects s cross join unnest(array['public','cgnat'])kind on conflict(id) do nothing;
insert into cgnat_plans(id,tenant_id,name,public_pool_id,private_pool_id,public_cidr,private_cidr,ports_per_subscriber,port_start)
 select md5(s.tenant_id::text||':dyn-cgnat')::uuid,tenant_id,'fixture dinâmica',md5(s.tenant_id::text||':dyn-pool:public')::uuid,
 md5(s.tenant_id::text||':dyn-pool:cgnat')::uuid,'198.51.100.0/30','100.64.0.0/24',1024,1024 from dyn_subjects s on conflict(id) do nothing;
insert into agents(id,tenant_id,name,token_hash,internal)
 select md5(s.tenant_id::text||':dyn-agent')::uuid,tenant_id,'fixture dinâmica',md5(s.tenant_id::text||':dyn-token'),true from dyn_subjects s on conflict(id) do nothing;
insert into devices(id,tenant_id,name,driver,vendor,agent_id)
 select md5(s.tenant_id::text||':dyn-device:'||vendor||':'||conn)::uuid,tenant_id,'fixture '||vendor||' '||conn,'radius',vendor,md5(s.tenant_id::text||':dyn-agent')::uuid
 from dyn_subjects s cross join unnest(array['mikrotik','huawei','cisco','generic'])vendor cross join unnest(array['direct','vpn','l2tp'])conn on conflict(id) do nothing;
insert into radius_nas(device_id,tenant_id,nas_ip,secret)
 select d.id,d.tenant_id,('192.0.2.0'::inet + row_number() over(order by d.id)), 'segredo-descartavel-local'
 from devices d where d.name like 'fixture %' and d.driver='radius' on conflict(device_id) do nothing;
insert into vpn_peers(device_id,tenant_id,tunnel_ip,public_key)
 select d.id,d.tenant_id,('10.250.1.0'::inet+row_number() over(order by d.id)),encode(digest(d.id::text,'sha256'),'base64')
 from devices d where d.name like 'fixture % vpn' on conflict(device_id) do nothing;
insert into l2tp_peers(device_id,tenant_id,username,secret_enc,tunnel_ip)
 select d.id,d.tenant_id,'nx-'||substr(replace(d.id::text,'-',''),1,12),'\x1234'::bytea,('10.251.1.0'::inet+row_number() over(order by d.id))
 from devices d where d.name like 'fixture % l2tp' on conflict(device_id) do nothing;
insert into service_resources(id,tenant_id,contract_id,device_id,pppoe_username,desired_profile,created_at,observed_policy,observed_at)
 select md5(s.tenant_id::text||':dyn-resource')::uuid,s.tenant_id,s.contract_id,
 md5(s.tenant_id::text||':dyn-device:mikrotik:direct')::uuid,'dyn-'||s.n,'fixture',now()-interval '15 days','suspended',now()-interval '3 hours'
 from dyn_subjects s on conflict(id) do nothing;
insert into service_sessions(tenant_id,resource_id,session_key,started_at,stopped_at,ip,mac,seconds)
 select tenant_id,md5(s.tenant_id::text||':dyn-resource')::uuid,'fixture-concluida',
 ((now() at time zone 'America/Sao_Paulo')::date-1+time '10:00') at time zone 'America/Sao_Paulo',
 ((now() at time zone 'America/Sao_Paulo')::date-1+time '12:00') at time zone 'America/Sao_Paulo','192.0.2.1','AA:BB:CC:DD:EE:FF',7200
 from dyn_subjects s on conflict(resource_id,session_key) do update set started_at=excluded.started_at,stopped_at=excluded.stopped_at;
commit;
